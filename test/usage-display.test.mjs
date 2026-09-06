import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claudeUsage,claudeRateEvent,headroom} from '../src/quota.mjs';
import {claudeModelMetadata,readClaudeModel,SessionMetadata} from '../src/session-metadata.mjs';
import {premiumBody,plain,width,usageLimit} from '../src/premium-display.mjs';

test('Claude model-scoped limits participate in headroom and survive incremental events',()=>{
  const now=Date.now(),reset=new Date(now+3600000).toISOString();
  const usage=claudeUsage({rate_limits:{five_hour:{utilization:37,resets_at:reset},seven_day:{utilization:27,resets_at:reset},model_scoped:[{display_name:'Fable',utilization:94,resets_at:reset},{display_name:'Unknown',utilization:null,resets_at:reset}]}},undefined,now);
  assert.deepEqual(usage.windows.map(w=>w.remaining),[63,73,6]);
  assert.equal(usage.windows[2].label,'7d/Fable');
  assert.equal(headroom({enabled:true,auth:'ready',usage},{staleSeconds:180},now),6);
  const next=claudeRateEvent({rate_limit_info:{rateLimitType:'five_hour',utilization:.38,resetsAt:now/1000+3600}},usage,now);
  assert.equal(next.windows.find(w=>w.id==='model_scoped:Fable').remaining,6);
  assert.equal(claudeUsage({model_scoped:[]},next,now).windows.some(w=>w.id.startsWith('model_scoped:')),false);
});

test('all usage limits render in both densities with reset times and expired readings marked',()=>{
  const now=Date.now(),windows=[{label:'5h',remaining:63,resetsAt:now/1000+1200,observedAt:now},{label:'7d',remaining:73,resetsAt:now/1000+6*86400,observedAt:now},{label:'7d/Fable',remaining:76,resetsAt:now/1000+6*86400,observedAt:now}];
  const state={accounts:[{name:'Personal',provider:'claude',enabled:true,auth:'ready',remaining:63,usage:{windows}}],sessions:[{name:'Project',accountName:'Personal',model:'claude-fable-5-1',effort:'high',modelSource:'last response',status:'idle'}]};
  for(const compact of [false,true])for(const n of [33,55,75,115]){
    const lines=premiumBody(state,n,{compact,now}),text=plain(lines.join('\n'));
    assert.match(text,/5-hour/);assert.match(text,/Weekly/);assert.match(text,/Fable/);
    for(const percent of ['63%','73%','76%'])assert.ok(text.includes(percent));
    assert.match(text,/resets in 20m/i);assert.match(text,/Fable 5\.1/);assert.match(text,/High effort/);
    for(const line of lines)assert.ok(width(line)<=n,'Overflow: '+plain(line));
  }
  state.accounts[0].remaining=null;windows[0].resetsAt=now/1000-1;
  const text=plain(premiumBody(state,115,{now}).join('\n'));assert.match(text,/STALE/);assert.doesNotMatch(text,/63%/);
  assert.equal(usageLimit({label:'43200m'}),'30-day limit');
});

test('Claude metadata reads only the selected conversation and ignores helper and synthetic output',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-model-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='conversation-123',dir=path.join(root,'projects','demo');fs.mkdirSync(dir,{recursive:true});
  const row=(model,effort,extra={})=>({type:'assistant',sessionId:id,message:{model,content:'private content must not be returned'},effort,...extra});
  const text=[row('old','low'),row('current','high'),row('helper','max',{isSidechain:true}),row('other','low',{sessionId:'other-id'}),row('<synthetic>','none')].map(JSON.stringify).join('\n');
  fs.writeFileSync(path.join(dir,id+'.jsonl'),text);
  assert.deepEqual(readClaudeModel(root,id),{model:'current',effort:'high',modelSource:'last response'});
  assert.equal(readClaudeModel(root,'../credentials'),null);
  assert.deepEqual(claudeModelMetadata(text+'\n'+JSON.stringify(row('latest',undefined)),id),{model:'latest',effort:null,modelSource:'last response'});
});

test('session metadata refreshes independently and never mixes accounts or retains session content',async()=>{
  let now=1000,calls=0,model='one';
  const reader=new SessionMetadata('/relay',{now:()=>now,claude:()=>{calls++;return {model,effort:'high',content:'private'};},codex:async()=>({model:'codex-model',reasoning_effort:'xhigh',title:'private'})});
  const state={accounts:[{id:'a',nativeHome:'/account-a'}],sessions:[{accountId:'a',provider:'claude',nativeId:'thread-a'}],externalSessions:[{provider:'codex',nativeId:'thread-b'}]};
  let next=await reader.enrich(state);assert.equal(next.sessions[0].model,'one');assert.equal(next.externalSessions[0].effort,'xhigh');assert.equal(next.sessions[0].content,undefined);assert.equal(next.externalSessions[0].title,undefined);
  model='two';next=await reader.enrich(state);assert.equal(next.sessions[0].model,'one');assert.equal(calls,1);
  now+=3001;next=await reader.enrich(state);assert.equal(next.sessions[0].model,'two');
  await reader.enrich({accounts:[],sessions:[]});assert.equal(reader.cache.size,0);
});
