import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const bin=fileURLToPath(new URL('../bin/relay.mjs',import.meta.url));
test('real CLI starts service, names accounts, reports unknown usage and stops cleanly',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-cli-'));
 const cli=(...args)=>exec(process.execPath,[bin,...args],{env:{...process.env,RELAY_HOME:root,RELAY_DISABLE_DISCOVERY:'1'},timeout:20000,windowsHide:true});
 t.after(async()=>{
  try{await cli('shutdown');}catch{}
  for(let n=0;n<100 && fs.existsSync(path.join(root,'endpoint.json'));n++)await new Promise(r=>setTimeout(r,50));
  assert.ok(!fs.existsSync(path.join(root,'endpoint.json')),'service must exit before cleanup');
  fs.rmSync(root,{recursive:true,force:true});
 });
 assert.match((await cli('--help')).stdout,/independent sessions/);
 await cli('account','add','claude','--name','Personal','--no-login');
 await cli('account','add','codex','--name','Codex Work','--no-login');
 await cli('account','rename','Personal','--name','Claude Primary');
 const state=JSON.parse((await cli('status','--json')).stdout);
 assert.deepEqual(state.accounts.map(a=>a.name),['Claude Primary','Codex Work']);
 assert.ok(state.accounts.every(a=>a.remaining===null && a.auth==='login required'));
 assert.match((await cli('status','--compact')).stdout,/Claude Primary\s+unknown/);
 assert.match((await cli('dashboard')).stdout,/ACCOUNTS & SESSION ROUTING/);
 await assert.rejects(cli('claude','--account','Claude Primary','--detach'),/Log in/);
});
