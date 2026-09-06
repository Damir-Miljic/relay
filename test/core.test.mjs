import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,threshold,safeText} from '../src/storage.mjs';
import {codexUsage,claudeUsage,claudeRateEvent,headroom,chooseAccount} from '../src/quota.mjs';
import {Engine} from '../src/engine.mjs';
import {accountEnv} from '../src/process.mjs';
import {transferHistory} from '../src/providers.mjs';
const settings={staleSeconds:180,threshold:10,cooldownSeconds:60};
function fresh(id,left){return {id,name:id,provider:'claude',auth:'ready',enabled:true,usage:{windows:[{id:'five_hour',label:'5h',remaining:left,resetsAt:Date.now()/1000+3600,observedAt:Date.now()}]}};}
function setup(t,deps={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root),a=store.add('claude','Personal'),b=store.add('claude','Backup');
 Object.assign(a,fresh(a.id,80),{name:'Personal'});Object.assign(b,fresh(b.id,90),{name:'Backup'});store.save();
 return {root,store,engine:new Engine(store,deps),a,b};
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(engine,id){for(let i=0;i<100;i++){if(!engine.runners.has(id))return;await delay(10);}throw new Error('Session did not settle');}
test('usage is remaining and worst window determines available capacity',()=>{
 const usage=codexUsage({rateLimitsByLimitId:{codex:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:Date.now()/1000+100},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:Date.now()/1000+100}}}});
 assert.equal(usage.windows[0].remaining,80);assert.equal(headroom({...fresh('a',80),usage},settings),0);
});
test('unknown, stale, invalid, failed and passed-reset usage is ineligible',()=>{
 const a=fresh('a',80);a.usage.windows=[];assert.equal(headroom(a,settings),null);
 for(const changes of [{observedAt:Date.now()-200000},{resetsAt:Date.now()/1000-1},{remaining:NaN}]){const b=fresh('b',80);Object.assign(b.usage.windows[0],changes);assert.equal(headroom(b,settings),null);}
 const c=fresh('c',80);c.usage.error='failed';assert.equal(headroom(c,settings),null);
});
test('Claude fraction and percentage normalize consistently without inventing null usage',()=>{
 const a=claudeUsage({five_hour:{utilization:93,resets_at:new Date(Date.now()+100000).toISOString()}});
 const b=claudeRateEvent({rate_limit_info:{rateLimitType:'five_hour',utilization:.93,resetsAt:Date.now()/1000+100}},{windows:[]});
 assert.equal(a.windows[0].remaining,7);assert.equal(b.windows[0].remaining,7);
 assert.equal(claudeUsage({five_hour:{utilization:null}}).windows.length,0);
});
test('candidates respect pool, provider, margin, disablement and current load',()=>{
 const s={id:'s',accountId:'a',provider:'claude',pool:['b','c'],threshold:10};
 const a=fresh('a',1),b=fresh('b',95),c=fresh('c',40),d={...fresh('d',99),provider:'codex'};
 assert.equal(chooseAccount(s,[a,b,c,d],[{id:'other',accountId:'b',status:'running'}],settings).id,'c');
 c.enabled=false;b.usage.windows[0].remaining=15;assert.equal(chooseAccount(s,[a,b,c,d],[],settings),null);
});
test('rename preserves account ID, home and saved session assignment',t=>{
 const {root,store,engine,a}=setup(t);engine.create({provider:'claude',account:a.id,cwd:root});
 const home=store.home(a);store.rename(a.id,'Work / primary');const loaded=new Store(root);
 assert.equal(loaded.account('Work / primary').id,a.id);assert.equal(loaded.state.sessions[0].accountId,a.id);assert.equal(loaded.home(loaded.account(a.id)),home);
 assert.throws(()=>store.rename(a.id,'Backup'),/already/);
});
test('threshold validation and terminal escape filtering',()=>{
 for(const n of ['bad',0,101,NaN,Infinity])assert.throws(()=>threshold(n));assert.equal(threshold('10'),10);assert.equal(threshold('75'),75);assert.equal(threshold('100'),100);
 assert.equal(safeText('\x1b[31mhello\x1b[0m\x07'),'hello');
});
test('account environment is specific to each child',()=>{
 const before={...process.env},a=accountEnv('claude','/a'),b=accountEnv('claude','/b');
 assert.equal(a.CLAUDE_CONFIG_DIR,'/a');assert.equal(b.CLAUDE_CONFIG_DIR,'/b');assert.deepEqual({...process.env},before);
});
test('routing one live session leaves the other running independently',async t=>{
 const calls=[],release=[];
 const {root,engine,a,b}=setup(t,{transfer:()=>{},runner:()=>({run:ctx=>{calls.push(ctx);return new Promise(r=>release.push(r));},stop:async()=>{}})});
 const one=engine.create({provider:'claude',account:a.id,name:'backend',cwd:root}),two=engine.create({provider:'claude',account:b.id,name:'frontend',cwd:root});
 engine.send(one.id,'work A');engine.send(two.id,'work B');engine.route(one.id,b.id);
 assert.equal(one.accountId,a.id);assert.equal(one.pending,b.id);assert.equal(two.pending,null);
 release[0]({});await settle(engine,one.id);assert.equal(one.accountId,b.id);assert.equal(two.status,'running');
 release[1]({});await settle(engine,two.id);assert.notEqual(calls[0].home,calls[1].home);
});
test('pinned session never automatically switches',t=>{
 const {root,engine,a}=setup(t);a.usage.windows[0].remaining=1;
 const s=engine.create({provider:'claude',account:a.id,cwd:root});engine.evaluate();assert.equal(s.accountId,a.id);assert.equal(s.pending,null);
});
test('automatic checkpoint continues the same native conversation on another account',async t=>{
 let count=0;const prompts=[];
 const {root,engine,a,b}=setup(t,{transfer:()=>{},runner:()=>({async run(ctx){count++;prompts.push(ctx.prompt);ctx.session.nativeId='native-thread';
 if(count===1){ctx.usage(old=>({...old,windows:old.windows.map(w=>({...w,remaining:5}))}));assert.equal(ctx.shouldYield(),true);return {yielded:true};}return {};},stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root,auto:true});engine.send(s.id,'Complete feature');await settle(engine,s.id);
 assert.equal(s.accountId,b.id);assert.equal(s.nativeId,'native-thread');assert.equal(count,2);assert.match(prompts[1],/saved conversation/);assert.equal(s.status,'idle');
});
test('failed handover keeps original route and native ID',t=>{
 const {root,engine,a,b}=setup(t,{transfer:()=>{throw new Error('missing transcript');}});
 const s=engine.create({provider:'claude',account:a.id,cwd:root});s.nativeId='abc';
 assert.throws(()=>engine.route(s.id,b.id),/missing/);assert.equal(s.accountId,a.id);assert.equal(s.nativeId,'abc');
});
test('same-session concurrent prompts are rejected',async t=>{
 let release;const {root,engine,a}=setup(t,{runner:()=>({run:()=>new Promise(r=>release=r),stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root});engine.send(s.id,'one');assert.throws(()=>engine.send(s.id,'two'),/already/);release({});await settle(engine,s.id);
});
test('permission request remains pending until the user decides',async t=>{
 let answer;const {root,engine,a}=setup(t,{runner:()=>({async run(ctx){answer=await ctx.ask({kind:'approval',title:'Write'});return {};},stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root});engine.send(s.id,'work');await delay(5);
 assert.equal(s.status,'waiting');assert.equal(answer,undefined);engine.answer(engine.snapshot().approvals[0].id,{allow:false});await settle(engine,s.id);assert.equal(answer.allow,false);
});
test('history transfer copies selected conversation and sidecars only',t=>{
 const {store,a,b}=setup(t),from=path.join(store.home(a),'projects','relay');fs.mkdirSync(path.join(from,'abc'),{recursive:true});
 fs.writeFileSync(path.join(from,'abc.jsonl'),'conversation');fs.writeFileSync(path.join(from,'other.jsonl'),'unrelated');fs.writeFileSync(path.join(from,'abc','child.jsonl'),'child');
 transferHistory({provider:'claude',nativeId:'abc'},store.home(a),store.home(b));
 assert.equal(fs.readFileSync(path.join(store.home(b),'projects','relay','abc.jsonl'),'utf8'),'conversation');
 assert.ok(!fs.existsSync(path.join(store.home(b),'projects','relay','other.jsonl')));
 assert.equal(fs.readFileSync(path.join(store.home(b),'projects','relay','abc','child.jsonl'),'utf8'),'child');
});
test('restart marks interrupted sessions paused without replaying them',t=>{
 const {root,store,engine,a}=setup(t);const s=engine.create({provider:'claude',account:a.id,cwd:root});s.status='running';store.save();
 const next=new Engine(new Store(root));assert.equal(next.state.sessions[0].status,'paused');assert.equal(next.runners.size,0);
});


test('automatic destination is revalidated at the handover boundary',async t=>{
 let release;
 const {root,engine,a,b}=setup(t,{transfer:()=>{},runner:()=>({run:()=>new Promise(r=>release=r),stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root,auto:true});
 engine.send(s.id,'work');a.usage.windows[0].remaining=2;engine.evaluate();assert.equal(s.pending,b.id);
 b.usage.windows[0].remaining=1;release({yielded:true});await settle(engine,s.id);
 assert.equal(s.accountId,a.id);assert.equal(s.status,'paused');assert.match(s.error,/no longer eligible/);
});
test('cancelling an in-flight automatic handover continues on the pinned account',async t=>{
 let release,count=0;
 const {root,engine,a,b}=setup(t,{transfer:()=>{},runner:()=>({run:ctx=>{count++;ctx.session.nativeId='native-thread';return count===1?new Promise(r=>release=r):Promise.resolve({});},stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root,auto:true});
 engine.send(s.id,'work');engine.route(s.id,b.id,'automatic');engine.configure(s.id,{auto:false});release({yielded:true});
 await settle(engine,s.id);assert.equal(s.accountId,a.id);assert.equal(s.status,'idle');assert.equal(count,2);
});
test('stopping with pending permissions preserves paused status',async t=>{
 let release;
 const {root,engine,a}=setup(t,{runner:()=>({async run(ctx){void ctx.ask({kind:'approval',title:'write'});return new Promise(r=>release=r);},stop:async()=>release({cancelled:true})})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root});engine.send(s.id,'work');
 assert.equal(s.status,'waiting');await engine.stop(s.id);await settle(engine,s.id);
 assert.equal(s.status,'paused');assert.equal(engine.approvals.size,0);
});
test('one permission answer leaves other requests waiting',async t=>{
 let release;
 const {root,engine,a}=setup(t,{runner:()=>({async run(ctx){await Promise.all([ctx.ask({kind:'approval',title:'one'}),ctx.ask({kind:'approval',title:'two'})]);return {};},stop:async()=>{}})});
 const s=engine.create({provider:'claude',account:a.id,cwd:root});engine.send(s.id,'work');
 const requests=engine.snapshot().approvals;engine.answer(requests[0].id,{allow:false});assert.equal(s.status,'waiting');
 engine.answer(requests[1].id,{allow:false});await settle(engine,s.id);assert.equal(s.status,'idle');
});
test('history transfer refuses destination directory links',t=>{
 const {root,store,a,b}=setup(t);
 const from=path.join(store.home(a),'projects','relay');fs.mkdirSync(from,{recursive:true});fs.writeFileSync(path.join(from,'abc.jsonl'),'conversation');
 const outside=path.join(root,'outside');fs.mkdirSync(outside);
 fs.symlinkSync(outside,path.join(store.home(b),'projects'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>transferHistory({provider:'claude',nativeId:'abc'},store.home(a),store.home(b)),/linked/);
 assert.deepEqual(fs.readdirSync(outside),[]);
});
test('missing observation timestamp cannot qualify an account',()=>{
 const a=fresh('a',90);delete a.usage.windows[0].observedAt;assert.equal(headroom(a,settings),null);
});
