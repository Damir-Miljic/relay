import crypto from 'node:crypto';
import path from 'node:path';
import {threshold,validName,safeText} from './storage.mjs';
import {chooseAccount,headroom,switchFloor} from './quota.mjs';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
export class NativeHub {
  constructor(store,{now=Date.now,isAlive=alive}={}){this.store=store;this.now=now;this.isAlive=isAlive;this.rows=new Map();}
  find(ref){return [...this.rows.values()].find(s=>s.id===ref || s.name.toLowerCase()===String(ref).toLowerCase());}
  live(s){return this.isAlive(s.pid) && this.now()-s.seenAt<20000 && s.status!=='closed';}
  view(s){return {...s,pendingSince:s.pending?s.pendingSince ?? null:null,canHandoff:s.protocol===1,canCancel:!!s.pending && s.pendingReason==='manual' && !s.committing && s.protocol===1,accountName:this.store.account(s.accountId).name,pendingName:s.pending?this.store.account(s.pending).name:null,canRoute:this.live(s),managed:false,integrated:true,kind:'native',pid:s.nativePid || s.pid,supervisorPid:s.pid};}
  snapshot(){return [...this.rows.values()].filter(s=>this.live(s)).map(s=>this.view(s));}
  register(args){
    if(!['claude','codex'].includes(args.provider) || !Number.isInteger(args.pid) || !this.isAlive(args.pid))throw new Error('Invalid native supervisor.');
    const ref=args.account || this.store.state.settings.nativeDefaults?.[args.provider];
    const a=ref?this.store.account(ref,args.provider):this.store.state.accounts.find(a=>a.provider===args.provider && a.enabled && a.auth==='ready');
    if(!a || !a.enabled || a.auth!=='ready')throw new Error('Connect an account in Relay first.');
    const existing=[...this.rows.values()].find(s=>s.pid===args.pid && this.live(s));
    if(existing)return this.reply(existing);
    const id=crypto.randomUUID(),now=this.now();
    const s={id:'native:'+id,name:validName(args.name || path.basename(args.cwd || '')+' · '+args.provider+' '+id.slice(0,5)),provider:args.provider,accountId:a.id,pid:args.pid,cwd:args.cwd,status:'starting',auto:args.account?false:true,threshold:this.store.state.settings.threshold,pool:[],pending:null,pendingReason:null,commandId:null,seenAt:now,lastSwitchAt:0,nativeId:null,protocol:args.protocol===1?1:0,committing:null};
    this.rows.set(s.id,s);return this.reply(s);
  }
  reply(s){return {session:this.view(s),home:this.store.home(this.store.account(s.accountId)),target:s.pending?{id:s.pending,provider:this.store.account(s.pending).provider,name:this.store.account(s.pending).name,home:this.store.home(this.store.account(s.pending)),commandId:s.commandId}:null};}
  route(ref,account,reason='manual'){
    const s=this.find(ref);if(!s || !this.live(s))throw new Error('Native session is no longer connected.');
    if(s.committing)throw new Error('The switch has started. Wait for it to finish before choosing another account.');
    const a=this.store.account(account);
    if(a.provider!==s.provider && s.protocol!==1)throw new Error('Reopen this native session once to enable provider handoffs.');if(!a.enabled || a.auth!=='ready')throw new Error('Target account must be enabled and logged in.');
    if(reason==='manual')s.auto=false;
    s.desiredAccountId=a.id;s.pending=a.id===s.accountId?null:a.id;s.commandId=crypto.randomUUID();s.pendingReason=s.pending?reason:null;s.pendingSince=s.pending?this.now():null;s.error=null;
    return this.view(s);
  }
  cancel(ref,commandId){
    const s=this.find(ref);if(!s || !this.live(s))throw new Error('Native session is no longer connected.');
    if(!s.pending || s.pendingReason!=='manual')throw new Error('There is no queued manual switch to cancel.');
    if(commandId && commandId!==s.commandId)throw new Error('The switch changed. Refresh and select it again.');
    if(!this.view(s).canCancel)throw new Error('The switch has already started and cannot be cancelled.');
    s.pending=null;s.pendingReason=null;s.pendingSince=null;s.desiredAccountId=s.accountId;s.commandId=crypto.randomUUID();s.auto=false;
    return this.view(s);
  }
  commit(args){
    const s=this.find(args.session);
    if(!s || s.pid!==args.pid || !this.live(s) || s.protocol!==1)throw new Error('Reopen this native session to update its routing integration.');
    this.evaluate(s);
    if(!s.pending || s.commandId!==args.commandId)return {committed:false};
    if(s.committing && s.committing!==args.commandId)return {committed:false};
    const a=this.store.account(s.pending);if(!a.enabled || a.auth!=='ready')throw new Error('Target account is unavailable.');
    s.committing=args.commandId;return {committed:true,...this.reply(s)};
  }
  configure(ref,args){
    const s=this.find(ref);if(!s || !this.live(s))throw new Error('Native session is no longer connected.');
    if(s.committing)throw new Error('Wait for the current switch to finish before changing its settings.');
    if(args.auto!==undefined){s.auto=args.auto===true;if(!s.auto && s.pendingReason==='automatic'){s.pending=null;s.pendingReason=null;s.desiredAccountId=s.accountId;s.commandId=crypto.randomUUID();}}
    if(args.threshold!==undefined)s.threshold=threshold(args.threshold);
    if(args.pool!==undefined)s.pool=args.pool.map(ref=>this.store.account(ref).id);
    this.evaluate(s);return this.view(s);
  }
  evaluate(s){
    const settings=this.store.state.settings;
    if(s.committing)return;
    if(s.pending && s.pendingReason==='automatic'){
      const a=this.store.account(s.pending),left=headroom(a,settings,this.now());
      if(!s.auto || (a.provider!==s.provider && settings.crossProviderAuto!==true) || left===null || left<=switchFloor(s,this.store.state.accounts,settings,this.now()) || (s.pool.length && !s.pool.includes(a.id))){s.pending=null;s.commandId=crypto.randomUUID();}
    }
    if(!s.auto || s.pending || s.error || this.now()-s.lastSwitchAt<settings.cooldownSeconds*1000)return;
    const left=headroom(this.store.account(s.accountId),settings,this.now());
    if(left===null || left>s.threshold)return;
    let next=chooseAccount(s,this.store.state.accounts,[...this.store.state.sessions,...this.rows.values()].map(x=>({...x,status:x.status==='busy'?'running':x.status})),settings,[],this.now());
    // Exhaust suitable same-provider accounts before considering a provider handoff.
    if(!next && s.protocol===1 && settings.crossProviderAuto===true)next=chooseAccount({...s,provider:s.provider==='claude'?'codex':'claude'},this.store.state.accounts,[...this.rows.values()],settings,[],this.now());
    if(next)this.route(s.id,next.id,'automatic');
  }
  heartbeat(args){
    const s=this.find(args.session);if(!s || s.pid!==args.pid || !this.isAlive(s.pid))throw new Error('Native registration expired.');
    s.seenAt=this.now();
    if(args.name && typeof args.name==='string')s.name=safeText(args.name).slice(0,60);
    for(const key of ['nativeId','nativePid','status','boundary'])if(args[key]!==undefined)s[key]=typeof args[key]==='string'?safeText(args[key]).slice(0,160):args[key];
    if(args.error){s.error=safeText(args.error).slice(0,200);s.pending=null;s.pendingReason=null;s.committing=null;}
    if(args.applied){
      // Report the actual runtime account even when a newer request arrived during the change.
      const a=this.store.account(args.applied.accountId);
      if(s.protocol===1 && (s.committing!==args.applied.commandId || s.pending!==a.id)){
        if(s.accountId===a.id && s.lastApplied===args.applied.commandId)return this.reply(s);
        throw new Error('Switch acknowledgement does not match the committed route.');
      }
      if(s.protocol!==1 && a.provider!==s.provider)throw new Error('This supervisor cannot change providers.');
      if(a.provider!==s.provider){s.name=s.name.replace(' · '+s.provider+' ',' · '+a.provider+' ');s.provider=a.provider;}
      s.accountId=a.id;s.lastApplied=args.applied.commandId;s.committing=null;s.lastSwitchAt=this.now();
      if(s.commandId===args.applied.commandId){s.pending=null;s.pendingReason=null;s.error=null;}
      else if(s.desiredAccountId && s.desiredAccountId!==s.accountId){s.pending=s.desiredAccountId;s.pendingReason='manual';}
    }
    this.evaluate(s);return this.reply(s);
  }
  setDefault(provider,ref){const a=this.store.account(ref,provider);if(!a.enabled || a.auth!=='ready')throw new Error('Log in to this account first.');this.store.state.settings.nativeDefaults ||= {};this.store.state.settings.nativeDefaults[provider]=a.id;this.store.save();return a;}
}
