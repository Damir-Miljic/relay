import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {recordRuntime,withRuntimeVersions,relayVersion} from '../src/runtime-version.mjs';
test('dashboard identifies old loaded supervisors independently of the running service version',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const session={id:'native:11111111-1111-4111-8111-111111111111',integrated:true,supervisorPid:process.pid};
 assert.equal(withRuntimeVersions(root,{sessions:[session]}).sessions[0].restartRequired,true);recordRuntime(root,session);let view=withRuntimeVersions(root,{sessions:[session]}).sessions[0];assert.equal(view.restartRequired,false);assert.equal(view.runtimeVersion,relayVersion);
 view=withRuntimeVersions(root,{sessions:[{...session,supervisorPid:process.pid+1}]}).sessions[0];assert.equal(view.restartRequired,true);
 assert.throws(()=>recordRuntime(root,{id:'native:../../outside'}),/Invalid/);
});
