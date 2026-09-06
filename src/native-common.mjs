import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {spawnTerminal} from './terminal-runtime.mjs';
import {executable} from './process.mjs';
import {readJson} from './storage.mjs';
import {TerminalInputState} from './terminal-input.mjs';
export const installationFile=()=>path.join(os.homedir(),'.relay','integration.json');
export function integration(){return readJson(installationFile(),null);}
export function nativeExecutable(provider){return integration()?.executables?.[provider] || executable(provider);}
export function nativeHome(provider){return process.env[provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME'] || path.join(os.homedir(),'.'+provider);}
export const continuation='Continue the unfinished task from this saved conversation. Relay changed the subscription account at a completed stopping point. Use recorded tool results and inspect workspace state if needed; do not repeat completed actions.';
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function passthrough(provider,args){
  const child=spawn(nativeExecutable(provider),args,{stdio:'inherit',env:{...process.env,RELAY_BYPASS:'1'},shell:false});
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code ?? 1));});
}
export function eligible(provider,args,tty=process.stdin.isTTY){
  if(args.includes('--ephemeral'))return false; // Honor explicitly requested temporary native sessions.
  if(!tty || process.env.RELAY_BYPASS==='1')return false;
  if(provider==='claude' && args.includes('-p'))return false;
  if(args.some(x=>['--help','-h','--version','-V','--print','--remote','--bg','--background','--bare','--safe-mode','--no-session-persistence','--settings','--setting-sources','--session-id','--fork-session','--restricted','--cloud','--environment','--from-pr','--worktree','-w','--oss','--local-provider'].includes(x) || /^(--remote|--settings|--setting-sources|--session-id|--cloud|--environment|--from-pr|--worktree|--local-provider)=/.test(x)))return false;
  const commands=provider==='claude'?['auth','agents','attach','logs','stop','kill','rm','respawn','doctor','install','update','upgrade','mcp','plugin','plugins','project','gateway','import','setup-token','ultrareview','auto-mode']:['exec','e','review','login','logout','app','app-server','mcp','mcp-server','plugin','remote-control','completion','update','doctor','sandbox','debug','apply','a','archive','delete','unarchive','cloud','exec-server','features','help'];
  return !commands.includes(args[0]);
}
export function terminalProcess(command,args,{env,cwd=process.cwd(),forwardInput=true,onData=()=>{}}={}){
  const child=spawnTerminal(command,args,{cwd,env});
  let inputEnabled=true,lastInputAt=0,buffer='';const input=new TerminalInputState();
  const wasRaw=!!process.stdin.isRaw;
  const data=chunk=>{const before=input.revision;input.feed(chunk.toString());if(input.revision!==before)lastInputAt=Date.now();if(inputEnabled)child.write(chunk.toString());else buffer+=chunk.toString();};
  const resize=()=>{try{child.resize(process.stdout.columns || 100,process.stdout.rows || 30);}catch{}};
  if(forwardInput){process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',data);process.stdout.on('resize',resize);}
  child.onData(chunk=>{process.stdout.write(chunk);onData(chunk);});
  const exited=new Promise(resolve=>child.onExit(event=>{process.stdin.off('data',data);process.stdout.off('resize',resize);if(forwardInput){process.stdin.setRawMode?.(wasRaw);process.stdin.pause();}resolve(event.exitCode);}));
  return {child,exited,get inputRevision(){return input.revision;},get hasDraft(){return input.hasDraft;},markSubmitted(){input.submitted();},restoreInput(text){input.feed(text);child.write(text);},get lastInputAt(){return lastInputAt;},pauseInput(){inputEnabled=false;},takeInput(){const value=buffer;buffer='';return value;},resumeInput(){inputEnabled=true;if(buffer){child.write(buffer);buffer='';}}};
}

// Keep a newly completed switch acknowledgement when an older heartbeat returns.
export class NativeReports {
  constructor(){this.applied=null;this.error=null;}
  async send(api,fields){
    const {applied,error}=this;
    const result=await api('native-heartbeat',{...fields,applied,error});
    if(this.applied===applied)this.applied=null;
    if(this.error===error)this.error=null;
    return result;
  }
}
