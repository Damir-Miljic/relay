
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/storage.mjs';import {NativeHub} from '../src/native-hub.mjs';import {CodexControl} from '../src/native-codex.mjs';
import {claudeExcerpt,codexExcerpts,writeHandoff,readClaudeExcerpts,requestCodexExit} from '../src/handoff.mjs';import {superviseNative} from '../src/native-supervisor.mjs';
function fixture(t,provider='claude',protocol=1){
 // macOS exposes its temporary directory through /var -> /private/var.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'relay-handoff-unit-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root),now=Date.now(),add=(p,n,left)=>Object.assign(store.add(p,n),{auth:'ready',usage:{windows:[{remaining:left,observedAt:now,resetsAt:now/1000+10000}]}});
 const a=add('claude','Claude',4),b=add('codex','Codex',90),hub=new NativeHub(store,{now:()=>now,isAlive:()=>true});
 const s=hub.register({provider,protocol,pid:100,cwd:root}).session;
 return {root,store,a,b,hub,s};
}
for(const provider of ['claude','codex'])test(provider+' handoff updates the actual provider only after a matching committed acknowledgement',t=>{
 const {hub,s,a,b}=fixture(t,provider),target=provider==='claude'?b:a;
 const route=hub.route(s.id,target.id);assert.equal(route.provider,provider);assert.equal(route.canCancel,true);assert.equal(hub.reply(hub.find(s.id)).target.provider,target.provider);
 assert.throws(()=>hub.heartbeat({session:s.id,pid:100,applied:{accountId:target.id,commandId:route.commandId}}),/committed/);
 assert.equal(hub.commit({session:s.id,pid:100,commandId:route.commandId}).committed,true);
 assert.equal(hub.view(hub.find(s.id)).canCancel,false);assert.throws(()=>hub.cancel(s.id),/already started/);
 assert.throws(()=>hub.route(s.id,s.accountId),/started/);
 const ack={session:s.id,pid:100,nativeId:'new-thread',applied:{accountId:target.id,commandId:route.commandId}};
 const result=hub.heartbeat(ack).session;assert.equal(result.provider,target.provider);assert.equal(result.accountId,target.id);assert.equal(result.pending,null);assert.equal(result.nativeId,'new-thread');
 assert.equal(hub.heartbeat(ack).session.accountId,target.id);
});
test('cancellation invalidates a stale commit and leaves the session pinned on its current account',t=>{
 const {hub,s,b,a}=fixture(t);const q=hub.route(s.id,b.id);
 hub.cancel(s.id,q.commandId);assert.equal(hub.commit({session:s.id,pid:100,commandId:q.commandId}).committed,false);
 const current=hub.find(s.id);assert.equal(current.accountId,a.id);assert.equal(current.pending,null);assert.equal(current.auto,false);
 assert.throws(()=>hub.heartbeat({session:s.id,pid:100,applied:{accountId:b.id,commandId:q.commandId}}),/committed/);
});
test('stale cancellation cannot cancel a newer route and wrong supervisors cannot commit',t=>{
 const {hub,s,b,a}=fixture(t);const old=hub.route(s.id,b.id);hub.cancel(s.id,old.commandId);const next=hub.route(s.id,b.id);
 assert.throws(()=>hub.cancel(s.id,old.commandId),/changed/);assert.equal(hub.find(s.id).pending,b.id);
 assert.throws(()=>hub.commit({session:s.id,pid:101,commandId:next.commandId}),/Reopen/);
});
test('automatic provider fallback is opt-in, respects pinning and pools, and prefers same-provider accounts',t=>{
 const {hub,s,store,a,b}=fixture(t);assert.equal(store.state.settings.crossProviderAuto,false);assert.equal(hub.heartbeat({session:s.id,pid:100}).target,null);
 store.state.settings.crossProviderAuto=true;assert.equal(hub.heartbeat({session:s.id,pid:100}).target.id,b.id);
 store.state.settings.crossProviderAuto=false;assert.equal(hub.heartbeat({session:s.id,pid:100}).target,null);
 store.state.settings.crossProviderAuto=true;hub.configure(s.id,{auto:false});assert.equal(hub.heartbeat({session:s.id,pid:100}).target,null);
 hub.configure(s.id,{auto:true,pool:[a.id]});assert.equal(hub.heartbeat({session:s.id,pid:100}).target,null);
 const backup=Object.assign(store.add('claude','Claude spare'),{auth:'ready',usage:b.usage});
 hub.configure(s.id,{pool:[]});assert.equal(hub.heartbeat({session:s.id,pid:100}).target.id,backup.id);
});
test('older wrappers cannot receive cross-provider commands even with automatic fallback enabled',t=>{
 const {hub,s,store,b}=fixture(t,'claude',0);store.state.settings.crossProviderAuto=true;
 assert.equal(s.canHandoff,false);assert.throws(()=>hub.route(s.id,b.id),/Reopen/);assert.equal(hub.heartbeat({session:s.id,pid:100}).target,null);
});
test('background Codex processes allow auth rebind but block a provider handoff',()=>{
 const c=new CodexControl({});c.status='idle';c.threadId='root';c.background.add('server');assert.equal(c.canSwitch(),true);assert.match(c.handoffBoundary(),/background/);
 c.background.clear();c.requests.add(10);assert.match(c.handoffBoundary(),/permission/);
 c.requests.clear();c.status='busy';assert.match(c.handoffBoundary(),/current turn/);
 c.status='idle';assert.equal(c.handoffBoundary(),'Ready to switch.');
});
test('cancelled Codex commit never changes login or interrupts a turn',async()=>{
 const calls=[],c=new CodexControl({request:async m=>calls.push(m)},{tokens:async()=>({accessToken:'test'})});c.status='idle';
 assert.equal(await c.route({home:'b'},()=>true,async()=>false),false);assert.deepEqual(calls,[]);
});
test('handoff notes include bounded task context and exclude private thinking or unrelated native data',t=>{
 const {root,s,b}=fixture(t);
 const entries=[claudeExcerpt({type:'user',message:{content:'Keep marker ALPHA'}}),claudeExcerpt({type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text:'Finished the requested edits'},{type:'tool_use',name:'Read',input:{file_path:'app.js'}}]}})];
 assert.equal(claudeExcerpt({type:'system',apiKey:'SECRET',message:{content:'SYSTEM_SECRET'}}),null);
 entries.push(...Array.from({length:120},(_,i)=>({role:'assistant',text:('Step '+i+' ').repeat(300)})));
 const note=writeHandoff(root,s,b,entries),text=fs.readFileSync(note.file,'utf8');
 assert.match(text,/ALPHA/);assert.match(text,/Step 119/);assert.ok(text.length<48000);assert.doesNotMatch(text,/PRIVATE_THOUGHT|SECRET/);assert.match(note.prompt,/new native conversation/);
 const codex=codexExcerpts({turns:[{items:[{type:'reasoning',content:['PRIVATE_THOUGHT']},{type:'agentMessage',text:'Done'},{type:'userMessage',content:[{type:'text',text:'Task'}]}]}]});
 assert.deepEqual(codex.map(x=>x.text),['Done','Task']);
});
test('Claude handoff reads only the selected conversation',async t=>{
 const {root}=fixture(t),home=path.join(root,'profile'),project=path.join(home,'projects','repo');fs.mkdirSync(project,{recursive:true});
 fs.writeFileSync(path.join(project,'selected.jsonl'),JSON.stringify({type:'user',uuid:'one',message:{content:'SELECTED'}})+'\n');
 fs.writeFileSync(path.join(project,'unrelated.jsonl'),JSON.stringify({type:'user',message:{content:'UNRELATED'}}));
 const rows=await readClaudeExcerpts(home,'selected');assert.deepEqual(rows.map(r=>r.text),['SELECTED']);
 await assert.rejects(readClaudeExcerpts(home,'missing'),/identify/);
});
test('handoff refuses linked conversation directories and note destinations',async t=>{
 const {root,s,b}=fixture(t),home=path.join(root,'profile'),outside=path.join(root,'outside'),project=path.join(outside,'repo');
 fs.mkdirSync(home);fs.mkdirSync(project,{recursive:true});
 fs.writeFileSync(path.join(project,'selected.jsonl'),JSON.stringify({type:'user',message:{content:'PRIVATE_OUTSIDE_CONTEXT'}}));
 const linkType=process.platform==='win32'?'junction':'dir';
 fs.symlinkSync(outside,path.join(home,'projects'),linkType);
 await assert.rejects(readClaudeExcerpts(home,'selected'),/linked/);
 fs.symlinkSync(outside,path.join(root,'handoffs'),linkType);
 assert.throws(()=>writeHandoff(root,s,b,[{role:'user',text:'Task'}]),/linked/);
 assert.deepEqual(fs.readdirSync(outside),['repo']);
});
for(const from of ['claude','codex'])test('supervisor launches '+from+' handoff in same Relay session and rolls back on target startup failure',async t=>{
 const {root,s,a,b}=fixture(t,from),source=from==='claude'?a:b,target=from==='claude'?b:a;
 const registration={session:{...s,accountId:source.id},home:source.id},calls=[],runs=[];
 let step=0;
 const result=await superviseNative(async(op,args)=>{calls.push({op,args});return {};},registration,['original'],{
 root,loadRunner:async p=>async(api,reg,args,options)=>{
  runs.push({p,reg,args});
  if(step++===0)return {handoff:{target:{...target,commandId:'command'},note:{file:path.join(root,'note.md'),prompt:'Read handoff'},rollback:{registration,args:['resume','source-id']}}};
  if(step===2)throw new Error('Target unavailable');
  return 0;
 }});
 assert.equal(result,0);assert.deepEqual(runs.map(r=>r.p),[from,target.provider,from]);assert.equal(runs[1].reg.session.id,s.id);
 assert.deepEqual(runs[1].args,['Read handoff']);assert.deepEqual(runs[2].args,['resume','source-id']);assert.ok(calls.some(c=>c.args.error?.includes('Target unavailable')));
 assert.equal(calls.at(-1).args.status,'closed');
});


test("Codex exit sends one quit key and waits without a second write into a closing pipe",async()=>{
 const keys=[];await requestCodexExit({child:{write:key=>keys.push(key)},exited:Promise.resolve(0)},{wait:()=>new Promise(()=>{})});assert.deepEqual(keys,["\x04"]);
 await assert.rejects(requestCodexExit({child:{write:key=>keys.push(key)},exited:new Promise(()=>{})},{wait:async()=>{}}),/did not exit/);assert.equal(keys.length,2);
});

test("work starting during commit is never interrupted for an account switch",async()=>{
 const calls=[],c=new CodexControl({request:async method=>calls.push(method)},{tokens:async()=>({accessToken:"test"})});c.status="busy";c.threadId="root";c.threads.set("root","turn");
 await assert.rejects(c.route({home:"b"},()=>true,async()=>{c.activeItems.add("just-started");return true;}),/New work started/);assert.deepEqual(calls,[]);
});
