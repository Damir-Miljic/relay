import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureHelperExecutable,probeTerminalRuntime} from '../src/terminal-runtime.mjs';

test('real terminal starts, accepts input, resizes and exits in a project path with spaces',{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay terminal test '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await probeTerminalRuntime({cwd:root});
});

test('helper repair restores owner execution without granting other permissions',{skip:process.platform==='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-helper-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const helper=path.join(root,'spawn-helper');
  fs.writeFileSync(helper,'#!/bin/sh\nexit 0\n');
  fs.chmodSync(helper,0o640);
  ensureHelperExecutable(helper);
  assert.equal(fs.statSync(helper).mode & 0o777,0o740);
  fs.accessSync(helper,fs.constants.X_OK);
  ensureHelperExecutable(helper);
  assert.equal(fs.statSync(helper).mode & 0o777,0o740);
  // An already executable helper must keep its existing permissions.
  fs.chmodSync(helper,0o755);ensureHelperExecutable(helper);
  assert.equal(fs.statSync(helper).mode & 0o777,0o755);
  const link=path.join(root,'linked-helper');fs.symlinkSync(helper,link);
  assert.throws(()=>ensureHelperExecutable(link),/regular helper file/);
  assert.throws(()=>ensureHelperExecutable(path.join(root,'missing')),/npm ci/);
});
