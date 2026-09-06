import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {Store} from '../src/storage.mjs';
import {NativeHub} from '../src/native-hub.mjs';
import {ClaudeBoundary,resumeOptions,mergedSettings} from '../src/native-claude.mjs';
import {CodexControl,codexBridge} from '../src/native-codex.mjs';
import {eligible} from '../src/native-common.mjs';
import {replaceBlock} from '../src/integration.mjs';
const fresh=(a,left,now)=>Object.assign(a,{auth:'ready',usage:{windows:[{remaining:left,observedAt:now,resetsAt:now/1000+1000}]}});
function hubFixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);let now=Date.now();const a=fresh(store.add('claude','Primary'),80,now),b=fresh(store.add('claude','Backup'),90,now);const hub=new NativeHub(store,{now:()=>now,isAlive:()=>true});return {store,a,b,hub,advance:n=>now+=n,now:()=>now};}
test('native routing changes one terminal only after the supervisor confirms application',t=>{
  const {hub,a,b}=hubFixture(t);const x=hub.register({provider:'claude',pid:100,cwd:'repo'}).session,y=hub.register({provider:'claude',pid:101,cwd:'repo'}).session;
  const queued=hub.route(x.id,b.id);assert.equal(queued.accountId,a.id);assert.equal(queued.pending,b.id);assert.equal(queued.auto,false);
  hub.heartbeat({session:x.id,pid:100,applied:{accountId:b.id,commandId:queued.commandId}});
  assert.equal(hub.find(x.id).accountId,b.id);assert.equal(hub.find(y.id).accountId,a.id);
});
test('native automatic routing respects fresh quota, cooldown, pinning and stale leases',t=>{
  const {hub,a,b,store,now,advance}=hubFixture(t);const x=hub.register({provider:'claude',pid:100,cwd:'repo'}).session;
  fresh(a,3,now());let state=hub.heartbeat({session:x.id,pid:100,status:'busy'});assert.equal(state.target.id,b.id);
  hub.configure(x.id,{auto:false});assert.equal(hub.find(x.id).pending,null);
  hub.configure(x.id,{auto:true});b.usage.windows[0].observedAt=now()-500000;state=hub.heartbeat({session:x.id,pid:100});assert.equal(state.target,null);
  advance(21000);assert.equal(hub.snapshot().length,0);assert.throws(()=>hub.route(x.id,a.id),/no longer/);
});
test('a later manual route is preserved when a previous route finishes',t=>{
  const {hub,a,b}=hubFixture(t);const x=hub.register({provider:'claude',pid:100,cwd:'repo'}).session;const first=hub.route(x.id,b.id);hub.route(x.id,a.id);
  hub.heartbeat({session:x.id,pid:100,applied:{accountId:b.id,commandId:first.commandId}});
  assert.equal(hub.find(x.id).accountId,b.id);
  // Cancellation before a command is applied cannot pretend the runtime stayed on the old account.
  assert.notEqual(hub.find(x.id).commandId,first.commandId);assert.equal(hub.find(x.id).pending,a.id);
});
test('Claude resumes preserve flags and discard only the original prompt and resume selector',()=>{
  assert.deepEqual(resumeOptions(['--model','fable','--permission-mode','default','--resume','id','Initial task']),['--model','fable','--permission-mode','default']);
  assert.deepEqual(resumeOptions(['--disallowedTools','Bash(rm *)','Write','--model','fable','Initial prompt']),['--disallowedTools','Bash(rm *)','Write','--model','fable']);
  assert.deepEqual(resumeOptions(['--debug','--model','fable','Initial prompt']),['--debug','--model','fable']);
  assert.throws(()=>resumeOptions(['--future-unknown','value']),/not yet supported/);
  assert.equal(eligible('claude',['--print','x'],true),false);assert.equal(eligible('codex',['app-server'],true),false);assert.equal(eligible('codex',['-p','work'],true),true);
});
test('Claude only yields completed local tool batches and explicit empty background lists',()=>{
  const b=new ClaudeBoundary(),send=(event,rest={})=>b.observe({event,sessionId:'s',...rest});send('SessionStart',{source:'startup'});assert.equal(b.safeIdle,true);
  send('UserPromptSubmit');send('PreToolUse',{tool:'Read'});assert.equal(send('PostToolBatch',{tools:['Read']}),true);
  send('PreToolUse',{tool:'Bash'});assert.equal(send('PostToolBatch',{tools:['Read']}),false);
  assert.equal(send('Stop',{backgroundCount:null,cronCount:0}),false);assert.equal(send('Stop',{backgroundCount:1,cronCount:0}),false);assert.equal(send('Stop',{backgroundCount:0,cronCount:1}),false);assert.equal(send('Stop',{backgroundCount:0,cronCount:0}),true);
  assert.equal(b.observe({event:'SessionStart',sessionId:'other'}),false);assert.equal(b.nativeId,'s');
});
test('adding Relay hooks preserves native permission settings and existing hooks',()=>{
  const original={permissions:{deny:['Bash(rm *)']},hooks:{Stop:[{hooks:[{type:'command',command:'existing'}]}]}};
  const merged=mergedSettings(original,{forceLoginMethod:'claudeai'},'relay-hook');assert.deepEqual(merged.permissions,original.permissions);assert.equal(merged.hooks.Stop.length,2);assert.equal(original.hooks.Stop.length,1);
});
test('shell integration installs idempotently and uninstalls without removing user content',()=>{
  const user='function custom { "keep me" }\n';const once=replaceBlock(user,'function claude {}');assert.equal(replaceBlock(once,'function claude {}'),once);assert.match(replaceBlock(once,null),/function custom/);assert.doesNotMatch(replaceBlock(once,null),/function claude/);assert.throws(()=>replaceBlock('# >>> Relay native integration >>>','x'),/Incomplete/);
});
class FakeRPC extends EventEmitter{
  constructor(){super();this.calls=[];this.sent=[];}
  send(value){this.sent.push(value);}
  async request(method,params){this.calls.push({method,params});if(method==='initialize')return {userAgent:'native-test'};if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='turn/interrupt')this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}});return {};}
}
test('Codex account control waits for tools, passes native permissions through, and resumes one interrupted turn',async()=>{
  const rpc=new FakeRPC(),control=new CodexControl(rpc,{tokens:async()=>({accessToken:'secret',chatgptAccountId:'account-b'})});rpc.on('notification',m=>control.observe(m));control.currentHome='a';control.currentTokens={accessToken:'old',chatgptAccountId:'account-a'};
  control.observe({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});control.activeItems.add('tool');assert.equal(await control.route({home:'b'}),false);assert.equal(rpc.calls.length,0);control.activeItems.clear();
  assert.equal(await control.route({home:'b'}),true);assert.deepEqual(rpc.calls.map(x=>x.method),['turn/interrupt','account/login/start','account/read','turn/start']);assert.equal(rpc.calls.at(-1).params.threadId,'thread');
});
test('Codex cancellation before switching never interrupts native work',async()=>{
  const rpc=new FakeRPC(),control=new CodexControl(rpc,{tokens:async()=>({accessToken:'secret'})});assert.equal(await control.route({home:'b'},()=>false),false);assert.equal(rpc.calls.length,0);
  control.background.add('process');assert.equal(await control.route({home:'b'}),false);assert.equal(rpc.calls.length,0);
});
test('Codex websocket requires bearer auth, forwards approval requests, and never auto-approves',async t=>{
  const rpc=new FakeRPC(),control=new CodexControl(rpc);const bridge=await codexBridge(rpc,control);t.after(()=>bridge.close());
  const rejected=new WebSocket(bridge.url);await new Promise(resolve=>rejected.once('error',resolve));
  const client=new WebSocket(bridge.url,{headers:{Authorization:'Bearer '+bridge.token}});t.after(()=>client.terminate());await new Promise(resolve=>client.once('open',resolve));
  const received=new Promise(resolve=>client.once('message',raw=>resolve(JSON.parse(raw))));rpc.emit('request',{id:88,method:'item/commandExecution/requestApproval',params:{command:'test'}});assert.equal((await received).id,88);assert.equal(rpc.sent.some(x=>x.id===88),false);
  client.send(JSON.stringify({id:88,result:{decision:'decline'}}));await new Promise(r=>setTimeout(r,20));assert.equal(rpc.sent.find(x=>x.id===88).result.decision,'decline');
});

