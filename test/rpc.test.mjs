import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexRPC} from '../src/rpc.mjs';
test('provider transport close waits for actual exit before permitting transcript transfer',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-rpc-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const rpc=new CodexRPC(root,process.execPath,['-e','process.stdin.resume(); setInterval(()=>{},1000);']);
 await rpc.close();
 assert.ok(rpc.child.exitCode!==null || rpc.child.signalCode!==null);
 assert.equal(rpc.closed,true);
});
