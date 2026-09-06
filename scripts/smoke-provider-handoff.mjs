
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import pty from 'node-pty';
import {Store,dataRoot} from '../src/storage.mjs';import {serve} from '../src/server.mjs';import {rpcCall} from '../src/client.mjs';import {delay,nativeHome} from '../src/native-common.mjs';
const source=new Store(dataRoot()),root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-handoff-check-')),store=new Store(root);
store.state.accounts=source.state.accounts.map(a=>({...a,nativeHome:source.home(a)}));store.state.settings.crossProviderAuto=false;store.save();
const service=await serve(root,{probe:async()=>({auth:'ready',usage:{windows:[{remaining:100,observedAt:Date.now(),resetsAt:Date.now()/1000+3600}]}}),discovery:{snapshot:async()=>({externalSessions:[],externalProcesses:[]})}});
const api=(op,args)=>rpcCall(service.endpoint,op,args),marker='RELAY_HANDOFF_'+Date.now();
const selected=store.state.accounts.find(a=>a.provider==='claude' && a.auth==='ready'),codex=store.state.accounts.find(a=>a.provider==='codex' && a.auth==='ready');
let child,exited=false,output='';
const findFile=(dir,id)=>{
 if(!fs.existsSync(dir))return null;
 for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const full=path.join(dir,e.name);if(e.isDirectory()){const hit=findFile(full,id);if(hit)return hit;}else if(e.name.endsWith(id+'.jsonl'))return full;}return null;
};
function recalled(s){
 if(!s?.nativeId)return false;
 const a=store.account(s.accountId),file=findFile(path.join(s.provider==='codex'?nativeHome('codex'):store.home(a),s.provider==='codex'?'sessions':'projects'),s.nativeId);if(!file)return s.provider==='codex' && output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').includes(marker);
 return fs.readFileSync(file,'utf8').split('\n').some(line=>{try{const x=JSON.parse(line);return s.provider==='claude'?x.type==='assistant' && (x.message?.content || []).some(c=>c.type==='text' && c.text.includes(marker)):x.type==='response_item' && x.payload?.type==='message' && x.payload.role==='assistant' && x.payload.content?.some(c=>c.type==='output_text' && c.text.includes(marker));}catch{return false;}});
}
async function waitFor(predicate,label,ms=120000){
 const end=Date.now()+ms;
 while(Date.now()<end && !exited){const state=await api('snapshot'),s=state.sessions.find(x=>x.supervisorPid===child.pid);
 if(s?.error)throw new Error(label+': '+s.error);
 if(predicate(s))return s;
 await delay(700);}
 const s=(await api('snapshot')).sessions.find(x=>x.supervisorPid===child.pid);
 throw new Error(label+': '+JSON.stringify({status:s?.status,provider:s?.provider,boundary:s?.boundary,pending:!!s?.pending,exited,tail:output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-1500)}));
}
try{
 child=pty.spawn(process.execPath,[path.resolve('bin/relay-native.mjs'),'claude','--name','Relay handoff validation','--no-chrome','--permission-mode','default','Remember the test marker '+marker+'. Respond with only this marker. Do not modify files. If this conversation is handed to another provider, read its handoff note and acknowledge with only the same marker. There is no other work to do.'],{name:'xterm-256color',cols:110,rows:34,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color',RELAY_HOME:root,RELAY_ACCOUNT:selected.id},useConpty:true,useConptyDll:true});
 child.onData(text=>{output=(output+text).slice(-16000);if(text.includes('\x1b[6n'))child.write('\x1b[1;1R');if(text.includes('\x1b[c'))child.write('\x1b[?1;2c');});child.onExit(()=>exited=true);
 let s=await waitFor(s=>s?.provider==='claude' && s.status==='idle' && recalled(s),'Initial Claude turn');
 if(!s.canHandoff)throw new Error('Protocol was not registered');
 const original=s.nativeId;console.log('PASS: isolated Claude conversation created with a unique marker.');
 let route=await api('session-route',{session:s.id,account:codex.id});await api('session-cancel-route',{session:s.id,commandId:route.commandId});await delay(1500);
 s=(await api('snapshot')).sessions.find(x=>x.supervisorPid===child.pid);if(s.provider!=='claude' || s.pending)throw new Error('Cancellation failed');
 console.log('PASS: queued cross-provider route cancelled without changing the source conversation.');
 output='';await api('session-route',{session:s.id,account:codex.id});
 s=await waitFor(s=>s?.provider==='codex' && s.status==='idle' && !s.pending && recalled(s),'Claude to Codex');
 if(s.nativeId===original)throw new Error('Native conversation was incorrectly reused');
 console.log('PASS: Claude → Codex in the same terminal; selected account confirmed and handoff marker recalled.');
 const codexId=s.nativeId;
 await api('session-route',{session:s.id,account:selected.id});
 s=await waitFor(s=>s?.provider==='claude' && s.status==='idle' && !s.pending && recalled(s),'Codex to Claude');
 if(s.nativeId===codexId || s.nativeId===original)throw new Error('Expected new receiving conversation');
 const notes=fs.readdirSync(path.join(root,'handoffs')).map(n=>fs.readFileSync(path.join(root,'handoffs',n),'utf8'));if(!notes.some(n=>n.includes('From: codex') && n.includes('[assistant]\n'+marker)))throw new Error('Codex transcript did not preserve its acknowledgement');
 console.log('PASS: Codex → Claude in the same terminal; new conversation recalled the handoff marker.');
}finally{
 if(child && !exited){child.write('\x04');await delay(200);child.write('\x04');await delay(1800);if(!exited)child.kill();}
 await service.close();
 // Keep only the owned validation directory on failure for diagnosis. It contains no copied credentials.
 console.log('Validation directory: '+root);
}
setTimeout(()=>process.exit(0),250);
