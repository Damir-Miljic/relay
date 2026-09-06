import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexRunner,ClaudeRunner} from '../src/providers.mjs';
function context(){return {session:{id:'relay-id',nativeId:'native-id',cwd:process.cwd()},home:process.cwd(),prompt:'work',emit:()=>{},usage:fn=>fn({windows:[]}),ask:async()=>({allow:false}),shouldYield:()=>false,save:()=>{}};}
class FakeRPC extends EventEmitter{
 constructor(){super();this.calls=[];this.responses=[];}
 async initialize(){}
 send(value){this.responses.push(value);}
 async close(){this.closed=true;}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/resume' || method==='thread/start')return {thread:{id:'native-id'}};
  if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:20}}};
  if(method==='turn/start'){this.emit('notification',{method:'turn/started',params:{threadId:'native-id',turn:{id:'turn-id'}}});return {turn:{id:'turn-id'}};}
  if(method==='turn/interrupt'){this.emit('notification',{method:'turn/completed',params:{threadId:'native-id',turn:{id:'turn-id',status:'interrupted'}}});return {};}
 }
}
const flush=()=>new Promise(r=>setImmediate(r));
test('Codex handover waits for observed tool completion and resumes after native interrupt',async()=>{
 const rpc=new FakeRPC(),runner=new CodexRunner(()=>rpc),ctx=context();
 const running=runner.run(ctx);await flush();
 rpc.emit('notification',{method:'item/started',params:{threadId:'native-id',item:{id:'tool',type:'commandExecution'}}});
 runner.requestHandover();assert.ok(!rpc.calls.some(c=>c.method==='turn/interrupt'));
 rpc.emit('notification',{method:'item/completed',params:{threadId:'native-id',item:{id:'tool',type:'commandExecution'}}});
 const result=await running;assert.equal(result.yielded,true);assert.equal(result.cancelled,false);
 assert.deepEqual(rpc.calls.find(c=>c.method==='turn/interrupt').params,{threadId:'native-id',turnId:'turn-id'});assert.equal(rpc.closed,true);
});
test('Codex user stop uses exact native thread and turn IDs',async()=>{
 const rpc=new FakeRPC(),runner=new CodexRunner(()=>rpc);const running=runner.run(context());await flush();await runner.stop();
 const result=await running;assert.equal(result.cancelled,true);assert.equal(result.yielded,false);
 assert.equal(rpc.calls.find(c=>c.method==='turn/interrupt').params.threadId,'native-id');
});
test('Codex tool permission is not auto-approved',async()=>{
 const rpc=new FakeRPC(),runner=new CodexRunner(()=>rpc);const running=runner.run(context());await flush();
 rpc.emit('request',{id:99,method:'item/commandExecution/requestApproval',params:{command:'write'}});await flush();
 assert.equal(rpc.responses[0].result.decision,'decline');
 rpc.emit('notification',{method:'turn/completed',params:{threadId:'native-id',turn:{status:'completed'}}});await running;
});
test('Claude handover is blocked while background tasks run',async()=>{
 const decisions=[];let closed=false;
 const makeQuery=({options})=>({
  async *[Symbol.asyncIterator](){
   yield {type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'bg',task_type:'agent'}]};
   decisions.push(await options.hooks.PostToolBatch[0].hooks[0]({}));
   yield {type:'system',subtype:'background_tasks_changed',tasks:[]};
   decisions.push(await options.hooks.PostToolBatch[0].hooks[0]({}));
   yield {type:'result',is_error:false};
  },close(){closed=true;}
 });
 const ctx=context();ctx.shouldYield=()=>true;
 const result=await new ClaudeRunner(makeQuery,()=>({})).run(ctx);
 assert.deepEqual(decisions[0],{});assert.equal(decisions[1].continue,false);assert.equal(result.yielded,true);assert.equal(closed,true);
});


test('Codex stop during initialization prevents a new turn',async()=>{
 const rpc=new FakeRPC();let initialized;
 rpc.initialize=()=>new Promise(r=>initialized=r);
 const runner=new CodexRunner(()=>rpc),running=runner.run(context());
 await runner.stop();initialized();const result=await running;
 assert.equal(result.cancelled,true);assert.ok(!rpc.calls.some(c=>c.method==='turn/start'));
});
test('Codex cancels a queued handover before interrupt is sent',async()=>{
 const rpc=new FakeRPC(),runner=new CodexRunner(()=>rpc),running=runner.run(context());await flush();
 rpc.emit('notification',{method:'item/started',params:{threadId:'native-id',item:{id:'tool',type:'commandExecution'}}});
 runner.requestHandover();runner.cancelHandover();
 rpc.emit('notification',{method:'item/completed',params:{threadId:'native-id',item:{id:'tool'}}});
 assert.ok(!rpc.calls.some(c=>c.method==='turn/interrupt'));
 rpc.emit('notification',{method:'turn/completed',params:{threadId:'native-id',turn:{status:'completed'}}});
 assert.equal((await running).yielded,false);
});
