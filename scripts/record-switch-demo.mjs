import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store,dataRoot} from '../src/storage.mjs';
import {serve} from '../src/server.mjs';
import {rpcCall} from '../src/client.mjs';
import {spawnTerminal} from '../src/terminal-runtime.mjs';
import {readIdentity} from '../src/identity.mjs';
import {delay} from '../src/native-common.mjs';
import {premiumFrame} from '../src/premium-display.mjs';

// Deliberate native demo: two real Claude logins, two tiny no-tool prompts.
// Quota readings are fixtures; session transitions come from the real supervisor.
// Export only allowlisted display fields, never raw terminal output or credentials.
const source=new Store(dataRoot());
const accounts=source.state.accounts.filter(a=>a.provider==='claude'&&a.enabled&&a.auth==='ready').slice(0,2);
if(accounts.length<2)throw new Error('The demo needs two connected Claude accounts.');
const identities=await Promise.all(accounts.map(a=>readIdentity('claude',source.home(a))));
if(!identities.every(Boolean)||identities[0].key===identities[1].key)throw new Error('The demo needs two distinct authenticated Claude accounts.');
const repo=fileURLToPath(new URL('..',import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-demo-'));
const store=new Store(root),outputDir=path.join(repo,'artifacts','switch-demo');
fs.mkdirSync(outputDir,{recursive:true});
store.state.accounts=accounts.map((a,i)=>({...a,name:'Claude Account '+(i+1),nativeHome:source.home(a)}));
store.state.settings={...store.state.settings,threshold:10,pollSeconds:3600,nativeDefaults:{claude:accounts[0].id}};
store.save();
let primaryQuota=12;
const service=await serve(root,{probe:async(provider,home)=>({auth:'ready',usage:{windows:[{label:'5h',remaining:home===source.home(accounts[0])?primaryQuota:100,observedAt:Date.now(),resetsAt:Date.now()/1000+4*3600}]}}),discovery:{snapshot:async()=>({externalSessions:[],externalProcesses:[]})}});
const api=(op,args)=>rpcCall(service.endpoint,op,args);
const marker='RELAY_DEMO_'+Date.now();
let child,exited=false,raw='',captureTimer,phase='Connected once. Switching stays automatic.',busy=false;
const frames=[];
function transcript(session){
 const home=source.home(accounts.find(a=>a.id===session.accountId));
 const projects=path.join(home,'projects');
 if(!fs.existsSync(projects))return [];
 for(const d of fs.readdirSync(projects,{withFileTypes:true})){
  if(!d.isDirectory()||d.isSymbolicLink())continue;
  const file=path.join(projects,d.name,session.nativeId+'.jsonl');
  if(fs.existsSync(file))return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 }
 return [];
}
function replies(session){
 return transcript(session).filter(x=>x.type==='assistant'&&(x.message?.content||[]).some(c=>c.type==='text'&&c.text.includes(marker))).length;
}
async function capture(){
 if(busy||exited)return;busy=true;
 try{
  const snap=await api('snapshot'),session=snap.sessions.find(s=>s.supervisorPid===child.pid);if(!session)return;
  const safe={settings:snap.settings,accounts:snap.accounts.map(a=>({name:a.name,provider:a.provider,remaining:a.remaining,enabled:true,auth:'ready',usage:{windows:a.usage?.windows||[]}})),sessions:[{name:'Demo session',accountName:session.accountName,provider:session.provider,status:session.status,auto:session.auto,threshold:session.threshold,integrated:true,pendingName:session.pendingName,committing:!!session.committing,boundary:session.pendingName?'Waiting for a safe stopping point.':null,pendingSince:session.pendingSince}],externalSessions:[],externalProcesses:[]};
  const frame=premiumFrame(safe,{columns:120,rows:26,compact:true,notice:phase,noticeTone:'mint'});
  frame.lines[2]='  REAL ACCOUNT SWITCH  |  DEMO QUOTA VALUES  |  Recorded from an isolated native session';
  frames.push({at:Date.now(),phase,columns:120,rows:26,lines:frame.lines,account:session.accountName,status:session.status,pending:!!session.pending,committing:!!session.committing});
 }finally{busy=false;}
}
async function waitFor(predicate,label,ms=90000){
 const end=Date.now()+ms;
 while(Date.now()<end&&!exited){
  if(raw.includes('2. Skip'))throw new Error('Native update prompt; demo stopped without accepting it.');
  const s=(await api('snapshot')).sessions.find(s=>s.supervisorPid===child.pid);
  if(s?.error)throw new Error(label+': native session reported an error.');
  if(predicate(s))return s;
  await delay(500);
 }
 throw new Error(label+': native session did not reach the expected state.');
}
try{
 const env={...process.env,TERM:'xterm-256color',RELAY_HOME:root};
 delete env.RELAY_ACCOUNT;
 child=spawnTerminal(process.execPath,[path.join(repo,'bin','relay-native.mjs'),'claude','--name','Relay switching demo','--no-chrome','--permission-mode','default','Remember this marker: '+marker+'. Reply only with the marker. Do not use tools or modify files.'],{cwd:repo,env,cols:120,rows:28});
 child.onData(text=>{raw=(raw+text).slice(-12000);if(text.includes('\x1b[6n'))child.write('\x1b[1;1R');if(text.includes('\x1b[c'))child.write('\x1b[?1;2c');});
 child.onExit(()=>exited=true);
 const initial=await waitFor(s=>s?.nativeId&&s.status==='idle'&&replies(s)>=1,'Initial response');
 console.log('Initial native conversation is ready.');
 await api('session-configure',{session:initial.id,auto:true,threshold:10});
 captureTimer=setInterval(()=>void capture().catch(()=>{}),300);
 await capture();await delay(3000);
 phase='Usage reaches 10%: Relay queues a switch to the next account.';
 primaryQuota=9;await api('refresh');
 const switched=await waitFor(s=>s?.accountId===accounts[1].id&&!s.pending&&s.status==='idle','Automatic account switch');
 if(switched.nativeId!==initial.nativeId)throw new Error('Conversation identity changed.');
 console.log('Automatic switch acknowledged by the native supervisor; same conversation.');
 phase='Second account active. Same saved conversation.';
 await capture();await delay(2200);
 const before=replies(switched);
 child.write('\x1b[200~What exact marker did I ask you to remember? Reply only with it. Do not use tools.\x1b[201~');
 await delay(1200);child.write('\r');
 phase='Continuing on the second account. Checking remembered context.';
 await waitFor(s=>s?.accountId===accounts[1].id&&s.status==='idle'&&replies(s)>before,'Second-account response');
 phase='Verified: the second account remembers the conversation. No logout or login.';
 await capture();await delay(4000);
 clearInterval(captureTimer);while(busy)await delay(50);
 fs.writeFileSync(path.join(outputDir,'recording.json'),JSON.stringify({recordedAt:new Date().toISOString(),kind:'real-native-switch-with-fixture-quota',verified:{distinctAccounts:true,automaticSwitch:true,sameConversation:true,secondAccountRecall:true},frames},null,2));
 console.log('Saved '+frames.length+' sanitized dashboard frames. Native switch and recall verified.');
}finally{
 clearInterval(captureTimer);while(busy)await delay(50);
 if(child&&!exited){child.write('\x04');await delay(250);if(!exited)child.write('\x04');await delay(2000);if(!exited)child.kill();}
 await service.close();
 const allowed=fs.realpathSync(os.tmpdir())+path.sep+'relay-demo-',actual=fs.realpathSync(root);
 if(!actual.startsWith(allowed))throw new Error('Unexpected demo cleanup path');
 fs.rmSync(actual,{recursive:true,force:true});
}
setTimeout(()=>process.exit(0),250);
