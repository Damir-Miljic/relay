import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexRPC} from '../src/rpc.mjs';
import {probe,transferHistory} from '../src/providers.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-'));
const home=path.join(root,'codex-a'),other=path.join(root,'codex-b'),claude=path.join(root,'claude');
for(const dir of [home,other,claude])fs.mkdirSync(dir,{recursive:true});
const rpc=new CodexRPC(home);
try{
 await rpc.initialize();const account=await rpc.request('account/read',{refreshToken:false});
 console.log('Codex isolated auth:',account.account===null?'no account (expected)':'UNEXPECTED LOGIN');
 if(account.account)throw new Error('Isolation failed');
 const {thread}=await rpc.request('thread/start',{cwd:root,sandbox:'read-only',approvalPolicy:'on-request'});
 console.log('Codex thread created:',!!thread.id);
 await rpc.request('thread/inject_items',{threadId:thread.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Local resume fixture. No inference requested.'}]}]});
 await rpc.close();
 transferHistory({provider:'codex',nativeId:thread.id},home,other);
 const second=new CodexRPC(other);
 try{await second.initialize();const resumed=await second.request('thread/resume',{threadId:thread.id,cwd:root,sandbox:'read-only',approvalPolicy:'on-request'});if(resumed.thread.id!==thread.id)throw new Error('Native resume ID mismatch');console.log('Codex cross-home native resume: PASS');}
 finally{await second.close();}
 let rejected=false;
 try{await probe('claude',claude);}
 catch(e){if(!/subscription usage is unavailable/.test(e.message))throw e;rejected=true;console.log('Claude unsigned usage probe: rejected as expected');}
 if(!rejected)throw new Error('Expected an unsigned account to be rejected');
}finally{
 await rpc.close();
 // These are freshly created test directories, never real account homes.
 const checked=path.resolve(root);if(!checked.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe cleanup');
 fs.rmSync(checked,{recursive:true,force:true});
}