test('Claude may yield after verified foreground shell completion; background risk survives later prompts',()=>{
 const b=new ClaudeBoundary(),send=(event,rest={})=>b.observe({event,sessionId:'s',...rest});send('SessionStart',{source:'startup'});send('UserPromptSubmit');send('PreToolUse',{tool:'Bash',toolId:'t'});assert.equal(send('PostToolBatch',{tools:['Bash']}),false);send('PostToolUse',{tool:'Bash',toolId:'t',shellCompleted:true});assert.equal(send('PostToolBatch',{tools:['Bash']}),true);
 send('PreToolUse',{tool:'Bash',toolId:'bg'});send('PostToolUse',{tool:'Bash',toolId:'bg',shellCompleted:false});send('UserPromptSubmit');assert.equal(send('PostToolBatch',{tools:['Read']}),false);send('Stop',{backgroundCount:0,cronCount:0});send('UserPromptSubmit');assert.equal(send('PostToolBatch',{tools:['Read']}),true);
});


test('Codex idle lifecycle clears completed tools and server-resolved requests',async()=>{
 const rpc=new FakeRPC(),c=new CodexControl(rpc,{tokens:async()=>({accessToken:'test'})});
 c.observe({method:'turn/started',params:{threadId:'root',turn:{id:'one'}}});
 c.observe({method:'item/started',params:{threadId:'root',turnId:'one',item:{id:'tool',type:'mcpToolCall'}}});
 c.requests.add(9);assert.equal(c.canSwitch(),false);
 c.observe({method:'thread/status/changed',params:{threadId:'root',status:{type:'idle'}}});
 assert.equal(c.status,'idle');assert.equal(c.activeItems.size,0);assert.equal(c.canSwitch(),false);
 c.observe({method:'serverRequest/resolved',params:{threadId:'root',requestId:9}});
 assert.equal(await c.route({home:'second'}),true);
 assert.deepEqual(rpc.calls.map(x=>x.method),['account/login/start','account/read']);
});

