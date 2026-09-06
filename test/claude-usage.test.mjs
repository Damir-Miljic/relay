import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {accountEnv} from '../src/process.mjs';
import {probeClaude} from '../src/providers.mjs';

const defaultHome=path.join(os.homedir(),'.claude');

test('the default Claude profile selects the native default Keychain entry',()=>{
  const source={PATH:'/bin',CLAUDE_CONFIG_DIR:'/another-account',CLAUDE_SECURESTORAGE_CONFIG_DIR:'/another-store'};
  const before={...source},env=accountEnv('claude',defaultHome,source,'darwin');
  assert.equal(Object.hasOwn(env,'CLAUDE_CONFIG_DIR'),false);
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR,'');
  assert.equal(env.PATH,source.PATH);
  assert.deepEqual(source,before);
});

test('isolated Claude accounts ignore inherited credential overrides and remain independent',()=>{
  const source={CLAUDE_CONFIG_DIR:'/wrong',CLAUDE_SECURESTORAGE_CONFIG_DIR:'/wrong-store',CLAUDE_CODE_OAUTH_TOKEN:'fixture-token',ANTHROPIC_API_KEY:'fixture-key'};
  const homeA=path.join(os.tmpdir(),'relay-account-a'),homeB=path.join(os.tmpdir(),'relay-account-b');
  const a=accountEnv('claude',homeA,source,'darwin'),b=accountEnv('claude',homeB,source,'darwin');
  assert.equal(a.CLAUDE_CONFIG_DIR,homeA);assert.equal(a.CLAUDE_SECURESTORAGE_CONFIG_DIR,homeA);
  assert.equal(b.CLAUDE_CONFIG_DIR,homeB);assert.equal(b.CLAUDE_SECURESTORAGE_CONFIG_DIR,homeB);
  assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(a.ANTHROPIC_API_KEY,undefined);
  const codex=accountEnv('codex',homeB,source);
  assert.equal(codex.CODEX_HOME,homeB);assert.equal(codex.CLAUDE_SECURESTORAGE_CONFIG_DIR,undefined);
});

function fakeUsage(read){
  const state={prompts:[],closed:false,options:null};
  state.createQuery=({prompt,options})=>{
    state.options=options;
    return {
      async *[Symbol.asyncIterator](){for await(const message of prompt)state.prompts.push(message);},
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options){assert.deepEqual(options,{skipBehaviors:true});return read(state.options.env);},
      close(){state.closed=true;}
    };
  };
  return state;
}
for(const [name,home,credentialScope] of [['default',defaultHome,process.platform==='darwin'?'':defaultHome],['isolated',path.join(os.tmpdir(),'relay-usage-profile'),path.join(os.tmpdir(),'relay-usage-profile')]]){
  test('Claude usage reads the '+name+' login without submitting a model prompt',async()=>{
    const state=fakeUsage(env=>{
      // Emulate Claude's credential-store selection, including empty vs unset.
      const scope=env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? '';
      return scope===credentialScope?{subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:23,resets_at:'2099-01-01T00:00:00Z'}}}:{rate_limits_available:false,rate_limits:null};
    });
    const result=await probeClaude(home,{createQuery:state.createQuery,command:'fixture-claude'});
    assert.equal(result.auth,'ready');assert.equal(result.usage.windows[0].remaining,77);
    assert.equal(state.closed,true);assert.deepEqual(state.prompts,[]);
    assert.deepEqual(state.options.tools,[]);assert.equal(state.options.persistSession,false);
    if(name==='default')assert.equal(state.options.env.CLAUDE_CONFIG_DIR,process.platform==='darwin'?undefined:defaultHome);
  });
}

test('unavailable usage stays unknown and distinguishes a failed reading from a missing subscription',async()=>{
  for(const subscription of ['max',null]){
    const state=fakeUsage(()=>({subscription_type:subscription,rate_limits_available:false,rate_limits:null}));
    await assert.rejects(probeClaude(defaultHome,{createQuery:state.createQuery,command:'fixture-claude'}),subscription?/signed in.*did not return/:/Login \(L\)/);
    assert.equal(state.closed,true);assert.deepEqual(state.prompts,[]);
  }
});
