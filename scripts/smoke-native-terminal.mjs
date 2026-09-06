import pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,dataRoot} from '../src/storage.mjs';
import {serve} from '../src/server.mjs';
import {fileURLToPath} from 'node:url';
import {connect} from '../src/client.mjs';
import {delay} from '../src/native-common.mjs';
let fixture,fixtureRoot;
if(process.argv.includes('--isolated')){
  const source=new Store(dataRoot());fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-check-'));const store=new Store(fixtureRoot);
  store.state.accounts=source.state.accounts.filter(a=>a.provider==='claude').map(a=>({...a,nativeHome:source.home(a)}));store.save();
  fixture=await serve(fixtureRoot,{probe:async()=>({auth:'ready',usage:{windows:[{label:'test limit',remaining:100,observedAt:Date.now(),resetsAt:Date.now()/1000+3600}]}}),discovery:{snapshot:async()=>({externalSessions:[],externalProcesses:[],discovery:{checkedAt:Date.now()}})}});
  process.env.RELAY_HOME=fixtureRoot;
}
const provider=process.argv[2] || 'codex',api=await connect(),idleInput=process.argv.includes('--idle-input'),conversation=process.argv.includes('--conversation') || idleInput;
const marker='RELAY_MEMORY_'+Date.now();
const child=pty.spawn(process.execPath,[fileURLToPath(new URL('../bin/relay-native.mjs',import.meta.url)),provider,...(provider==='claude'?['--name','Relay installation check','--no-chrome',...(conversation && !idleInput?['--permission-mode','default','Remember this marker: '+marker+'. Reply only with the marker. Do not use tools.']:[])]:['-c','check_for_update_on_startup=false'])],{name:'xterm-256color',cols:110,rows:32,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'},useConpty:true,useConptyDll:true});
let output='',exited=false;
async function enterPrompt(text){child.write('\x1b[200~'+text+'\x1b[201~');await delay(1400);child.write('\r');}
function assistantCount(session){const roots=process.env.RELAY_HOME || JSON.parse(fs.readFileSync((process.env.USERPROFILE || process.env.HOME)+'/.relay/integration.json','utf8')).root;const state=JSON.parse(fs.readFileSync(roots+'/state.json','utf8'));const a=state.accounts.find(a=>a.id===session.accountId);const home=a.nativeHome || roots+'/accounts/'+a.id;const projects=home+'/projects';if(!fs.existsSync(projects))return 0;for(const dir of fs.readdirSync(projects)){const file=projects+'/'+dir+'/'+session.nativeId+'.jsonl';if(fs.existsSync(file))return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {};}}).filter(x=>x.type==='assistant' && JSON.stringify(x.message?.content || '').includes(marker)).length;}return 0;}
child.onData(text=>{output=(output+text).slice(-16000);if(text.includes('\x1b[6n'))child.write('\x1b[1;1R');if(text.includes('\x1b[c'))child.write('\x1b[?1;2c');});child.onExit(()=>{exited=true;});
try{
  const until=Date.now()+(conversation?90000:45000);let session;
  while(Date.now()<until && !exited){
    const state=await api('snapshot');session=state.sessions.find(s=>s.supervisorPid===child.pid);
    // Accept only a workspace trust prompt for this test repository. No model/tool permissions are answered.
    if(output.includes('2. Skip'))throw new Error('Unexpected native update prompt; test stopped without selecting an action.');
    if(provider==='claude' && output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'').includes('No,exitYes,Itrustthisfolder')){child.write('\x1b[B');await delay(300);child.write('\r');output='';}
    if(session?.nativeId && session.status==='idle' && (!conversation || idleInput || assistantCount(session)>=1))break;
    await delay(500);
  }
  if(!session?.nativeId || session.status!=='idle')throw new Error('Native UI did not become idle: '+JSON.stringify({status:session?.status,error:session?.error,exited,tail:output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-1200)}));
  console.log('PASS: '+provider+' normal native terminal registered its actual conversation and account.');
  if(provider==='claude' && idleInput){
    await delay(2200); // SessionStart may precede the first usable native prompt.
    await enterPrompt('Remember this marker: '+marker+'. Reply only with the marker. Do not use tools.');
    const end=Date.now()+60000;while(Date.now()<end){session=(await api('snapshot')).sessions.find(s=>s.supervisorPid===child.pid);if(session?.status==='idle' && assistantCount(session)>=1 && session.boundary==='Ready to switch.')break;await delay(500);}
    if(session?.boundary!=='Ready to switch.' || assistantCount(session)<1)throw new Error('A completed typed turn was not ready for idle switching: '+JSON.stringify({status:session?.status,boundary:session?.boundary,error:session?.error}));
    child.write('Draft to clear');child.write('\x1b[O');child.write('\x1b[');await delay(100);child.write('I');
  }
  if(provider==='claude'){
    const state=await api('snapshot'),target=state.accounts.find(a=>a.provider===provider && a.id!==session.accountId && a.auth==='ready');
    if(!target)throw new Error('Second Claude login is unavailable for handover test.');
    const original=session.accountId,originalNativeId=session.nativeId;await api('session-route',{session:session.id,account:target.id});
    if(idleInput){
      await delay(2200);const waiting=(await api('snapshot')).sessions.find(s=>s.supervisorPid===child.pid);
      if(waiting?.accountId!==original || !waiting?.pending || !/unsubmitted/.test(waiting.boundary))throw new Error('Relay did not protect the unsubmitted draft.');
      console.log('PASS: native Claude account switch waits for real unsubmitted text.');
      child.write('\x15');child.write('\x1b[O\x1b[I\x1b[1;1R');
    }
    const deadline=Date.now()+60000;
    while(Date.now()<deadline && !exited){session=(await api('snapshot')).sessions.find(s=>s.supervisorPid===child.pid);if(session?.accountId===target.id && !session.pending)break;if(session?.error)throw new Error(session.error+' '+output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-1400));if(provider==='claude' && output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'').includes('No,exitYes,Itrustthisfolder')){child.write('\x1b[B');await delay(300);child.write('\r');output='';}await delay(500);}
    if(session?.accountId!==target.id || session.pending)throw new Error('Claude account switch was not confirmed. '+JSON.stringify({status:session?.status,error:session?.error,tail:output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-1200)}));
    console.log('PASS: native Claude terminal changed between two real named subscription accounts.');
    if(idleInput){
      console.log('PASS: idle route completed after clearing the draft and receiving VS Code focus reports, without sending another prompt.');
      for(const account of [original,target.id]){
        await api('session-route',{session:session.id,account});const end=Date.now()+60000;
        while(Date.now()<end && !exited){session=(await api('snapshot')).sessions.find(s=>s.supervisorPid===child.pid);if(session?.accountId===account && !session.pending)break;if(session?.error)throw new Error(session.error);await delay(500);}
        if(session?.accountId!==account || session.pending)throw new Error('A repeated idle route required an extra prompt.');
      }
      console.log('PASS: two further idle account changes completed without submitting a new prompt.');
    }
    if(conversation){
      if(session.nativeId!==originalNativeId)throw new Error('Conversation ID changed.');
      await delay(1800);
      await enterPrompt('What was the exact marker I asked you to remember? Reply only with it. Do not use tools.');
      const end=Date.now()+45000;while(Date.now()<end && assistantCount(session)<2)await delay(500);
      if(assistantCount(session)<2)throw new Error('The second account did not recall the prior marker. '+output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-800));
      console.log('PASS: same native conversation ID; second real account recalled the first account conversation after handover.');
    }
  }
}finally{
  if(!exited){child.write('\x03');await delay(700);child.write('\x03');await delay(700);}
  if(!exited)child.kill();await delay(400);
  if(fixture){await fixture.close();const allowed=path.join(fs.realpathSync(os.tmpdir()),'relay-native-check-');const actual=fs.realpathSync(fixtureRoot);if(!actual.startsWith(allowed))throw new Error('Unexpected fixture cleanup path');fs.rmSync(actual,{recursive:true,force:true});}
}

// The headless outer ConPTY harness can keep a worker handle after its child exits.
// Reaching this line means all assertions passed and the owned terminal was closed.
setTimeout(()=>process.exit(0),250);
