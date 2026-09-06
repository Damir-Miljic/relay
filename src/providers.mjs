import fs from 'node:fs';
import path from 'node:path';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {CodexRPC} from './rpc.mjs';
import {accountEnv, executable} from './process.mjs';
import {codexUsage, claudeUsage, claudeRateEvent} from './quota.mjs';
import {privateDir} from './storage.mjs';

export class InputQueue {
  constructor(){this.items=[];this.waiter=null;this.ended=false;}
  push(value){if(this.waiter){this.waiter({value,done:false});this.waiter=null;}else this.items.push(value);}
  end(){this.ended=true;if(this.waiter){this.waiter({done:true});this.waiter=null;}}
  [Symbol.asyncIterator](){return this;}
  next(){if(this.items.length)return Promise.resolve({value:this.items.shift(),done:false});if(this.ended)return Promise.resolve({done:true});return new Promise(r=>this.waiter=r);}
  return(){this.end();return Promise.resolve({done:true});}
}
function claudeOptions(home,cwd,command=executable('claude')) {
  return {cwd,env:accountEnv('claude',home),pathToClaudeCodeExecutable:command,
    settingSources:['user','project','local'],systemPrompt:{type:'preset',preset:'claude_code'},permissionMode:'default',stderr:()=>{}};
}
export async function probe(provider, home) {
  if(provider==='codex'){
    const rpc=new CodexRPC(home);
    try{
      await rpc.initialize();
      const identity=await rpc.request('account/read',{refreshToken:true});
      if(!identity.account || !['chatgpt','chatgptAuthTokens'].includes(identity.account.type)) throw new Error('A ChatGPT subscription login is required.');
      return {auth:'ready',usage:codexUsage(await rpc.request('account/rateLimits/read'))};
    }finally{await rpc.close();}
  }
  return probeClaude(home);
}
export async function probeClaude(home,{createQuery=query,command=executable('claude')}={}){
  const input=new InputQueue(),abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),25000);let q,drain;
  try{
    q=createQuery({prompt:input,options:{...claudeOptions(home,home,command),settingSources:[],tools:[],persistSession:false,abortController:abort}});
    drain=(async()=>{try{for await(const _ of q){}}catch{}})();
    const data=await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true});
    if(!data.rate_limits_available || !data.rate_limits){
      throw new Error(data.subscription_type
        ? 'Claude is signed in, but did not return subscription usage. Try Refresh; if this persists, check /usage in the native Claude terminal.'
        : 'Claude subscription usage is unavailable for this login. Use Login (L) for this named account and sign in with a Claude subscription. API-key or setup-token authentication may not expose usage.');
    }
    return {auth:'ready',usage:claudeUsage(data)};
  }finally{clearTimeout(timer);input.end();q?.close();await drain;}
}
function walk(dir) {
  if(!fs.existsSync(dir))return [];
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Refusing to traverse a linked history directory.');
  const output=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.isSymbolicLink())continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())output.push(...walk(full));else output.push(full);
  }
  return output;
}
function assertUnlinked(file){
  let cursor=path.resolve(file);
  for(;;){if(fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())throw new Error('Refusing a linked transcript path.');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
function copyTree(source,destination){
  assertUnlinked(source);assertUnlinked(destination);
  if(fs.lstatSync(source).isSymbolicLink())throw new Error('Refusing to copy a linked transcript.');
  if(fs.statSync(source).isDirectory()){
    privateDir(destination);
    for(const name of fs.readdirSync(source))copyTree(path.join(source,name),path.join(destination,name));
  }else{
    privateDir(path.dirname(destination));
    if(fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink())throw new Error('Refusing to replace a linked transcript.');
    fs.copyFileSync(source,destination);
    if(process.platform!=='win32')fs.chmodSync(destination,0o600);
  }
}
// Only this Relay session's transcripts move. Credentials, config and unrelated history never move.
export function transferHistory(session,sourceHome,targetHome){
  if(!session.nativeId || sourceHome===targetHome)return;
  if(!/^[a-zA-Z0-9-]+$/.test(session.nativeId))throw new Error('Invalid native session ID.');
  sourceHome=fs.realpathSync(sourceHome);targetHome=fs.realpathSync(targetHome);
  const section=session.provider==='claude'?'projects':'sessions';
  const base=path.join(sourceHome,section);
  assertUnlinked(base);assertUnlinked(path.join(targetHome,section));
  const files=walk(base).filter(file=>session.provider==='claude'?path.basename(file)===session.nativeId+'.jsonl':path.basename(file).endsWith('-'+session.nativeId+'.jsonl'));
  if(files.length!==1)throw new Error('Cannot safely locate the saved conversation; route was not changed.');
  const source=files[0],relative=path.relative(base,source);
  copyTree(source,path.join(targetHome,section,relative));
  if(session.provider==='claude'){
    const sidecar=path.join(path.dirname(source),session.nativeId);
    if(fs.existsSync(sidecar))copyTree(sidecar,path.join(targetHome,section,path.dirname(relative),session.nativeId));
  }
}
export class ClaudeRunner {
  constructor(createQuery=query,optionsFactory=claudeOptions){this.createQuery=createQuery;this.optionsFactory=optionsFactory;}
  async run({session,home,prompt,emit,usage,ask,shouldYield,save}){
    let yielded=false,quotaExhausted=false,resultSeen=false,error=null;
    let background=0;
    const boundary=async()=>{
      if(shouldYield() && background===0){yielded=true;return {continue:false,stopReason:'Relay account handover at a completed tool batch.'};}
      return {};
    };
    const q=this.createQuery({prompt,options:{
      ...this.optionsFactory(home,session.cwd),model:session.model || undefined,
      ...(session.nativeId?{resume:session.nativeId}:{sessionId:session.id}),
      canUseTool:async(name,input)=>{
        if(name==='AskUserQuestion'){
          const answers={};
          for(const question of input.questions || []){
            const reply=await ask({kind:'question',title:question.question,options:question.options?.map(o=>o.label)});
            answers[question.question]=String(reply.text || '');
          }
          return {behavior:'allow',updatedInput:{...input,answers}};
        }
        const reply=await ask({kind:'approval',title:name,details:input});
        return reply.allow?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'The user declined this operation.'};
      },
      hooks:{PostToolBatch:[{hooks:[boundary]}]},
    }});
    this.query=q;
    try{
      for await(const msg of q){
        if(msg.session_id && !session.nativeId){session.nativeId=msg.session_id;save();}
        if(msg.type==='rate_limit_event'){
          usage(previous=>claudeRateEvent(msg,previous));
          quotaExhausted=msg.rate_limit_info.status==='rejected';
        }
        if(msg.type==='assistant')for(const block of msg.message?.content || []){
          if(block.type==='text')emit('text',{text:block.text+'\n'});
          else if(block.type==='tool_use')emit('tool',{text:block.name});
        }
        if(msg.type==='system' && msg.subtype==='background_tasks_changed')background=msg.tasks?.length || 0;
        if(msg.type==='result'){
          resultSeen=true;
          if(msg.is_error)error=(msg.errors || ['Claude turn failed.']).join('\n');
        }
      }
      if(!resultSeen && !this.cancelled)throw new Error('Claude exited without a completed result. Resume manually to inspect the conversation.');
      return {yielded,quotaExhausted,error,cancelled:!!this.cancelled};
    }finally{q.close();this.query=null;}
  }
  async stop(){this.cancelled=true;if(this.query)await this.query.interrupt();}
}
export class CodexRunner {
  constructor(makeRPC=home=>new CodexRPC(home)){this.makeRPC=makeRPC;this.activeTools=new Set();this.children=new Set();}
  requestHandover(){this.handoverRequested=true;this.tryHandover();}
  cancelHandover(){this.handoverRequested=false;}
  tryHandover(){
    if(!this.handoverRequested || this.interrupting || this.cancelled || this.completed || !this.turnId || !this.rpc || this.activeTools.size || this.children.size)return;
    this.interrupting=true;
    this.rpc.request('turn/interrupt',{threadId:this.sessionId,turnId:this.turnId}).then(()=>{this.yielded=true;}).catch(()=>{this.interrupting=false;});
  }
  async run({session,home,prompt,emit,usage,ask,save}){
    const rpc=this.makeRPC(home);this.rpc=rpc;
    let complete,fail;
    const done=new Promise((r,j)=>{complete=r;fail=j;});
    // Attach immediately so exits and early turn notifications cannot be lost.
    done.catch(()=>{});
    rpc.on('closed',fail);
    rpc.on('request',async msg=>{
      try{
        if(msg.method==='item/commandExecution/requestApproval' || msg.method==='item/fileChange/requestApproval'){
          const answer=await ask({kind:'approval',title:msg.method,details:msg.params});
          rpc.send({id:msg.id,result:{decision:answer.allow?'accept':'decline'}});
        }else if(msg.method==='item/tool/requestUserInput'){
          const answers={};
          for(const question of msg.params.questions || []){
            const answer=await ask({kind:'question',title:question.question,options:question.options?.map(o=>o.label)});
            answers[question.id]={answers:[String(answer.text || '')]};
          }
          rpc.send({id:msg.id,result:{answers}});
        }else{
          emit('notice',{text:'Unsupported provider request declined: '+msg.method});
          rpc.send({id:msg.id,error:{code:-32601,message:'Relay does not support this request.'}});
        }
      }catch{rpc.send({id:msg.id,error:{code:-32000,message:'Approval cancelled.'}});}
    });
    rpc.on('notification',msg=>{
      const p=msg.params || {};
      if(msg.method==='account/rateLimits/updated')usage(()=>codexUsage(p));
      if(msg.method==='thread/started' && p.thread?.parentThreadId===session.nativeId)this.children.add(p.thread.id);
      if(msg.method==='thread/status/changed' && p.status?.type==='idle'){this.children.delete(p.threadId);this.tryHandover();}
      if(p.threadId && p.threadId!==session.nativeId)return;
      if(msg.method==='item/agentMessage/delta')emit('text',{text:p.delta});
      if(msg.method==='item/commandExecution/outputDelta')emit('tool-output',{text:p.delta});
      if(msg.method==='item/started' && !['agentMessage','reasoning','userMessage'].includes(p.item?.type)){this.activeTools.add(p.item.id);emit('tool',{text:p.item?.type || 'tool'});}
      if(msg.method==='item/completed'){this.activeTools.delete(p.item?.id);this.tryHandover();}
      if(msg.method==='turn/started'){this.turnId=p.turn?.id;if(this.cancelled)this.stop().catch(()=>{});else this.tryHandover();}
      if(msg.method==='turn/completed'){this.completed=true;this.turnId=null;complete(p.turn);}
    });
    try{
      await rpc.initialize();
      const config={cwd:session.cwd,approvalPolicy:'on-request',sandbox:'workspace-write',...(session.model?{model:session.model}:{})};
      const response=await rpc.request(session.nativeId?'thread/resume':'thread/start',session.nativeId?{...config,threadId:session.nativeId}:config);
      session.nativeId=response.thread.id;this.sessionId=session.nativeId;save();
      try{const limits=await rpc.request('account/rateLimits/read');usage(()=>codexUsage(limits));}catch{}
      if(this.cancelled)return {cancelled:true};
      const started=await rpc.request('turn/start',{threadId:session.nativeId,input:[{type:'text',text:prompt,text_elements:[]}]});
      if(!this.completed){this.turnId=started.turn.id;if(this.cancelled)await this.stop();else this.tryHandover();}
      const turn=await done;
      const detail=JSON.stringify(turn.error?.codexErrorInfo || '');
      return {yielded:!!this.interrupting && turn.status==='interrupted',quotaExhausted:/usageLimitExceeded/.test(detail),error:turn.status==='failed'?turn.error?.message || 'Codex turn failed.':null,cancelled:!!this.cancelled};
    }finally{this.rpc=null;await rpc.close();}
  }
  async stop(){this.cancelled=true;if(this.rpc && this.turnId)await this.rpc.request('turn/interrupt',{threadId:this.sessionId,turnId:this.turnId});}
}
export function runner(provider){return provider==='claude'?new ClaudeRunner():new CodexRunner();}
