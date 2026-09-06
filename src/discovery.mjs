import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {safeText} from './storage.mjs';
import {readCodexLive} from './codex-discovery.mjs';
import {IdentityCache} from './identity.mjs';

const exec = promisify(execFile);
const text = value => safeText(value).replace(/\s+/g, ' ').slice(0, 500);
const empty = () => ({externalSessions: [], externalProcesses: [], discovery: {checkedAt: Date.now(), error: null}});
const basename = value => String(value || '').split(/[\\/]/).at(-1).toLowerCase();

export function classifyProcess(name, command = '') {
  const exe = basename(name);
  let provider = /^(claude|codex)(?:\.exe)?$/.exec(exe)?.[1];
  if (!provider && /^(node|nodejs)(?:\.exe)?$/.test(exe)) {
    // Match the executable script argument, not arbitrary prompt text later in argv.
    const script = /^\s*(?:"[^"]+"|'[^']+'|\S+)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
    const entry = script && (script[1] || script[2] || script[3]);
    if (entry && /[/\\]@anthropic-ai[/\\]claude-code[/\\](?:cli\.js|bin[/\\]claude(?:\.exe)?)$/i.test(entry)) provider = 'claude';
    if (entry && /[/\\]@openai[/\\]codex[/\\]bin[/\\]codex\.js$/i.test(entry)) provider = 'codex';
  }
  if (!provider) return null;
  // Extract only recognized control flags. Never retain command lines or prompts.
  const mode = /\bapp-server(?:\s|$)/.test(command) ? 'app-server'
    : /--output-format(?:=|\s+)stream-json(?:\s|$)/.test(command) ? 'sdk'
    : /\s(?:auth\s+login|login|--version|--help)(?:\s|$)/.test(command) ? 'utility'
    : /\s(?:mcp|remote-control|bridge)(?:\s|$)/.test(command) ? 'helper' : 'cli';
  return {provider, mode};
}

export function parseUnixProcesses(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedAt: Date.parse(match[4]), name: match[5]});
  }
  return rows;
}

