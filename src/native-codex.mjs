import fs from 'node:fs';
import {codexExcerpts,writeHandoff,preflightHandoff,commitRoute,requestCodexExit} from './handoff.mjs';
import {accountEnv} from './process.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {CodexRPC} from './rpc.mjs';
import {RelayConnectionError} from './client.mjs';
import {nativeExecutable,nativeHome,terminalProcess,continuation,delay,NativeReports} from './native-common.mjs';

function decode(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());}catch{return {};}}
export async function accountTokens(home,{refresh=false,makeRPC=h=>new CodexRPC(h,nativeExecutable('codex'))}={}){
  const read=()=>{const data=JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8'));if(data.auth_mode==='apikey' || !data.tokens?.access_token || !data.tokens.account_id)throw new Error('A file-backed ChatGPT subscription login is required. Use Relay Login for this account.');return data.tokens;};
  let t=read();
  if(refresh || (decode(t.access_token).exp || 0)*1000<Date.now()+300000){
    const rpc=makeRPC(home);try{await rpc.initialize();await rpc.request('account/read',{refreshToken:true});}finally{await rpc.close();}t=read();
  }
  const claims=decode(t.access_token),auth=claims['https://api.openai.com/auth'] || {};
  if(auth.chatgpt_account_id && auth.chatgpt_account_id!==t.account_id)throw new Error('Saved account ID does not match its token. Log in again.');
  if(!claims.exp || claims.exp*1000<Date.now()+10000)throw new Error('The saved account token expired. Log in again.');
  return {accessToken:t.access_token,chatgptAccountId:t.account_id,chatgptPlanType:auth.chatgpt_plan_type || null};
}
export const isHelperThread=t=>t?.ephemeral===true || ['system','guardian_review'].includes(t?.threadSource);
export class CodexControl {
  constructor(rpc,{tokens=accountTokens}={}){this.rpc=rpc;this.tokens=tokens;this.threads=new Map();this.requests=new Set();this.activeItems=new Set();this.children=new Set();this.background=new Set();this.revision=0;this.switching=null;this.threadId=null;this.status='starting';this.interrupted=false;this.authRefreshing=0;}
  tracking(){this.helperThreads ||= new Set();this.itemOwners ||= new Map();this.childThreads ||= new Set();this.threadLabels ||= new Map();this.eventRevision ||= 0;}
  rememberThread(thread){
    this.tracking();if(!thread?.id)return;
    const name=thread.agentNickname || thread.name;
    if(typeof name==='string' && name.trim())this.threadLabels.set(thread.id,name.trim().slice(0,60));
  }
  settleThread(threadId,turnId){
    this.tracking();
    if(!turnId || this.threads.get(threadId)===turnId)this.threads.set(threadId,null);
    for(const [id,owner] of this.itemOwners)if(owner.threadId===threadId && (!turnId || owner.turnId===turnId)){this.activeItems.delete(id);this.itemOwners.delete(id);}
    if(threadId===this.threadId && !this.threads.get(threadId))this.status='idle';
    if(this.childThreads.has(threadId))this.children.delete(threadId);
  }
  observe(msg){
    this.tracking();const p=msg.params || {},m=msg.method;
    if(!['thread/started','thread/name/updated','thread/status/changed','thread/closed','turn/started','turn/completed','item/started','item/completed','serverRequest/resolved'].includes(m))return;
    this.eventRevision++;
    if(m==='thread/started'){
      const t=p.thread;this.rememberThread(t);if(t?.id && isHelperThread(t))this.helperThreads.add(t.id);if(t?.parentThreadId){this.childThreads.add(t.id);if(t.status?.type!=='idle')this.children.add(t.id);}
      else if(t?.id){if(!this.threadId && !this.helperThreads.has(t.id))this.threadId=t.id;this.threads.set(t.id,null);if(t.id===this.threadId)this.status='idle';}
    }
    if(m==='thread/name/updated')this.rememberThread({id:p.threadId,name:p.threadName});
    if(m==='thread/status/changed' && !this.interrupted && ['idle','notLoaded','systemError'].includes(p.status?.type)){
      this.settleThread(p.threadId);
    }
    if(m==='thread/closed'){this.settleThread(p.threadId);this.threads.delete(p.threadId);}
    if(m==='turn/started'){
      this.threads.set(p.threadId,p.turn?.id);
      if(this.childThreads.has(p.threadId))this.children.add(p.threadId);
      else if(!this.threadId && !this.helperThreads.has(p.threadId))this.threadId=p.threadId;
      if(p.threadId===this.threadId)this.status='busy';
    }
    if(m==='turn/completed'){
      this.settleThread(p.threadId,p.turn?.id);if(p.threadId===this.threadId)this.lastCompletion=p.turn?.status;
    }
    if(m==='serverRequest/resolved')this.requests.delete(p.requestId);
    if(m==='item/started' && p.item?.id && !['agentMessage','reasoning','userMessage','plan'].includes(p.item.type)){
      this.activeItems.add(p.item.id);this.itemOwners.set(p.item.id,{threadId:p.threadId,turnId:p.turnId});
    }
    if(m==='item/completed'){
      const item=p.item;this.activeItems.delete(item?.id);this.itemOwners.delete(item?.id);
      if(item?.type==='commandExecution' && item.processId){if(item.exitCode===null && !['failed','declined'].includes(item.status))this.background.add(item.processId);else this.background.delete(item.processId);}
      if(item?.type==='collabAgentToolCall')for(const [id,state] of Object.entries(item.agentsStates || {})){
        this.childThreads.add(id);if(['completed','shutdown','errored','notFound'].includes(state?.status))this.settleThread(id);else this.children.add(id);
      }
    }
  }
  boundary(){
    const active=[...this.threads.entries()].filter(([,turn])=>turn);
    if(this.authRefreshing)return 'Waiting for the account login to refresh.';
    if(this.requests.size)return 'Waiting for '+this.requests.size+' permission or input request(s).';
    if(this.activeItems.size)return 'Waiting for '+this.activeItems.size+' active tool(s).';
    const agents=[...new Set([...this.children,...active.filter(([id])=>id!==this.threadId).map(([id])=>id)])];
    if(agents.length){
      const names=agents.slice(0,2).map(id=>this.threadLabels?.get(id) || String(id).slice(0,8));
      return 'Waiting for '+(agents.length===1?'agent ':'agents ')+names.join(', ')+(agents.length>2?' (+'+(agents.length-2)+' more)':'')+' to finish.';
    }
    // A live auth rebind keeps this app-server and its background terminals alive.
    if(this.background.size && (this.status!=='idle' || active.length))return 'Waiting for the current turn to finish; background terminals will stay open.';
    return 'Ready to switch.';
  }
  handoffBoundary(){if(this.background.size)return 'Finish background terminals in Codex before changing providers.';if(this.status!=='idle' || [...this.threads.values()].some(Boolean))return 'Waiting for the current turn to finish before changing providers.';return this.boundary();}
  canSwitch(){return this.boundary()==='Ready to switch.';}
  async reconcile(){
    this.tracking();if(this.reconciling || !this.threadId || this.switching)return;
    this.reconciling=true;
    try{
      for(const id of new Set([this.threadId,...this.children,...this.threads.keys()])){
        const revision=this.eventRevision;
        const {thread}=await this.rpc.request('thread/read',{threadId:id,includeTurns:!this.helperThreads.has(id)},10000);
        if(revision!==this.eventRevision)continue;this.rememberThread(thread);
        if(thread?.id===id && ['idle','notLoaded'].includes(thread.status?.type)){
          const turn=thread.turns?.at(-1);
          if(!turn || ['completed','interrupted','failed'].includes(turn.status)){
            this.settleThread(id);if(id===this.threadId && turn)this.lastCompletion=turn.status;
          }
        }
      }
    }finally{this.reconciling=false;}
  }
  async login(home){
    const tokens=await this.tokens(home);
    await this.rpc.request('account/login/start',{type:'chatgptAuthTokens',...tokens});
    const info=await this.rpc.request('account/read',{refreshToken:false});
    if(info.account?.type!=='chatgpt')throw new Error('Codex did not confirm the subscription login.');
    this.currentHome=home;this.currentTokens=tokens;
  }
  async route(target,isCurrent=()=>true,commit=async()=>true){
    if(this.switching || !this.canSwitch())return false;
    this.switching=this.performRoute(target,isCurrent,commit);
    try{return await this.switching;}finally{this.switching=null;}
  }
  async performRoute(target,isCurrent,commit){
    const next=await this.tokens(target.home);
    if(!isCurrent() || !this.canSwitch())return false;
    if(!await commit())return false;
    if(!this.canSwitch())throw new Error('New work started while the route was being confirmed. The current account was left unchanged.');
    const thread=this.threadId,turn=this.threads.get(thread),revision=this.revision;
    let interrupted=false;
    const previous={home:this.currentHome,tokens:this.currentTokens};
    try{
      if(turn){
        this.interrupted=true;
        await this.rpc.request('turn/interrupt',{threadId:thread,turnId:turn});
        const until=Date.now()+30000;
        while(this.threads.get(thread) && Date.now()<until)await delay(50);
        if(this.threads.get(thread))throw new Error('Waiting for Codex to finish stopping.');
        interrupted=this.lastCompletion==='interrupted';
      }
      if(!isCurrent())return false;
      if(!this.canSwitch())throw new Error('New work started before the account changed. Try the route again when it finishes.');
      await this.rpc.request('account/login/start',{type:'chatgptAuthTokens',...next});
      const {account}=await this.rpc.request('account/read',{refreshToken:false});
      if(account?.type!=='chatgpt')throw new Error('Codex did not confirm the new account.');
      this.currentHome=target.home;this.currentTokens=next;
    }catch(error){
      if(previous.tokens){await this.rpc.request('account/login/start',{type:'chatgptAuthTokens',...previous.tokens});this.currentHome=previous.home;this.currentTokens=previous.tokens;}
      throw error;
    }finally{
      this.interrupted=false;
      // Only restart work that Relay itself interrupted. Never replay a user-submitted turn.
      if(interrupted && revision===this.revision && !this.threads.get(thread))await this.rpc.request('turn/start',{threadId:thread,input:[{type:'text',text:continuation,text_elements:[]}]});
    }
    return true;
  }
}
export async function codexBridge(rpc,control,{onSubmit=()=>{}}={}){
  let socket,initialization;
  const token=crypto.randomBytes(32).toString('hex');
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
  const wss=new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
  server.on('upgrade',(req,net,head)=>{
    const supplied=req.headers.authorization || '',expected='Bearer '+token;
    if(req.headers.origin || Buffer.byteLength(supplied)!==Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)) || socket?.readyState===WebSocket.OPEN){net.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,net,head,s=>wss.emit('connection',s));
  });
  const send=msg=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(msg));};
  const notification=msg=>{control.observe(msg);send(msg);};
  const request=async msg=>{
    if(msg.method==='account/chatgptAuthTokens/refresh'){
      try{if(control.switching)await control.switching;control.authRefreshing++;const t=await control.tokens(control.currentHome,{refresh:true});if(msg.params?.previousAccountId && t.chatgptAccountId!==msg.params.previousAccountId)throw new Error('Account changed.');control.currentTokens=t;rpc.send({id:msg.id,result:t});}catch{rpc.send({id:msg.id,error:{code:-32000,message:'Renew this account login in Relay.'}});}finally{control.authRefreshing=Math.max(0,control.authRefreshing-1);}return;
    }
    control.requests.add(msg.id);send(msg);
  };
  rpc.on('notification',notification);rpc.on('request',request);
  initialization=await rpc.request('initialize',{clientInfo:{name:'relay_native',version:'0.2.2'},capabilities:{experimentalApi:true}});rpc.send({method:'initialized',params:{}});
  wss.on('connection',client=>{
    socket=client;
    client.on('message',async raw=>{
      let msg;try{
        msg=JSON.parse(raw.toString());
        if(!msg.method){if(control.requests.delete(msg.id))rpc.send(msg);return;}
        if(msg.method==='initialized')return;
        if(msg.method==='initialize'){send({id:msg.id,result:initialization});return;}
        if(['account/login/start','account/logout','account/login/cancel'].includes(msg.method))throw new Error('Manage named account logins in Relay, then route this terminal.');
        if(['turn/start','turn/steer','thread/start','thread/resume','thread/fork'].includes(msg.method)){
          control.revision++;if(control.switching)await control.switching.catch(()=>{});
        }
        if(msg.id==null){rpc.send(msg);return;}
        // Save interactive conversations for handoff/recovery; keep native helper threads temporary.
        if(msg.method==='thread/start' && !isHelperThread(msg.params))msg.params={...msg.params,ephemeral:false};
        const result=await rpc.request(msg.method,msg.params,120000);
        if(['thread/start','thread/resume','thread/fork'].includes(msg.method) && result.thread && !isHelperThread(result.thread)){control.threadId=result.thread.id;control.threads.set(result.thread.id,null);control.status='idle';}
        if(msg.method==='turn/start' && msg.params?.threadId===control.threadId)onSubmit();
        send({id:msg.id,result});
      }catch(e){if(msg?.id!=null)send({id:msg.id,error:e.rpcError || {code:-32000,message:e.message}});}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'ws://127.0.0.1:'+server.address().port,token,close:async()=>{rpc.off('notification',notification);rpc.off('request',request);for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
export async function runCodex(api,registration,args,{root,onReady=()=>{}}={}){
  const rpc=new CodexRPC(nativeHome('codex'),nativeExecutable('codex'));
  const control=new CodexControl(rpc);let bridge,timer,terminal,closed=false,polling=false,target,handed=null,scheduled=null,arrivalAcknowledged=false;const reports=new NativeReports();
  try{
    bridge=await codexBridge(rpc,control,{onSubmit:()=>terminal?.markSubmitted()});await control.login(registration.home);
    terminal=terminalProcess(nativeExecutable('codex'),['--remote',bridge.url,'--remote-auth-token-env','RELAY_NATIVE_WS_TOKEN',...args],{env:{...accountEnv('codex',nativeHome('codex')),RELAY_BYPASS:'1',RELAY_NATIVE_WS_TOKEN:bridge.token}});
    const handover=async selected=>{
      if(terminal.hasDraft || control.handoffBoundary()!=='Ready to switch.')return;
      terminal.pauseInput();const revision=control.revision;
      try{
        await preflightHandoff(selected);
        const {thread}=await rpc.request('thread/read',{threadId:control.threadId,includeTurns:true});
        if(control.handoffBoundary()!=='Ready to switch.')return;
        const fresh=await api('native-heartbeat',{session:registration.session.id,pid:process.pid,status:'idle'});
        target=fresh.target;if(target?.commandId!==selected.commandId)return;
        const note=writeHandoff(root,{...fresh.session,nativeId:control.threadId},selected,codexExcerpts(thread));
        if(terminal.hasDraft || revision!==control.revision || control.handoffBoundary()!=='Ready to switch.')return;
        if(!await commitRoute(api,registration,selected))return;
        if(control.handoffBoundary()!=='Ready to switch.')throw new Error('New work started before the provider handoff. The current conversation was left open.');
        await requestCodexExit(terminal);
        handed={target:selected,note,input:terminal.takeInput(),rollback:{registration:{session:fresh.session,home:control.currentHome},args:['resume',control.threadId],nativeId:control.threadId}};
      }finally{if(!handed)terminal.resumeInput();}
    };
    const poll=async()=>{
      if(polling || closed || handed)return;polling=true;
      try{
        if(registration.arrival && control.threadId && !arrivalAcknowledged){reports.applied={accountId:registration.arrival.id,commandId:registration.arrival.commandId};arrivalAcknowledged=true;}
        const result=await reports.send(api,{session:registration.session.id,pid:process.pid,nativePid:rpc.child.pid,nativeId:control.threadId,status:control.switching?'switching':control.status,boundary:target?.provider==='claude'?(terminal.hasDraft?'Waiting for unsubmitted text. Clear or submit your draft.':control.handoffBoundary()):control.boundary()});target=result.target;
        if(registration.arrival && result.session.accountId===registration.arrival.id && !result.session.committing)onReady();
        if(target && !control.switching && (!control.canSwitch() || control.status!=='idle') && Date.now()-(control.lastReconcile || 0)>3000){
          control.lastReconcile=Date.now();await control.reconcile().catch(()=>{});
        }
        if(target && !control.switching){
          const selected=target;
          if(selected.provider==='claude'){
            if(control.threadId && control.handoffBoundary()==='Ready to switch.' && !terminal.hasDraft){
              scheduled=handover(selected).catch(e=>{if(!(e instanceof RelayConnectionError))reports.error=e.message;}).finally(()=>{control.switching=null;});
              control.switching=scheduled;
            }
          }else{
            control.route(selected,()=>target?.commandId===selected.commandId && !closed,()=>commitRoute(api,registration,selected)).then(ok=>{if(ok)reports.applied={accountId:selected.id,commandId:selected.commandId};}).catch(e=>{if(!(e instanceof RelayConnectionError))reports.error=e.message;});
          }
        }
      }catch(e){if(!(e instanceof RelayConnectionError))reports.error=e.message;}
      finally{polling=false;}
    };
    timer=setInterval(poll,1000);await poll();
    rpc.once('closed',()=>{if(!closed)terminal.child.kill();});
    const code=await terminal.exited;if(scheduled)await scheduled;if(handed)return {handoff:handed};if(registration.arrival && !arrivalAcknowledged)throw new Error('Codex exited before opening the handoff conversation.');return code;
  }finally{closed=true;clearInterval(timer);await bridge?.close();await rpc.close();}
}
