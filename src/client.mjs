import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {dataRoot,readJson,privateDir} from './storage.mjs';
import {withRuntimeVersions} from './runtime-version.mjs';
import {SessionMetadata} from './session-metadata.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class RelayConnectionError extends Error {constructor(cause){super('Relay connection interrupted; waiting to reconnect.',{cause});this.name='RelayConnectionError';}}
export async function rpcCall(endpoint,op,args={}){
  const res=await fetch('http://127.0.0.1:'+endpoint.port+'/rpc',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+endpoint.token},
    body:JSON.stringify({op,args}),signal:AbortSignal.timeout(op==='refresh'||op==='account-login-complete'?90000:40000)
  }).catch(error=>{throw new RelayConnectionError(error);});
  const value=await res.json().catch(error=>{throw new RelayConnectionError(error);});
  if(!res.ok || value.error)throw new Error(value.error || 'Relay request failed.');
  return value.result;
}
export async function connect(root=dataRoot()){
  // Load SQLite before opening the terminal screen (Node 22 may emit a one-time warning).
  await import('node:sqlite');
  const metadata=new SessionMetadata(root);
  const file=path.join(root,'endpoint.json');
  const tryExisting=async()=>{
    const endpoint=readJson(file,null);if(!endpoint)return null;
    try{await rpcCall(endpoint,'ping');return async(op,args)=>{const value=await rpcCall(endpoint,op,args);return ['snapshot','discover','refresh'].includes(op)?metadata.enrich(withRuntimeVersions(root,value)):value;};}catch{return null;}
  };
  const existing=await tryExisting();if(existing)return existing;
  privateDir(root);
  const bin=fileURLToPath(new URL('../bin/relay.mjs',import.meta.url));
  const log=fs.openSync(path.join(root,'daemon.log'),'a',0o600);
  const child=spawn(process.execPath,[bin,'serve'],{env:{...process.env,RELAY_HOME:root},detached:true,windowsHide:true,stdio:['ignore',log,log],shell:false});
  let spawnError;child.once('error',e=>{spawnError=e;});child.unref();fs.closeSync(log);
  for(let i=0;i<60;i++){await pause(100);if(spawnError)throw new Error('Relay could not start: '+spawnError.message);const client=await tryExisting();if(client)return client;}
  throw new Error('Relay could not start. See '+path.join(root,'daemon.log'));
}
