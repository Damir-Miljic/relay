import fs from 'node:fs';import {premiumFrame} from '../src/premium-display.mjs';
const now=Date.now(),window=(label,remaining,reset)=>({label,remaining,resetsAt:now/1000+reset,observedAt:now});
const account=(id,name,provider,windows)=>({id,name,provider,remaining:Math.min(...windows.map(w=>w.remaining)),enabled:true,auth:'ready',usage:{windows}});
const state={accounts:[
account('a','Claude Account 1','claude',[window('5h',63,13*60),window('7d',73,6*86400),window('7d/Fable',76,6*86400)]),
account('b','Claude Account 2','claude',[window('5h',100,5*3600),window('7d',100,6*86400),window('7d/Fable',100,6*86400)]),
account('c','Codex Account 1','codex',[window('7d',29,6*86400),window('base_model_inference/7d',100,7*86400),window('codex_bengalfox/5h',100,5*3600),window('codex_bengalfox/7d',100,7*86400)]),
account('d','Codex Account 2','codex',[window('43200m',100,30*86400)])],
sessions:[{id:'s',name:'Demo · claude 83fe4',provider:'claude',accountName:'Claude Account 1',model:'claude-fable-5-1',effort:'high',modelSource:'last response',status:'idle',integrated:true,auto:false,threshold:10,cwd:'C:/Projects/Demo'},{id:'t',name:'Demo · codex a0926',provider:'codex',accountName:'Codex Account 1',model:'gpt-6-astra',effort:'xhigh',status:'idle',integrated:true,auto:true,threshold:10,cwd:'C:/Projects/Demo'}],
externalSessions:[{name:'Workspace review',provider:'claude',accountName:'Claude Account 1',status:'busy',cwd:'C:/Projects/Workspace',model:'claude-fable-5-1',effort:'high',modelSource:'last response'},{name:'Build multi-account usage switcher',provider:'codex',accountName:'Codex Account 1',status:'open',model:'gpt-6-astra',effort:'xhigh'}],externalProcesses:[{},{}]};
fs.mkdirSync('artifacts',{recursive:true});
for(const compact of [false,true])fs.writeFileSync('artifacts/dashboard'+(compact?'-compact':'')+'-frame.json',JSON.stringify({columns:180,rows:48,...premiumFrame(state,{columns:180,rows:48,compact,now})}));
