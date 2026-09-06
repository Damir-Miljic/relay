import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {threshold,validName,safeText} from './storage.mjs';
import {headroom,chooseAccount,switchFloor} from './quota.mjs';
import {runner,probe,transferHistory} from './providers.mjs';

const continuation='Continue the unfinished task from the saved conversation. Relay changed the subscription account at a stopping point. Use the recorded tool results and current workspace state; do not repeat completed actions. If the outcome of an action is uncertain, inspect its state before trying it again.';
export class Engine extends EventEmitter {
  constructor(store,deps={}){
    super();this.store=store;this.runners=new Map();this.events=new Map();this.approvals=new Map();this.probes=new Map();this.stops=new Set();
    this.makeRunner=deps.runner || runner;this.probe=deps.probe || probe;this.transfer=deps.transfer || transferHistory;
    for(const s of store.state.sessions){if(['running','waiting','switching'].includes(s.status))s.status='paused';s.pending=null;}
    store.save();
  }
  get state(){return this.store.state;}
  record(s,type,data={}){
    const list=this.events.get(s.id) || [];
    if(typeof data.text==='string' && data.text.length>65536)data={...data,text:data.text.slice(0,65536)+'\n[Output truncated; full conversation is in native history.]'};
    const event={seq:(list.at(-1)?.seq || 0)+1,time:Date.now(),type,...data};
    list.push(event);while(list.length>1000 || list.reduce((n,e)=>n+(e.text?.length || 0),0)>2000000)list.shift();this.events.set(s.id,list);this.emit('event',s.id,event);
  }
  snapshot(){
    return {settings:this.state.settings,
      accounts:this.state.accounts.map(a=>({...a,remaining:headroom(a,this.state.settings)})),
      sessions:this.state.sessions.map(s=>({...s,managed:true,canRoute:true,canHandoff:false,canCancel:!!s.pending && s.pendingReason==='manual' && s.status!=='switching',lastPrompt:undefined,pendingSince:s.pending?s.pendingSince ?? null:null,accountName:this.store.account(s.accountId).name,pendingName:s.pending?this.store.account(s.pending).name:null})),
      approvals:[...this.approvals.values()].map(a=>a.view)};
  }
  async refresh(ref){
    const accounts=ref?[this.store.account(ref)]:this.state.accounts.filter(a=>a.enabled && a.auth==='ready');
    await Promise.allSettled(accounts.map(async a=>{
      if(this.probes.has(a.id))return this.probes.get(a.id);
      const pending=(async()=>{
        try{const result=await this.probe(a.provider,this.store.home(a));a.auth=result.auth;a.usage=result.usage;}
        catch(e){a.usage={...a.usage,error:safeText(e.message),attemptedAt:Date.now()};}
        finally{this.probes.delete(a.id);this.store.save();this.evaluate();}
      })();
      this.probes.set(a.id,pending);return pending;
    }));
    return this.snapshot();
  }
  create(options){
    const a=this.store.account(options.account,options.provider);
    if(!a.enabled || a.auth!=='ready')throw new Error('Log in to an enabled account first.');
    const cwd=path.resolve(options.cwd || process.cwd());
    if(!fs.statSync(cwd).isDirectory())throw new Error('Working directory does not exist.');
    const id=crypto.randomUUID();
    const name=validName(options.name || options.provider+'-'+id.slice(0,8));
    if(this.state.sessions.some(s=>s.name.toLowerCase()===name.toLowerCase()))throw new Error('That session name is already in use.');
    const pool=(options.pool || []).map(ref=>this.store.account(ref,options.provider).id);
    const s={id,name,provider:options.provider,accountId:a.id,cwd,model:options.model || null,auto:options.auto===true,
      threshold:options.threshold==null?this.state.settings.threshold:threshold(options.threshold),pool,status:'idle',nativeId:null,pending:null,lastSwitchAt:0,createdAt:Date.now()};
    this.state.sessions.push(s);this.store.save();return s;
  }
  configure(ref,options){
    const s=this.store.session(ref);
    if(options.auto!==undefined){s.auto=options.auto===true;if(!s.auto && s.pendingReason==='automatic'){s.pending=null;s.pendingReason=null;this.runners.get(s.id)?.cancelHandover?.();}}
    if(options.threshold!==undefined)s.threshold=threshold(options.threshold);
    if(options.pool!==undefined)s.pool=options.pool.map(x=>this.store.account(x,s.provider).id);
    this.store.save();this.evaluate();return s;
  }
  route(ref,accountRef,reason='manual'){
    const s=this.store.session(ref),a=this.store.account(accountRef,s.provider);
    if(!a.enabled || a.auth!=='ready')throw new Error('Target account must be enabled and logged in.');
    if(reason==='manual')s.auto=false;
    if(a.id===s.accountId){s.pending=null;s.pendingReason=null;this.runners.get(s.id)?.cancelHandover?.();this.store.save();return s;}
    if(this.runners.has(s.id)){
      s.pending=a.id;s.pendingReason=reason;s.pendingSince=Date.now();
      this.record(s,'notice',{text:'Switch queued to '+a.name+' at the next supported stopping point.'});
      this.runners.get(s.id).requestHandover?.();
    }else this.applyRoute(s,a.id);
    this.store.save();return s;
  }
  cancelRoute(ref){
    const s=this.store.session(ref);
    if(!s.pending || s.pendingReason!=='manual')throw new Error('There is no queued manual route to cancel.');
    if(s.status==='switching')throw new Error('The switch has already started and cannot be cancelled.');
    s.pending=null;s.pendingReason=null;s.pendingSince=null;s.auto=false;this.runners.get(s.id)?.cancelHandover?.();this.store.save();return s;
  }
  applyRoute(s,target){
    const a=this.store.account(target,s.provider),source=this.store.account(s.accountId,s.provider);
    if(!a.enabled || a.auth!=='ready')throw new Error('Target account is unavailable.');
    this.transfer(s,this.store.home(source),this.store.home(a));
    s.accountId=a.id;s.pending=null;s.pendingReason=null;s.lastSwitchAt=Date.now();
    this.record(s,'route',{text:source.name+' → '+a.name,accountId:a.id});
    this.store.save();
  }
  evaluate(){
    for(const s of this.state.sessions){
      if(this.stops.has(s.id) || !s.auto || s.pending || !['running','waiting','idle'].includes(s.status))continue;
      if(Date.now()-s.lastSwitchAt<this.state.settings.cooldownSeconds*1000)continue;
      const a=this.store.account(s.accountId),remaining=headroom(a,this.state.settings);
      if(remaining===null || remaining>s.threshold)continue;
      const next=chooseAccount(s,this.state.accounts,this.state.sessions,this.state.settings);
      if(next){try{this.route(s.id,next.id,'automatic');}catch(e){this.record(s,'notice',{text:e.message});}}
    }
  }
  ask(s,data){
    const id=crypto.randomUUID();
    s.status='waiting';this.store.save();
    return new Promise((resolve,reject)=>{
      const view={id,sessionId:s.id,sessionName:s.name,...data};
      this.approvals.set(id,{view,resolve:value=>{this.approvals.delete(id);if(this.runners.has(s.id) && ['running','waiting'].includes(s.status))s.status=[...this.approvals.values()].some(a=>a.view.sessionId===s.id)?'waiting':'running';this.store.save();resolve(value);},reject});
      this.record(s,'approval',view);
    });
  }
  answer(id,answer){
    const request=this.approvals.get(id);
    if(!request)throw new Error('This request is no longer waiting.');
    request.resolve({allow:answer.allow===true,text:typeof answer.text==='string'?answer.text:''});
    return {ok:true};
  }
  send(ref,prompt){
    const s=this.store.session(ref);
    if(typeof prompt!=='string' || !prompt.trim() || prompt.length>200000)throw new Error('Enter a prompt of 1–200000 characters.');
    if(this.runners.has(s.id))throw new Error('Session is already working. Wait, stop it, or use another session.');
    this.stops.delete(s.id);s.status='idle';this.evaluate();
    s.lastPrompt=prompt;s.status='running';
    this.runners.set(s.id,{stop:async()=>{}});
    this.store.save();
    this.run(s,prompt).catch(e=>{
      s.status='paused';s.error=safeText(e.message);this.record(s,'error',{text:s.error});
    }).finally(()=>{
      this.runners.delete(s.id);this.stops.delete(s.id);
      for(const a of [...this.approvals.values()])if(a.view.sessionId===s.id)a.resolve({allow:false,text:''});
      if(s.status==='running' || s.status==='waiting')s.status='idle';
      this.store.save();this.record(s,'end',{status:s.status});
    });
    return {ok:true,sessionId:s.id};
  }
  async run(s,prompt){
    const tried=[];
    for(let hop=0;hop<5;hop++){
      if(this.stops.has(s.id)){s.status='paused';s.pending=null;s.pendingReason=null;return;}
      const a=this.store.account(s.accountId);
      if(!a.enabled || a.auth!=='ready')throw new Error('Session account is not ready.');
      tried.push(a.id);s.status='running';s.error=null;
      const adapter=this.makeRunner(s.provider);
      this.runners.set(s.id,adapter);
      this.record(s,'notice',{text:'Running as '+a.name});
      const outcome=await adapter.run({
        session:s,home:this.store.home(a),prompt,
        emit:(type,data)=>this.record(s,type,data),
        usage:update=>{const updated=update(a.usage);if(updated && updated!==a.usage){a.usage=updated;this.store.save();this.evaluate();}},
        ask:data=>this.ask(s,data),shouldYield:()=>!!s.pending,save:()=>this.store.save()
      });
      if(outcome.cancelled || this.stops.has(s.id)){s.status='paused';s.pending=null;s.pendingReason=null;return;}
      if(outcome.quotaExhausted){
        const future=(a.usage.windows || []).map(w=>w.resetsAt*1000).filter(t=>t>Date.now());
        a.blockedUntil=future.length?Math.min(...future):Date.now()+60000;
        if(s.auto && !s.pending){
          await this.refresh();
          if(this.stops.has(s.id)){s.status='paused';s.pending=null;return;}
          const next=chooseAccount(s,this.state.accounts,this.state.sessions,this.state.settings,tried);
          if(next){s.pending=next.id;s.pendingReason='automatic';}
        }
      }
      if(s.pending){
        let next=s.pending;
        if(s.pendingReason==='automatic'){
          const target=this.store.account(next),left=headroom(target,this.state.settings);
          if(left===null || left<=switchFloor(s,this.state.accounts,this.state.settings) || (s.pool.length && !s.pool.includes(next))){
            next=chooseAccount(s,this.state.accounts,this.state.sessions,this.state.settings,tried)?.id;
            s.pending=next || null;
            if(!next)throw new Error('Queued account is no longer eligible and no fresh replacement is available. Refresh usage, then continue the session.');
          }
        }
        if(tried.includes(next) && (outcome.quotaExhausted || outcome.yielded))throw new Error('Handover loop stopped; choose a different account.');
        s.status='switching';this.store.save();this.applyRoute(s,next);
        if(outcome.yielded || outcome.quotaExhausted){
          prompt=s.nativeId?continuation:s.lastPrompt;
          this.record(s,'notice',{text:'Resuming the saved conversation.'});continue;
        }
      }
      if(outcome.yielded && !outcome.quotaExhausted){prompt=s.nativeId?continuation:s.lastPrompt;continue;}
      if(outcome.error || outcome.quotaExhausted){
        s.status='paused';s.error=outcome.error || 'No eligible account has fresh remaining usage.';
        this.record(s,'error',{text:s.error});return;
      }
      s.status='idle';return;
    }
    throw new Error('Maximum five handovers per turn reached. Inspect the session before continuing.');
  }
  async stop(ref){
    const s=this.store.session(ref),active=this.runners.get(s.id);
    this.stops.add(s.id);s.status='paused';s.pending=null;s.pendingReason=null;this.store.save();
    for(const a of [...this.approvals.values()])if(a.view.sessionId===s.id)a.resolve({allow:false,text:''});
    if(active)await active.stop();
    else{s.status='paused';this.store.save();}
    return {ok:true};
  }
}
