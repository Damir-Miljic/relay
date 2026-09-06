import {CodexRPC} from '../src/rpc.mjs';
import {CodexControl,codexBridge,accountTokens} from '../src/native-codex.mjs';
import {nativeHome,nativeExecutable} from '../src/native-common.mjs';
import {WebSocket} from 'ws';
const rpc=new CodexRPC(nativeHome('codex'),nativeExecutable('codex'));
const control=new CodexControl(rpc);let bridge,client;
try{
  bridge=await codexBridge(rpc,control);await control.login(nativeHome('codex'));
  const {account}=await rpc.request('account/read',{refreshToken:false});
  if(account?.type!=='chatgpt')throw new Error('Native account verification failed.');
  client=new WebSocket(bridge.url,{headers:{Authorization:'Bearer '+bridge.token}});await new Promise((r,j)=>{client.once('open',r);client.once('error',j);});
  const result=new Promise((r,j)=>{client.once('message',raw=>r(JSON.parse(raw)));client.once('error',j);});client.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'relay_smoke',version:'1'},capabilities:{experimentalApi:true}}}));
  const initialized=await result;if(!initialized.result)throw new Error('Native websocket initialization failed.');
  const again=await control.route({home:nativeHome('codex')});if(!again)throw new Error('Account handover failed.');
  console.log('PASS: installed Codex accepts external account tokens and native WebSocket initialization; same-account live rebind succeeds. No model inference or existing-session changes.');
}finally{client?.terminate();await bridge?.close();await rpc.close();}
