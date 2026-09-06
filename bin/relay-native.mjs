#!/usr/bin/env node
import {connect} from '../src/client.mjs';
import {dataRoot} from '../src/storage.mjs';
import {recordRuntime} from '../src/runtime-version.mjs';
import {eligible,passthrough,integration} from '../src/native-common.mjs';
const [provider,...args]=process.argv.slice(2);
if(!['claude','codex'].includes(provider))throw new Error('Invalid native provider.');
let launched=false;
try{
  if(!integration()?.enabled || !eligible(provider,args)){process.exitCode=await passthrough(provider,args);}
  else{
    if(provider==='claude'){const {resumeOptions}=await import('../src/native-claude.mjs');resumeOptions(args);}
    const api=await connect();
    const ping=await api('ping');if(!/^0\.2\.\d+$/.test(ping.version || ''))throw new Error('Restart Relay to load its native integration.');
    const registration=await api('native-register',{provider,protocol:ping.capabilities?.handoff===1?1:0,pid:process.pid,cwd:process.cwd(),account:process.env.RELAY_ACCOUNT,name:provider==='claude' && args.includes('--name')?args[args.indexOf('--name')+1]:undefined});
    recordRuntime(dataRoot(),registration.session);
    const {superviseNative:runner}=await import('../src/native-supervisor.mjs');
    launched=true;process.exitCode=await runner(api,registration,args,{root:dataRoot()});
  }
}catch(e){
  console.error('Relay integration: '+String(e.message).replace(/[\x00-\x1f\x7f]/g,' '));
  if(!launched){console.error('Opening the native command without account control.');process.exitCode=await passthrough(provider,args);}else process.exitCode=1;
}
