import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveIntegrationExecutables} from '../src/integration.mjs';
import {executable} from '../src/process.mjs';

const missing=()=>Object.assign(new Error('Native client not found'),{code:'RELAY_CLI_NOT_FOUND'});
for(const provider of ['claude','codex'])test('installation works with only '+provider+' installed',()=>{
  const found=resolveIntegrationExecutables({}, {find:p=>{if(p!==provider)throw missing();return '/native/'+p;}});
  assert.deepEqual(found,{[provider]:'/native/'+provider});
});

test('reinstallation discovers a newly added provider while preserving a valid saved executable',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-install-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const saved=path.join(root,'claude');fs.writeFileSync(saved,'native client fixture');
  const calls=[];
  assert.deepEqual(resolveIntegrationExecutables({claude:saved},{find:p=>{calls.push(p);return '/new/'+p;}}),{claude:saved,codex:'/new/codex'});
  assert.deepEqual(calls,['codex']);
});

test('reinstallation rediscovers stale paths and rejects a directory as a saved executable',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-install-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  assert.deepEqual(resolveIntegrationExecutables({claude:path.join(root,'removed'),codex:root},{find:p=>{calls.push(p);if(p==='codex')throw missing();return '/new/claude';}}),{claude:'/new/claude'});
  assert.deepEqual(calls,['claude','codex']);
});

test('installation explains prerequisites when neither native client is available',()=>{
  assert.throws(()=>resolveIntegrationExecutables({}, {find:()=>{throw missing();}}),/Install Claude Code or Codex/);
});

test('optional providers do not hide invalid configuration or permission failures',()=>{
  const broken=new Error('CLI override must be an existing absolute path.');
  assert.throws(()=>resolveIntegrationExecutables({}, {find:p=>{if(p==='codex')throw broken;return '/native/claude';}}),error=>error===broken);
  const denied=Object.assign(new Error('Permission denied'),{code:'EACCES'});
  assert.throws(()=>resolveIntegrationExecutables({}, {find:()=>{throw denied;}}),error=>error===denied);
});

test('executable lookup distinguishes an absent client from other failures',()=>{
  assert.throws(()=>executable('relay-test-nonexistent-client-6a8d93'),error=>error.code==='RELAY_CLI_NOT_FOUND');
});
