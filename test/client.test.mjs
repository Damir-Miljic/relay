import test from 'node:test';
import assert from 'node:assert/strict';
import {rpcCall,RelayConnectionError} from '../src/client.mjs';

test('temporary Relay transport failures can be retried without classifying them as failed account routes',async t=>{
  const endpoint={port:1,token:'test-only'};let attempts=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{if(++attempts===1)throw new TypeError('fetch failed');return {ok:true,json:async()=>({result:{target:{id:'backup',commandId:'same-route'}}})};});
  await assert.rejects(rpcCall(endpoint,'native-heartbeat'),RelayConnectionError);
  assert.deepEqual(await rpcCall(endpoint,'native-heartbeat'),{target:{id:'backup',commandId:'same-route'}});
  mock.mock.mockImplementation(async()=>({ok:false,json:async()=>({error:'Target login expired.'})}));
  await assert.rejects(rpcCall(endpoint,'native-heartbeat'),e=>!(e instanceof RelayConnectionError) && e.message==='Target login expired.');
});

test('overlapping heartbeats do not lose a switch acknowledgement or failure reported during an older request',async()=>{
  const {NativeReports}=await import('../src/native-common.mjs');const reports=new NativeReports();let respond;
  const earlier=reports.send(()=>new Promise(resolve=>{respond=resolve;}),{session:'s'});
  const ack={accountId:'backup',commandId:'route'};reports.applied=ack;reports.error='New failure';respond({});await earlier;
  assert.equal(reports.applied,ack);assert.equal(reports.error,'New failure');
  let payload;await reports.send(async(op,args)=>{payload=args;return {};},{session:'s'});
  assert.equal(payload.applied,ack);assert.equal(payload.error,'New failure');assert.equal(reports.applied,null);assert.equal(reports.error,null);
  reports.applied=ack;await assert.rejects(reports.send(async()=>{throw new RelayConnectionError(new Error('offline'));},{session:'s'}));assert.equal(reports.applied,ack);
});
