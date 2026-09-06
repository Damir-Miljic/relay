import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {serve} from '../src/server.mjs';
import {rpcCall} from '../src/client.mjs';
test('local service authenticates clients, persists names, isolates routes and refuses unsafe shutdown',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-service-'));
 let release;
 const service=await serve(root,{discovery:{snapshot:async()=>({externalSessions:[{id:'native-1',provider:'claude',name:'Already running',managed:false,canRoute:false}],externalProcesses:[]})},runner:()=>({run:()=>new Promise(r=>release=r),stop:async()=>release({cancelled:true})}),transfer:()=>{},probe:async()=>({auth:'ready',usage:{windows:[]}})});
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const api=(op,args)=>rpcCall(service.endpoint,op,args);
 const bad=await fetch('http://127.0.0.1:'+service.endpoint.port+'/rpc',{method:'POST',body:'{}'});assert.equal(bad.status,401);
 const origin=await fetch('http://127.0.0.1:'+service.endpoint.port+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+service.endpoint.token,Origin:'https://example.com'},body:'{}'});assert.equal(origin.status,403);
 const a=await api('account-add',{provider:'claude',name:'One'}),b=await api('account-add',{provider:'claude',name:'Two'});
 await api('account-login-complete',{account:a.id});await api('account-login-complete',{account:b.id});
 const one=await api('session-create',{provider:'claude',account:a.id,name:'backend',cwd:root});
 const two=await api('session-create',{provider:'claude',account:b.id,name:'frontend',cwd:root});
 await api('account-rename',{account:a.id,name:'Primary'});
 await api('session-send',{session:one.id,prompt:'work'});
 await assert.rejects(api('shutdown'),/Stop active/);
 await api('session-route',{session:one.id,account:b.id});
 let state=await api('snapshot');assert.equal(state.externalSessions[0].name,'Already running');assert.equal(state.externalSessions[0].canRoute,false);assert.equal(state.sessions[0].accountId,a.id);assert.equal(state.sessions[0].pending,b.id);assert.equal(state.sessions[1].accountId,b.id);assert.equal(state.sessions[1].pending,null);
 release({});
 for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,10));state=await api('snapshot');if(state.sessions[0].status==='idle')break;}
 assert.equal(state.sessions[0].accountId,b.id);assert.equal(state.accounts[0].name,'Primary');
 await assert.rejects(api('session-route',{session:'native-1',account:a.id}),/not found/);
 const persisted=JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));assert.equal(persisted.accounts[0].name,'Primary');
 assert.equal(persisted.sessions.find(s=>s.id===two.id).accountId,b.id);
});



test('settings persist the full threshold range and new sessions inherit the default',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-settings-'));
 const service=await serve(root,{discovery:{snapshot:async()=>({})},probe:async()=>({auth:'ready',usage:{windows:[]}})});
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const api=(op,args)=>rpcCall(service.endpoint,op,args),a=await api('account-add',{provider:'claude',name:'One'});await api('account-login-complete',{account:a.id});
 const one=await api('session-create',{provider:'claude',account:a.id,name:'Before',cwd:root});
 await api('settings',{threshold:100});const two=await api('session-create',{provider:'claude',account:a.id,name:'After',cwd:root});
 assert.equal(one.threshold,10);assert.equal(two.threshold,100);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8')).settings.threshold,100);
 await api('session-configure',{session:one.id,threshold:80});await assert.rejects(api('settings',{threshold:101}),/1–100/);
});

test('service persists provider fallback and exposes transactional route cancellation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-handoff-rpc-'));
 const service=await serve(root,{discovery:{snapshot:async()=>({})},probe:async()=>({auth:'ready',usage:{windows:[]}})});
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const api=(op,args)=>rpcCall(service.endpoint,op,args),a=await api('account-add',{provider:'claude',name:'A'}),b=await api('account-add',{provider:'codex',name:'B'});
 await api('account-login-complete',{account:a.id});await api('account-login-complete',{account:b.id});
 assert.equal((await api('settings',{})).crossProviderAuto,false);
 await api('settings',{crossProviderAuto:true});assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).settings.crossProviderAuto,true);
 await assert.rejects(api('settings',{crossProviderAuto:'yes'}),/on or off/);
 const s=(await api('native-register',{provider:'claude',pid:process.pid,protocol:1,cwd:root})).session;
 let q=await api('session-route',{session:s.id,account:b.id});await api('session-cancel-route',{session:s.id,commandId:q.commandId});
 assert.equal((await api('native-route-commit',{session:s.id,pid:process.pid,commandId:q.commandId})).committed,false);
 q=await api('session-route',{session:s.id,account:b.id});await api('native-route-commit',{session:s.id,pid:process.pid,commandId:q.commandId});
 await assert.rejects(api('session-cancel-route',{session:s.id}),/already started/);
 const changed=await api('native-heartbeat',{session:s.id,pid:process.pid,applied:{commandId:q.commandId,accountId:b.id},nativeId:'new'});
 assert.equal(changed.session.provider,'codex');assert.equal(changed.session.pending,null);
});
