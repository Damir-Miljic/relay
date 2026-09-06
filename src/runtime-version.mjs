import path from 'node:path';
import pkg from '../package.json' with {type:'json'};
import {privateDir,writeJson,readJson} from './storage.mjs';
export const relayVersion=pkg.version;
const directory=(root,id)=>/^native:[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id || '')?path.join(root,'native',id.replace(':','-')):null;
export function recordRuntime(root,session){const dir=directory(root,session.id);if(!dir)throw new Error('Invalid native session identifier.');privateDir(dir);writeJson(path.join(dir,'runtime.json'),{sessionId:session.id,supervisorPid:process.pid,version:relayVersion});}
export function withRuntimeVersions(root,state){
  if(!state || !Array.isArray(state.sessions))return state;
  return {...state,sessions:state.sessions.map(s=>{
    if(!s.integrated)return s;const dir=directory(root,s.id);if(!dir)return s;const marker=readJson(path.join(dir,'runtime.json'),null);
    const version=marker?.sessionId===s.id && marker?.supervisorPid===s.supervisorPid?marker.version:null;
    return {...s,runtimeVersion:version,restartRequired:typeof version!=='string' || version.localeCompare(relayVersion,undefined,{numeric:true})<0};
  })};
}
