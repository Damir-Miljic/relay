import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const require=createRequire(import.meta.url);

// node-pty 1.1.0's macOS prebuilds can arrive with mode 0644 (upstream #850).
// Use its own loader so source builds and Intel/Apple Silicon prebuilds agree.
export function macSpawnHelper(){
  if(process.platform!=='darwin')return null;
  const utils=require.resolve('node-pty/lib/utils.js');
  const native=require(utils).loadNativeModule('pty');
  return path.resolve(path.dirname(utils),native.dir,'spawn-helper');
}
export function ensureHelperExecutable(file){
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile())throw new Error('expected a regular helper file');
    try{fs.accessSync(file,fs.constants.X_OK);return;}catch(error){if(error.code!=='EACCES')throw error;}
    // Grant only owner execute; leave read/write and other users' access alone.
    fs.chmodSync(file,(stat.mode & 0o7777) | 0o100);
    fs.accessSync(file,fs.constants.X_OK);
  }catch(error){
    throw new Error('Cannot prepare the Mac terminal helper at '+file+' ('+(error.code || error.message)+'). Run npm ci in the Relay folder, then try again.',{cause:error});
  }
}
export function spawnTerminal(command,args,{cwd=process.cwd(),env=process.env,cols=process.stdout.columns || 100,rows=process.stdout.rows || 30}={}){
  const pty=require('node-pty'),helper=macSpawnHelper();
  if(helper)ensureHelperExecutable(helper);
  try{
    return pty.spawn(command,args,{name:process.env.TERM || 'xterm-256color',cwd,env,cols,rows,
      ...(process.platform==='win32'?{useConpty:true,useConptyDll:true}:{})});
  }catch(error){
    if(process.platform==='darwin' && /posix_spawn/.test(error.message)){
      throw new Error('Mac terminal launch failed. Run relay doctor for a terminal check. Command: '+command+'; folder: '+cwd+'. '+error.message,{cause:error});
    }
    throw error;
  }
}

// Exercise a real PTY without launching a provider or reading any account data.
export async function probeTerminalRuntime({cwd=process.cwd(),timeoutMs=10000}={}){
  // Isolate the diagnostic: node-pty can retain a Windows worker after PTY exit.
  const script='import {runTerminalProbe} from '+JSON.stringify(import.meta.url)+';try{await runTerminalProbe({timeoutMs:'+timeoutMs+'});process.exit(0);}catch(error){console.error(error.message);process.exit(1);}';
  try{await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd,windowsHide:true,timeout:timeoutMs+2000,maxBuffer:32768});}
  catch(error){throw new Error(error.stderr?.trim() || 'Could not complete the terminal check: '+error.message,{cause:error});}
}
export async function runTerminalProbe({cwd=process.cwd(),timeoutMs=10000}={}){
  const script="let input='';process.stdout.write('RELAY_PTY_READY\\n');process.stdin.on('data',chunk=>{input+=chunk;if(input.includes('relay-probe')){process.stdout.write('RELAY_PTY_OK\\n');process.exit(0);}});";
  const child=spawnTerminal(process.execPath,['-e',script],{cwd,cols:80,rows:24});
  return new Promise((resolve,reject)=>{
    let output='',sent=false,settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error){try{child.kill();}catch{}reject(error);}else resolve();};
    const timer=setTimeout(()=>finish(new Error('Terminal check timed out after '+timeoutMs+' ms.')),timeoutMs);
    child.onData(text=>{
      output=(output+text).slice(-8192);
      if(!sent && output.includes('RELAY_PTY_READY')){
        sent=true;
        try{child.resize(90,28);child.write('relay-probe\r');}catch(error){finish(error);}
      }
    });
    child.onExit(({exitCode})=>finish(exitCode===0 && sent && output.includes('RELAY_PTY_OK')?null:new Error('Terminal check failed (exit '+exitCode+').')));
  });
}
