import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const validThread = /^[a-zA-Z0-9-]{16,100}\.lock$/;

export async function lockOwners(files, platform = process.platform) {
  if (!files.length) return [];
  if (platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayLockOwner {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
  public UniqueProcess process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
  public uint type; public uint status; public uint session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint count, string[] files, uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] Info[] info, ref uint reason);
 public static uint[] Read(string file) {
  uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString("N")) != 0) return new uint[0];
  try {
   if (RmRegisterResources(h, 1, new string[]{file}, 0, null, 0, null) != 0) return new uint[0];
   uint needed=0,count=0,reason=0;
   int code=RmGetList(h,out needed,ref count,null,ref reason);
   if (code==0) return new uint[0];
   if (code!=234 || needed>512) return new uint[0];
   var info=new Info[needed]; count=needed;
   if(RmGetList(h,out needed,ref count,info,ref reason)!=0) return new uint[0];
   var pids=new uint[count];for(int i=0;i<count;i++)pids[i]=info[i].process.pid;return pids;
  } finally { RmEndSession(h); }
 }
}
'@
$rows = foreach ($file in ($env:RELAY_DISCOVERY_LOCKS | ConvertFrom-Json)) {
 foreach ($owner in [RelayLockOwner]::Read($file)) { [pscustomobject]@{file=$file;pid=[int]$owner} }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const {stdout} = await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: {...process.env, RELAY_DISCOVERY_LOCKS: JSON.stringify(files)}, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  }
  const {stdout} = await exec('/usr/sbin/lsof', ['-Fpn', '--', ...files], {timeout: 10000, maxBuffer: 1024 * 1024})
    .catch(error => {if (error.code === 1 && error.stdout === '') return {stdout: ''}; throw error;});
  const rows = []; let pid;
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid && files.includes(line.slice(1))) rows.push({pid, file: line.slice(1)});
  }
  return rows;
}

export async function readCodexLive(profiles, processes, {owners = lockOwners, metadata = readThreadMetadata} = {}) {
  const byFile = new Map();
  for (const profile of profiles) {
    const dir = path.join(profile.home, 'thread-writer-locks');
    try {
      for (const f of fs.readdirSync(dir, {withFileTypes: true}).filter(f => f.isFile() && validThread.test(f.name)).slice(0, 256)) {
        byFile.set(path.join(dir, f.name), {...profile, nativeId: f.name.slice(0, -5)});
      }
    } catch (e) {if (e.code !== 'ENOENT') throw e;}
  }
  const live = await owners([...byFile.keys()]);
  const pids = new Map(processes.filter(p => p.provider === 'codex').map(p => [p.pid, p]));
  const result = [];
  for (const owner of live) {
    const profile = byFile.get(owner.file);
    if (!profile || !pids.has(owner.pid)) continue;
    const info = await metadata(profile.home, profile.nativeId);
    if(info?.internal)continue;
    result.push({...profile, pid: owner.pid, name: info?.name || info?.title || 'Codex ' + profile.nativeId.slice(0, 8),
      cwd: (info?.cwd || '').replace(/^\\\\\?\\/,''), status: 'open', statusUpdatedAt: null});
  }
  return result;
}

export async function readThreadMetadata(home, id) {
  const candidates = fs.readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!candidates.length) return null;
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, candidates[0]), {readOnly: true});
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
    const fields = ['id', 'name', 'title', 'cwd', 'source', 'thread_source', 'model', 'reasoning_effort'].filter(c => columns.has(c));
    if (!fields.includes('id')) return null;
    const select=fields.map(c=>['title','name'].includes(c)?'substr('+c+',1,120) AS '+c:c);
    const row=db.prepare('SELECT ' + select.join(',') + ' FROM threads WHERE id = ?').get(id);
    if(!row)return null;
    let source;try{source=JSON.parse(row.source);}catch{}
    return {...row,internal:!!(source?.internal || source?.subagent || row.thread_source==='guardian_review')};
  } finally {db.close();}
}