test('Codex auth rebind preserves an idle background terminal and waits during active work',async()=>{
 const rpc=new FakeRPC(),c=new CodexControl(rpc,{tokens:async()=>({accessToken:'test'})});
 c.observe({method:'turn/started',params:{threadId:'root',turn:{id:'one'}}});
 c.observe({method:'item/completed',params:{threadId:'root',turnId:'one',item:{id:'shell',type:'commandExecution',processId:'bg',exitCode:null,status:'completed'}}});
 assert.equal(await c.route({home:'second'}),false);
 c.observe({method:'turn/completed',params:{threadId:'root',turn:{id:'one',status:'completed'}}});
 assert.equal(await c.route({home:'second'}),true);assert.equal(c.background.has('bg'),true);
 assert.deepEqual(rpc.calls.map(x=>x.method),['account/login/start','account/read']);
});

test('Codex completed child agents never replace the terminal thread',()=>{
 const c=new CodexControl(new FakeRPC());
 c.observe({method:'thread/started',params:{thread:{id:'root'}}});
 c.observe({method:'thread/started',params:{thread:{id:'child',parentThreadId:'root'}}});
 c.observe({method:'turn/started',params:{threadId:'child',turn:{id:'first'}}});
 c.observe({method:'turn/completed',params:{threadId:'child',turn:{id:'first',status:'completed'}}});
 assert.equal(c.canSwitch(),true);
 c.observe({method:'turn/started',params:{threadId:'child',turn:{id:'second'}}});
 assert.equal(c.threadId,'root');assert.equal(c.canSwitch(),false);
 c.observe({method:'thread/status/changed',params:{threadId:'child',status:{type:'idle'}}});assert.equal(c.canSwitch(),true);
});

