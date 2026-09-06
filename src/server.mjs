import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Store,privateDir,writeJson,readJson,threshold,safeText} from './storage.mjs';
import {Engine} from './engine.mjs';
import {Discovery} from './discovery.mjs';
import {NativeHub} from './native-hub.mjs';

export function isAlive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
export async function serve(root,dependencies={}){
  privateDir(root);
  const lock=path.join(root,'daemon.lock');
  try{const old=readJson(lock,null);if(old && isAlive(old.pid))throw new Error('Relay is already running.');if(old)fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
  let engine,server,timer,closing,discovery,native;
  const snapshot=async(force=false)=>{const base=engine.snapshot(),live=native.snapshot(),detected=await discovery.snapshot(force);return {...base,...detected,sessions:[...base.sessions,...live],externalSessions:(detected.externalSessions || []).filter(s=>!live.some(n=>n.nativeId===s.nativeId || n.pid===s.pid)),externalProcesses:(detected.externalProcesses || []).filter(p=>!live.some(n=>n.pid===p.pid))};};
  let stopping=false;
  const endpoint=path.join(root,'endpoint.json');
  const token=crypto.randomBytes(32).toString('hex');
  const dispatch=async(op,args)=>{
    if(stopping)throw new Error('Relay is stopping.');
    const store=engine.store;
    switch(op){
      case 'ping':return {ok:true,version:'0.2.3',capabilities:{handoff:1}};
      case 'snapshot':return snapshot();
      case 'discover':return snapshot(true);
      case 'account-add':return store.add(args.provider,args.name);
      case 'account-rename':return store.rename(args.account,args.name);
      case 'account-enable':{const a=store.account(args.account);a.enabled=args.enabled===true;store.save();return a;}
      case 'account-login-info':{
        const a=store.account(args.account);
        if(engine.state.sessions.some(s=>s.accountId===a.id && engine.runners.has(s.id)))throw new Error('Stop this account’s running sessions before renewing its login.');
        return {account:a,home:store.home(a)};
      }
      case 'account-login-complete':{const a=store.account(args.account);a.auth='ready';store.save();return engine.refresh(a.id);}
      case 'refresh':await Promise.all([engine.refresh(args.account),discovery.snapshot(true)]);return snapshot();
      case 'session-create':return engine.create(args);
      case 'session-send':return engine.send(args.session,args.prompt);
      case 'native-register':return native.register(args);
      case 'native-heartbeat':return native.heartbeat(args);
      case 'native-route-commit':return native.commit(args);
      case 'session-cancel-route':return native.find(args.session)?native.cancel(args.session,args.commandId):engine.cancelRoute(args.session);
      case 'native-default':return native.setDefault(args.provider,args.account);
      case 'session-route':return native.find(args.session)?native.route(args.session,args.account):engine.route(args.session,args.account);
      case 'session-configure':return native.find(args.session)?native.configure(args.session,args):engine.configure(args.session,args);
      case 'session-stop':return engine.stop(args.session);
      case 'session-events':{
        const s=store.session(args.session);
        return {session:engine.snapshot().sessions.find(x=>x.id===s.id),events:(engine.events.get(s.id) || []).filter(e=>e.seq>Number(args.after || 0)),approvals:engine.snapshot().approvals.filter(a=>a.sessionId===s.id)};
      }
      case 'answer':return engine.answer(args.id,args);
      case 'settings':{if(args.crossProviderAuto!==undefined){if(typeof args.crossProviderAuto!=='boolean')throw new Error('Automatic provider handoffs must be on or off.');engine.state.settings.crossProviderAuto=args.crossProviderAuto;}if(args.threshold!==undefined)engine.state.settings.threshold=threshold(args.threshold);store.save();return engine.state.settings;}
      case 'shutdown':{
        if(engine.runners.size || native.snapshot().length)throw new Error('Stop active sessions before stopping Relay.');
        stopping=true;setTimeout(()=>close(),20);return {ok:true};
      }
      default:throw new Error('Unknown Relay operation.');
    }
  };
  const close=()=>closing ||= (async()=>{
    stopping=true;clearInterval(timer);
    if(server)await new Promise(resolve=>server.close(resolve));
    if(engine)await Promise.allSettled([...engine.probes.values()]);
    if(discovery?.pending)await discovery.pending;
    for(const file of [endpoint,lock])try{fs.unlinkSync(file);}catch{}
  })();
  try{
    engine=new Engine(new Store(root),dependencies);
    native=new NativeHub(engine.store);
    discovery=dependencies.discovery || (process.env.RELAY_DISABLE_DISCOVERY==='1'?{snapshot:async()=>({externalSessions:[],externalProcesses:[],discovery:{disabled:true,checkedAt:Date.now()}})}:new Discovery(engine.store));
    server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      res.setHeader('Cache-Control','no-store');
      const supplied=req.headers.authorization || '';
      const expected='Bearer '+token;
      if(Buffer.byteLength(supplied)!==Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
      if(req.method!=='POST' || req.url!=='/rpc' || req.headers.origin){res.writeHead(403);res.end('{"error":"Forbidden"}');return;}
      try{
        let body='';for await(const chunk of req){body+=chunk;if(body.length>1048576)throw new Error('Request too large.');}
        const {op,args={}}=JSON.parse(body);
        const result=await dispatch(op,args);
        res.end(JSON.stringify({result}));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:safeText(e.message)}));}
    });
    server.requestTimeout=40000;server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    writeJson(endpoint,{port:server.address().port,token,pid:process.pid});
    timer=setInterval(()=>engine.refresh().catch(()=>{}),engine.state.settings.pollSeconds*1000);
    engine.refresh().catch(()=>{});
    return {server,engine,close,endpoint:{port:server.address().port,token}};
  }catch(e){await close();throw e;}
}
