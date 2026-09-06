import test from 'node:test';import assert from 'node:assert/strict';
import {requestClaudeExit} from '../src/claude-exit.mjs';
import {dashboard,compactStatus} from '../src/display.mjs';
test('handover exits through the native quit shortcut without activating a selected footer link',async()=>{
  const writes=[];let opened=0,quits=0,resolve;const exited=new Promise(r=>resolve=r);
  const terminal={exited,child:{write(text){writes.push(text);if(text.includes('\r') || text.includes('\n'))opened++;for(const c of text)if(c==='\x04' && ++quits===2)resolve(0);}}};
  await requestClaudeExit(terminal,{pause:async ms=>{assert.equal(ms,180);}});
  assert.deepEqual(writes,['\x04','\x04']);assert.equal(opened,0);assert.equal(await exited,0);
});
test('no second exit key is sent if the native process closes on the first',async()=>{
  const writes=[];let resolve;const terminal={exited:new Promise(r=>resolve=r),child:{write(text){writes.push(text);resolve(0);}}};
  await requestClaudeExit(terminal,{pause:()=>new Promise(()=>{})});assert.deepEqual(writes,['\x04']);
});
test('both panels explain that an old Claude supervisor needs a restart even after Relay was reopened',()=>{
  const s={provider:'claude',name:'Demo',accountName:'First',pendingName:'Second',status:'idle',integrated:true,boundary:'waiting for your draft to be submitted',auto:false};
  const state={accounts:[],settings:{staleSeconds:300},sessions:[s],externalSessions:[],externalProcesses:[]};
  for(const display of [dashboard,compactStatus]){const text=display(state);assert.match(text,/still runs old Relay code/);assert.match(text,/Exit and resume Claude/);}
});