test('Codex reconciles a missed completion but never clears a newer active turn',async()=>{
 const rpc=new FakeRPC(),c=new CodexControl(rpc);
 const start=id=>c.observe({method:'turn/started',params:{threadId:'root',turn:{id}}});start('one');
 c.observe({method:'item/started',params:{threadId:'root',turnId:'one',item:{id:'tool',type:'commandExecution'}}});
 rpc.request=async()=>({thread:{id:'root',status:{type:'idle'},turns:[{id:'one',status:'completed'}]}});
 await c.reconcile();assert.equal(c.status,'idle');assert.equal(c.canSwitch(),true);
 start('two');rpc.request=async()=>{start('three');return {thread:{id:'root',status:{type:'idle'},turns:[{id:'two',status:'completed'}]}};};
 await c.reconcile();assert.equal(c.status,'busy');assert.equal(c.threads.get('root'),'three');
});

test('native default thresholds over 50 apply to new sessions and full accounts do not rotate endlessly',t=>{
 const {hub,a,b,store,now}=hubFixture(t);store.state.settings.threshold=100;
 const x=hub.register({provider:'claude',pid:100,cwd:'repo'}).session;assert.equal(x.threshold,100);
 fresh(a,98,now());fresh(b,100,now());const route=hub.heartbeat({session:x.id,pid:100,status:'idle'});assert.equal(route.target.id,b.id);
 fresh(a,100,now());fresh(b,100,now());hub.configure(x.id,{auto:false});hub.configure(x.id,{auto:true});assert.equal(hub.heartbeat({session:x.id,pid:100}).target,null);
});


test('queued routes record their start time and agent waits identify the blocker',t=>{
 const {hub,a,b,now}=hubFixture(t),x=hub.register({provider:'claude',pid:100,cwd:'repo'}).session;
 assert.equal(hub.route(x.id,b.id).pendingSince,now());assert.equal(hub.route(x.id,a.id).pendingSince,null);
 const c=new CodexControl(new FakeRPC());c.observe({method:'thread/started',params:{thread:{id:'root'}}});
 c.observe({method:'thread/started',params:{thread:{id:'child',parentThreadId:'root',agentNickname:'Curie'}}});assert.match(c.boundary(),/agent Curie/);
 c.observe({method:'thread/name/updated',params:{threadId:'child',threadName:'CSS review'}});assert.match(c.boundary(),/CSS review/);
 c.observe({method:'thread/status/changed',params:{threadId:'child',status:{type:'idle'}}});assert.equal(c.boundary(),'Ready to switch.');
});

test('Codex remote TUI creates resumable threads and acknowledges a submitted draft',async t=>{
 const rpc=new FakeRPC(),control=new CodexControl(rpc);let submitted=0;
 rpc.request=async(method,params)=>{rpc.calls.push({method,params});if(method==='initialize')return {};if(method==='thread/start')return {thread:{id:'saved-thread'}};return {};};
 const bridge=await codexBridge(rpc,control,{onSubmit:()=>submitted++});t.after(()=>bridge.close());
 const client=new WebSocket(bridge.url,{headers:{Authorization:'Bearer '+bridge.token}});t.after(()=>client.terminate());await new Promise(r=>client.once('open',r));
 const send=async message=>{const result=new Promise(r=>client.once('message',data=>r(JSON.parse(data))));client.send(JSON.stringify(message));return result;};
 await send({id:1,method:'thread/start',params:{ephemeral:false,cwd:'project'}});
 assert.equal(rpc.calls.find(c=>c.method==='thread/start').params.ephemeral,false);
 await send({id:2,method:'turn/start',params:{threadId:'saved-thread',input:[]}});assert.equal(submitted,1);
 assert.equal(eligible('codex',['--ephemeral'],true),false);
});


test('Codex title helpers never replace the visible conversation or require ephemeral turn export',async()=>{
 const rpc=new FakeRPC(),c=new CodexControl(rpc);
 c.observe({method:'thread/started',params:{thread:{id:'visible',ephemeral:false}}});
 c.observe({method:'thread/started',params:{thread:{id:'title-helper',ephemeral:true,threadSource:'system'}}});
 c.observe({method:'turn/started',params:{threadId:'title-helper',turn:{id:'title-turn'}}});
 assert.equal(c.threadId,'visible');assert.equal(c.canSwitch(),false);
 rpc.request=async(method,params)=>{if(params.threadId==='title-helper')assert.equal(params.includeTurns,false);return {thread:{id:params.threadId,status:{type:'idle'},turns:[]}};};
 await c.reconcile();assert.equal(c.threadId,'visible');assert.equal(c.canSwitch(),true);
});
