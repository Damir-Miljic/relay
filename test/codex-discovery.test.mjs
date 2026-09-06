import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readCodexLive,readThreadMetadata} from '../src/codex-discovery.mjs';
import {normalizeIdentity,IdentityCache} from '../src/identity.mjs';
import {buildDiscovery} from '../src/discovery.mjs';

const id='01a0737e-b758-74b2-9899-ecb2dde723ed';
function setup(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'relay-codex-observer-'));
 fs.mkdirSync(path.join(home,'thread-writer-locks'));
 const file=path.join(home,'thread-writer-locks',id+'.lock');fs.writeFileSync(file,'');
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 return {home,file};
}
test('Codex live detection requires native writer ownership, not just a saved lock filename',async t=>{
 const {home,file}=setup(t),profiles=[{home}],processes=[{pid:1,provider:'codex'}];
 assert.equal((await readCodexLive(profiles,processes,{owners:async()=>[],metadata:async()=>({name:'saved'})})).length,0);
 assert.equal((await readCodexLive(profiles,processes,{owners:async()=>[{pid:2,file}],metadata:async()=>({name:'wrong owner'})})).length,0);
 const found=await readCodexLive(profiles,processes,{owners:async()=>[{pid:1,file}],metadata:async()=>({name:'Open conversation',cwd:'/project'})});
 assert.equal(found[0].nativeId,id);assert.equal(found[0].status,'open');assert.equal(found[0].name,'Open conversation');
});
test('Codex internal helper conversations are excluded',async t=>{
 const {home,file}=setup(t);
 const found=await readCodexLive([{home}],[{pid:1,provider:'codex'}],{
  owners:async()=>[{pid:1,file}],metadata:async()=>({internal:true,name:'helper'})});
 assert.equal(found.length,0);
});
test('Codex metadata reader is read-only and bounds title text',async t=>{
 const {home}=setup(t),{DatabaseSync}=await import('node:sqlite');
 const file=path.join(home,'state_5.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, thread_source TEXT)');
 db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run(id,null,'x'.repeat(10000),'/project','{"subagent":{"other":"guardian"}}','guardian_review');
 db.close();
 const info=await readThreadMetadata(home,id);
 assert.equal(info.title.length,120);assert.equal(info.internal,true);
});
test('several native Codex threads share one process without inventing busy states',()=>{
 const result=buildDiscovery({processes:[{pid:100,ppid:1,provider:'codex',mode:'app-server'}],profiles:[],daemonPid:999,
 codexSessions:[{pid:100,nativeId:'one',name:'One',status:'open'},{pid:100,nativeId:'two',name:'Two',status:'open'}]});
 assert.equal(result.externalSessions.length,2);assert.equal(result.externalProcesses.length,0);
 assert.ok(result.externalSessions.every(s=>s.status==='open' && !s.canRoute));
});
test('identity matching normalizes email and separates providers and Claude organizations',()=>{
 const a=normalizeIdentity('claude',{email:' A@Example.com ',orgId:'one'});
 assert.equal(a.key,normalizeIdentity('claude',{email:'a@example.com',orgId:'one'}).key);
 assert.notEqual(a.key,normalizeIdentity('claude',{email:'a@example.com',orgId:'two'}).key);
 assert.notEqual(a.key,normalizeIdentity('codex',{email:'a@example.com'}).key);
 assert.equal(normalizeIdentity('claude',{}),null);
});
test('identity failures do not manufacture an account mapping',async()=>{
 const cache=new IdentityCache(async()=>{throw new Error('not signed in');});
 assert.equal(await cache.get('claude','/profile'),null);
});
