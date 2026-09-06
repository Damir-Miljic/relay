import fs from 'node:fs';
import {readClaudeExcerpts,writeHandoff,preflightHandoff,commitRoute} from './handoff.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeExecutable,nativeHome,terminalProcess,continuation,delay,NativeReports} from './native-common.mjs';
import {accountEnv} from './process.mjs';
import {RelayConnectionError} from './client.mjs';
import {requestClaudeExit} from './claude-exit.mjs';
import {readIdentity} from './identity.mjs';
import {readJson,privateDir,writeJson} from './storage.mjs';
import {transferHistory} from './providers.mjs';
import {readClaudeRegistry} from './discovery.mjs';

const values=new Set(['--add-dir','--agent','--agents','--allowedTools','--allowed-tools','--append-system-prompt','--autocompact','--betas','--debug','-d','--debug-file','--disallowedTools','--disallowed-tools','--effort','--fallback-model','--file','--input-format','--json-schema','--max-budget-usd','--mcp-config','--model','--name','-n','--output-format','--permission-mode','--permission-prompts','--plugin-dir','--plugin-url','--prompt-suggestions','--remote-control','--remote-control-session-name-prefix','--system-prompt','--system-prompt-file','--tools','--teleport']);
const variadic=new Set(['--add-dir','--allowedTools','--allowed-tools','--disallowedTools','--disallowed-tools','--mcp-config','--tools','--betas','--file']);
const optional=new Set(['--debug','-d','--remote-control','--prompt-suggestions']);
const flags=new Set(['--allow-dangerously-skip-permissions','--ax-screen-reader','--brief','--chrome','--dangerously-skip-permissions','--disable-slash-commands','--exclude-dynamic-system-prompt-sections','--forward-subagent-text','--ide','--include-hook-events','--include-partial-messages','--no-chrome','--replay-user-messages','--strict-mcp-config']);
export function resumeOptions(args){
  const out=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--continue' || arg==='-c')continue;
    if(arg==='--resume' || arg==='-r'){if(args[i+1] && !args[i+1].startsWith('-'))i++;continue;}
    if(arg.startsWith('--resume='))continue;
    if(arg==='--')break;
    if(!arg.startsWith('-'))continue; // Initial prompt is already in the native transcript.
    if(arg.includes('=')){out.push(arg);continue;}
    if(flags.has(arg)){out.push(arg);continue;}
    if(variadic.has(arg)){out.push(arg);while(args[i+1] && !args[i+1].startsWith('-'))out.push(args[++i]);continue;}
    if(optional.has(arg)){out.push(arg);if(args[i+1] && !args[i+1].startsWith('-'))out.push(args[++i]);continue;}
    if(values.has(arg)){if(!args[i+1])throw new Error('Missing native option value.');out.push(arg,args[++i]);continue;}
    throw new Error('Native option '+arg+' is not yet supported by the account-resume integration.');
  }
  return out;
}
export class ClaudeBoundary {
  constructor(){this.status='starting';this.nativeId=null;this.risky=true;this.persistentRisk=true;this.shells=new Set();this.safeIdle=false;this.revision=0;this.backgroundCount=null;this.cronCount=null;this.backgroundKinds=[];this.cleanResume=false;}
  prepareCleanResume(){this.cleanResume=true;this.backgroundCount=0;this.cronCount=0;this.backgroundKinds=[];}
  observe(p){
    if(!p.sessionId || (this.nativeId && p.sessionId!==this.nativeId))return false;
    if(p.event==='SessionStart'){this.nativeId=p.sessionId;this.status='idle';this.safeIdle=p.source==='startup' || (p.source==='resume' && this.cleanResume);this.cleanResume=false;this.risky=!this.safeIdle;this.persistentRisk=this.risky;return false;}
    if(p.event==='UserPromptSubmit'){this.status='busy';this.safeIdle=false;this.risky=this.persistentRisk;this.revision++;}
    if(p.event==='PreToolUse' && p.tool==='Bash' && p.toolId)this.shells.add(p.toolId);
    else if(p.event==='PreToolUse' && !['Read','Grep','Glob','Edit','Write','NotebookEdit'].includes(p.tool)){this.risky=true;this.persistentRisk=true;}
    if(p.event==='PostToolUse' && p.tool==='Bash'){if(p.shellCompleted===true && this.shells.has(p.toolId))this.shells.delete(p.toolId);else{this.risky=true;this.persistentRisk=true;}}
    if(p.event==='SubagentStart'){this.risky=true;this.persistentRisk=true;}
    if(p.event==='Stop'){
      this.backgroundCount=p.backgroundCount;this.cronCount=p.cronCount;this.backgroundKinds=p.backgroundKinds || [];
      this.safeIdle=p.backgroundCount===0 && p.cronCount===0;
      this.status='idle';this.risky=!this.safeIdle;this.persistentRisk=this.risky;if(this.safeIdle)this.shells.clear();return this.safeIdle;
    }
    if(p.event==='PostToolBatch')return !this.risky && !this.persistentRisk && !this.shells.size && p.tools?.every(t=>['Read','Grep','Glob','Edit','Write','NotebookEdit','Bash'].includes(t));
    return false;
  }
}
export function claudeWaitReason(boundary,hasDraft=false,switching=false){
  if(switching)return 'Switching account; waiting for Claude to close and resume.';
  if(boundary.backgroundCount>0)return 'Waiting for '+boundary.backgroundCount+' background task'+(boundary.backgroundCount===1?'':'s')+(boundary.backgroundKinds.length?' ('+boundary.backgroundKinds.join(', ')+')':'')+'. Finish or stop background work in Claude first.';
  if(boundary.cronCount>0)return 'Waiting for '+boundary.cronCount+' scheduled task'+(boundary.cronCount===1?'':'s')+'.';
  if(hasDraft)return 'Waiting for unsubmitted text. Submit or clear the draft in Claude.';
  if(boundary.status==='busy')return 'Waiting for a completed tool batch or the end of this turn.';
  if(boundary.status==='starting')return 'Waiting for Claude to finish opening.';
  if(!boundary.safeIdle)return 'Waiting for Claude to confirm that no background work remains.';
  return 'Ready to switch.';
}
export function mergedSettings(base,account,command){
  const settings={...base,...account,hooks:{...base.hooks},permissions:{...base.permissions,...account.permissions}};
  for(const key of ['allow','ask','deny']){const rules=[...(base.permissions?.[key] || []),...(account.permissions?.[key] || [])];if(rules.length)settings.permissions[key]=[...new Set(rules)];}
  for(const [event,entries] of Object.entries(account.hooks || {}))settings.hooks[event]=[...(settings.hooks[event] || []),...entries];
  for(const event of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolBatch','Stop','SessionEnd','SubagentStart'])settings.hooks[event]=[...(settings.hooks[event] || []),{hooks:[{type:'command',command,timeout:10}]}];
  return settings;
}
export function seedClaudeUi(home,cwd){
  const original=nativeHome('claude');if(path.resolve(original)===path.resolve(home))return;
  const sourceFile=path.resolve(original)===path.join(os.homedir(),'.claude')?path.join(os.homedir(),'.claude.json'):path.join(original,'.claude.json');
  const source=readJson(sourceFile,{}),file=path.join(home,'.claude.json'),target=readJson(file,{});
  let changed=false;
  for(const key of ['hasCompletedOnboarding','lastOnboardingVersion','theme','preferredNotifChannel','editorMode'])if(target[key]===undefined && source[key]!==undefined){target[key]=source[key];changed=true;}
  const key=cwd.replaceAll('\\','/'),entry=source.projects?.[key] || source.projects?.[cwd];
  if(entry?.hasTrustDialogAccepted===true && target.projects?.[key]?.hasTrustDialogAccepted===undefined){target.projects ||= {};target.projects[key]={...target.projects[key],hasTrustDialogAccepted:true};changed=true;}
  if(changed)writeJson(file,target);
}
function hasTranscript(home,id){const base=path.join(home,'projects');if(!fs.existsSync(base))return false;return fs.readdirSync(base,{withFileTypes:true}).some(e=>e.isDirectory() && !e.isSymbolicLink() && fs.existsSync(path.join(base,e.name,id+'.jsonl')));}
function shellQuote(value){return "'"+value.replaceAll("'","'\\''")+"'";}
function launchEnv(home,endpoint,token){
  const env=accountEnv('claude',home);delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if(path.resolve(home)===path.join(os.homedir(),'.claude'))delete env.CLAUDE_CONFIG_DIR;
  return {...env,RELAY_BYPASS:'1',RELAY_HOOK_URL:endpoint,RELAY_HOOK_TOKEN:token};
}
export async function runClaude(api,registration,args,{root,onReady=()=>{}}={}){
  const resumeArgs=resumeOptions(args),boundary=new ClaudeBoundary();
  const token=crypto.randomBytes(32).toString('hex');
  let terminal,home=registration.home,target,closed=false,polling=false,switching=false,scheduled=null,handed=null,arrivalAcknowledged=false;const reports=new NativeReports();
  const dir=path.join(root,'native',registration.session.id.replace(':','-'));privateDir(dir);
  const settingsFile=path.join(dir,'hooks.json');
  const hookBin=fileURLToPath(new URL('../bin/relay-hook.mjs',import.meta.url));
  const command=shellQuote(process.execPath.replaceAll('\\','/'))+' '+shellQuote(hookBin.replaceAll('\\','/'));
  const server=http.createServer(async(req,res)=>{
    if(req.headers.origin || req.method!=='POST' || req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)throw new Error('Too much hook metadata.');}
      const p=JSON.parse(raw),safe=boundary.observe(p);
      if(['SessionStart','UserPromptSubmit'].includes(p.event) && p.sessionId===boundary.nativeId)terminal?.markSubmitted();
      if(registration.arrival && p.event==='SessionStart' && p.sessionId===boundary.nativeId && !arrivalAcknowledged){reports.applied={accountId:registration.arrival.id,commandId:registration.arrival.commandId};arrivalAcknowledged=true;}
      const result={};
      if(target && !switching && safe && terminal && !terminal.hasDraft && (target.provider!=='codex' || p.event==='Stop')){
        switching=true;terminal.pauseInput();
        const selected=target,yielded=p.event==='PostToolBatch';
        if(yielded){result.continue=false;result.stopReason='Relay is switching subscription accounts after this completed tool batch.';}
        res.end(JSON.stringify(result));
        scheduled=handover(selected,yielded).catch(e=>{if(!(e instanceof RelayConnectionError))reports.error=e.message;}).finally(()=>{switching=false;terminal?.resumeInput();});
        return;
      }
      res.end('{}');
    }catch{res.writeHead(400);res.end('{}');}
  });
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  const endpoint='http://127.0.0.1:'+server.address().port;
  const launch=(launchArgs)=>{
    seedClaudeUi(home,process.cwd());
    writeJson(settingsFile,mergedSettings(readJson(path.join(nativeHome('claude'),'settings.json'),{}),readJson(path.join(home,'settings.json'),{}),command));
    boundary.status='starting';
    terminal=terminalProcess(nativeExecutable('claude'),[...launchArgs,'--settings',settingsFile],{env:launchEnv(home,endpoint,token)});
    return terminal;
  };
  const beat=async()=>{const result=await reports.send(api,{session:registration.session.id,pid:process.pid,nativePid:terminal?.child.pid,nativeId:boundary.nativeId,status:switching?'switching':boundary.status,boundary:claudeWaitReason(boundary,terminal?.hasDraft,switching)});if(registration.arrival && result.session.accountId===registration.arrival.id && !result.session.committing)onReady();return result;};
  async function handover(selected,yielded){
    // Validate credentials before asking the current native terminal to exit.
    if(selected.provider==='codex')await preflightHandoff(selected);
    else if(!await readIdentity('claude',selected.home))throw new Error('The target Claude login could not be verified.');
    const fresh=await beat();target=fresh.target;
    if(target?.commandId!==selected.commandId)return;
    // The hook has returned; wait for Claude itself to publish idle status before requesting exit.
    const old=terminal,until=Date.now()+15000;
    while(Date.now()<until){
      const record=readClaudeRegistry(home).find(x=>x.pid===old.child.pid && x.sessionId===boundary.nativeId);
      if(record?.status==='idle')break;
      await delay(150);
    }
    const record=readClaudeRegistry(home).find(x=>x.pid===old.child.pid && x.sessionId===boundary.nativeId);
    if(record?.status!=='idle')throw new Error('Claude has not confirmed idle yet; the switch remains paused.');
    const cross=selected.provider==='codex';
    const note=cross?writeHandoff(root,{...fresh.session,nativeId:boundary.nativeId},selected,hasTranscript(home,boundary.nativeId)?await readClaudeExcerpts(home,boundary.nativeId):[]):null;
    if(old.hasDraft)return;
    if(!await commitRoute(api,registration,selected))return;
    await requestClaudeExit(old);
    const exited=await Promise.race([old.exited.then(()=>true),delay(20000).then(()=>false)]);
    if(!exited)throw new Error('Claude did not confirm exit. The current session was left open; return to its empty prompt and route again.');
    if(cross){
      handed={target:selected,note,input:old.takeInput(),rollback:{registration:{session:fresh.session,home},args:[...resumeArgs,'--resume',boundary.nativeId],nativeId:boundary.nativeId}};
      return;
    }
    process.stdout.write('\r\n[Relay] Resuming this conversation with '+selected.name.replace(/[\x00-\x1f\x7f]/g,' ')+'...\r\n');
    boundary.prepareCleanResume();
    const typed=old.takeInput();
    const hasHistory=fs.existsSync(path.join(path.dirname(record.transcriptPath || ''),boundary.nativeId+'.jsonl')) || hasTranscript(home,boundary.nativeId);
    const nextArgs=hasHistory?[...resumeArgs,'--resume',boundary.nativeId,...(yielded?[continuation]:[])]:resumeArgs;
    try{if(hasHistory)transferHistory({provider:'claude',nativeId:boundary.nativeId},home,selected.home);else boundary.nativeId=null;home=selected.home;}
    catch(e){launch([...resumeArgs,'--resume',boundary.nativeId,...(yielded?[continuation]:[])]);throw e;}
    try{
      const next=launch(nextArgs);
      if(typed)next.restoreInput(typed);
      // SessionStart proves that the replacement resumed its native conversation.
      let exitedBeforeReady=false;next.exited.then(()=>{exitedBeforeReady=true;});
      while(boundary.status==='starting' && !exitedBeforeReady)await delay(100);
      if(exitedBeforeReady && boundary.status==='starting')throw new Error('Claude exited before confirming the resumed conversation.');
      reports.applied={accountId:selected.id,commandId:selected.commandId};target=null;
    }catch(e){reports.error=e.message;throw e;}
  }
  let timer;
  try{
    launch(args);
    const poll=async()=>{
      if(polling || closed || handed)return;polling=true;
      try{const result=await beat();target=result.target;
        if(target && !switching && boundary.status==='idle' && boundary.safeIdle && !terminal.hasDraft){const selected=target;switching=true;terminal.pauseInput();scheduled=handover(selected,false).catch(e=>{if(!(e instanceof RelayConnectionError))reports.error=e.message;}).finally(()=>{switching=false;terminal?.resumeInput();});}
      }catch(e){if(!(e instanceof RelayConnectionError))reports.error=e.message;}finally{polling=false;}
    };
    timer=setInterval(poll,1000);await poll();
    for(;;){const active=terminal,code=await active.exited;if(scheduled)await scheduled;if(handed)return {handoff:handed};if(terminal!==active)continue;if(registration.arrival && !arrivalAcknowledged)throw new Error('Claude exited before opening the handoff conversation.');return code;}
  }finally{closed=true;clearInterval(timer);await new Promise(r=>server.close(r));}
}