export async function listProcesses() {
  if (process.platform === 'win32') {
    // WMI is used only for process identity and known CLI flags. Raw argv stays in this child.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$relaySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$relayRows = foreach ($p in Get-CimInstance Win32_Process) {
  $provider = $null
  $mode = 'cli'
  if ($p.Name -match '^(claude|codex)\.exe$') { $provider = $Matches[1].ToLowerInvariant() }
  if ($p.Name -match '^node(?:js)?\.exe$' -and $p.CommandLine -match '^\s*(?:"[^"]+"|\S+)\s+"?[^"]*?[\\/]@(anthropic-ai[\\/]claude-code[\\/]cli\.js|openai[\\/]codex[\\/]bin[\\/]codex\.js)(?:"|\s|$)') {
    $provider = if ($Matches[1].StartsWith('anthropic-ai')) { 'claude' } else { 'codex' }
  }
  if ($provider) {
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($owner.Sid -ne $relaySid) { $provider = $null }
  }
  if ($provider) {
    if ($p.CommandLine -match '\bapp-server(?:\s|$)') { $mode = 'app-server' }
    elseif ($p.CommandLine -match '--output-format(?:=|\s+)stream-json(?:\s|$)') { $mode = 'sdk' }
    elseif ($p.CommandLine -match '\s(?:auth\s+login|login|--version|--help)(?:\s|$)') { $mode = 'utility' }
    elseif ($p.CommandLine -match '\s(?:mcp|remote-control|bridge)(?:\s|$)') { $mode = 'helper' }
  }
  [pscustomobject]@{
    pid = [int]$p.ProcessId
    ppid = [int]$p.ParentProcessId
    provider = $provider
    mode = $mode
    startedAt = if ($provider -and $p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { $null }
  }
}
ConvertTo-Json -InputObject @($relayRows) -Compress
`;
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const {stdout} = await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024});
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  }
  const options = {env: {...process.env, LC_ALL: 'C'}, timeout: 10000, maxBuffer: 8 * 1024 * 1024};
  const {stdout} = await exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,comm='], options);
  const rows = parseUnixProcesses(stdout);
  const candidates = rows.filter(p => p.uid === process.getuid() && /^(claude|codex|node|nodejs)$/.test(basename(p.name)));
  if (!candidates.length) return rows;
  const args = await exec('/bin/ps', ['-p', candidates.map(p => p.pid).join(','), '-o', 'pid=,args='], options).catch(() => ({stdout: ''}));
  const commands = new Map(args.stdout.split('\n').map(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [Number(m[1]), m[2]] : [0, ''];
  }));
  for (const p of candidates) Object.assign(p, classifyProcess(p.name, commands.get(p.pid) || '') || {});
  return rows;
}

export function isDescendant(pid, ancestor, processes) {
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    if (pid === ancestor) return true;
    seen.add(pid);
    pid = processes.get(pid)?.ppid;
  }
  return false;
}

export function readClaudeRegistry(home) {
  const dir = path.join(home, 'sessions');
  const records = [];
  try {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).slice(0, 4000)) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        if (fs.statSync(file).size > 32768) continue;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.pid !== Number(entry.name.slice(0, -5))) continue;
        // Deliberate allowlist: socket paths, bridge IDs, keys and other registry fields never leave here.
        records.push({pid: value.pid, sessionId: value.sessionId, cwd: value.cwd, name: value.name,
          kind: value.kind, status: value.status, startedAt: value.startedAt, procStart: value.procStart,
          statusUpdatedAt: value.statusUpdatedAt, updatedAt: value.updatedAt});
      } catch { /* A native process can replace/remove its metadata while we scan. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read the Claude live-session registry.');
  }
  return records;
}

function matchesProcess(record, p, platform) {
  if (!p || p.provider !== 'claude' || !Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(record.sessionId || '')) return false;
  // An old registry entry must not match an unrelated process which reused its PID.
  if (Number.isFinite(p.startedAt)) {
    if (platform === 'win32' && /^\d{16,20}$/.test(record.procStart || '')) {
      const epoch = Number(BigInt(record.procStart) / 10000n - 11644473600000n);
      if (Math.abs(epoch - p.startedAt) > 2000) return false;
    } else if (!Number.isFinite(record.startedAt) || record.startedAt < p.startedAt - 5000) return false;
  }
  return true;
}

export function buildDiscovery({processes, profiles, codexSessions = [], managed = [], daemonPid = process.pid, platform = process.platform, now = Date.now()}) {
  const result = empty();
  result.discovery.checkedAt = now;
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const managedIds = new Set(managed.filter(s => s.nativeId && ['running', 'waiting', 'switching'].includes(s.status)).map(s => s.nativeId));
  const visible = processes.filter(p => p.provider && !['utility', 'helper'].includes(p.mode) && !isDescendant(p.pid, daemonPid, byPid));
  const seen = new Set();
  for (const profile of profiles) for (const record of profile.records) {
    const p = byPid.get(record.pid);
    if (!visible.includes(p) || !matchesProcess(record, p, platform) || seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (managedIds.has(record.sessionId)) continue;
    result.externalSessions.push({
      id: 'native:claude:' + p.pid + ':' + record.sessionId,
      nativeId: record.sessionId, provider: 'claude', pid: p.pid,
      name: text(record.name || 'Claude ' + p.pid), cwd: text(record.cwd || ''),
      accountId: profile.accountId || null, accountName: profile.accountName || 'Native login (unmapped)',
      status: text(record.status || 'unknown'), statusUpdatedAt: Number(record.statusUpdatedAt || record.updatedAt) || null,
      processRunning: true, managed: false, canRoute: false, source: 'Claude live registry'
    });
  }
  for(const s of codexSessions){
    const p=byPid.get(s.pid);
    if(!visible.includes(p) || managedIds.has(s.nativeId))continue;
    seen.add(s.pid);
    result.externalSessions.push({id:'native:codex:'+s.pid+':'+s.nativeId,nativeId:s.nativeId,provider:'codex',pid:s.pid,
      name:text(s.name),cwd:text(s.cwd),accountId:s.accountId || null,accountName:s.accountName || 'Native login (unmapped)',
      status:s.status,statusUpdatedAt:s.statusUpdatedAt,processRunning:true,managed:false,canRoute:false,source:'Codex live writer ownership'});
  }
  for (const p of visible) {
    if (seen.has(p.pid)) continue;
    // A npm launcher and its native child represent one process tree, not two sessions.
    if (visible.some(child => child.pid !== p.pid && child.provider === p.provider && isDescendant(child.pid, p.pid, byPid))) continue;
    result.externalProcesses.push({
      id: 'process:' + p.pid, pid: p.pid, provider: p.provider,
      name: (p.provider === 'claude' ? 'Claude' : 'Codex') + ' ' + (p.mode === 'app-server' ? 'app-server' : 'process'),
      mode: p.mode, status: 'running', managed: false, canRoute: false,
      detail: p.mode === 'app-server' ? 'May host multiple sessions; thread details unavailable' : 'Live process; session details unavailable'
    });
  }
  result.externalSessions.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  return result;
}

export class Discovery {
  constructor(store, {inventory = listProcesses, registry = readClaudeRegistry, now = Date.now, platform = process.platform, daemonPid = process.pid, codex = readCodexLive, identity = new IdentityCache()} = {}) {
    Object.assign(this, {store, inventory, registry, now, platform, daemonPid, codex, identity});
    this.cached = empty(); this.cached.discovery.checkedAt = 0;
  }
  async snapshot(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.cached.discovery.checkedAt && this.now() - this.cached.discovery.checkedAt < 5000) return this.cached;
    this.pending = this.scan();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async scan() {
    try {
      const processes = await this.inventory();
      const homes = new Map();
      const add = (home, account = {}) => {
        if (home) homes.set(path.resolve(home), {home: path.resolve(home), accountId: account.id, accountName: account.name});
      };
      add(path.join(os.homedir(), '.claude')); add(process.env.CLAUDE_CONFIG_DIR);
      for (const a of this.store.state.accounts.filter(a => a.provider === 'claude')) add(this.store.home(a), a);
      const profiles = [...homes.values()].map(p => ({...p, provider:'claude', records: this.registry(p.home)}));
      const codexHomes = new Map();
      const addCodex=(home,a={})=>{if(home && fs.existsSync(home))codexHomes.set(path.resolve(home),{home:path.resolve(home),provider:'codex',accountId:a.id,accountName:a.name});};
      addCodex(path.join(os.homedir(),'.codex'));addCodex(process.env.CODEX_HOME);
      for(const a of this.store.state.accounts.filter(a=>a.provider==='codex'))addCodex(this.store.home(a),a);
      const codexProfiles=[...codexHomes.values()];
      const all=[...profiles,...codexProfiles];
      await Promise.all(all.map(async p=>{p.identity=await this.identity.get(p.provider,p.home);}));
      for(const p of all){
        if(p.accountId || !p.identity)continue;
        const matches=all.filter(a=>a.accountId && a.provider===p.provider && a.identity?.key===p.identity.key);
        if(matches.length===1){p.accountId=matches[0].accountId;p.accountName=matches[0].accountName;}
        else p.accountName=p.identity.label+(matches.length>1?' (multiple labels)':'');
      }
      let codexSessions=[],codexError;
      try{codexSessions=await this.codex(codexProfiles,processes);}catch{codexError='Codex thread discovery is unavailable; showing its processes only.';}
      this.cached = buildDiscovery({processes, profiles, codexSessions, managed: this.store.state.sessions, daemonPid: this.daemonPid, platform: this.platform, now: this.now()});
      if(codexError)this.cached.discovery.warning=codexError;
    } catch {
      this.cached = empty();
      this.cached.discovery = {checkedAt: this.now(), error: 'Native session detection is unavailable. Check process-list access and Claude session-folder permissions.'};
    }
    return this.cached;
  }
}
