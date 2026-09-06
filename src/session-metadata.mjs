import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {safeText} from './storage.mjs';
import {readThreadMetadata} from './codex-discovery.mjs';

const clean=value=>typeof value==='string' && value.trim()?safeText(value).replace(/[\r\n\t]/g,' ').trim().slice(0,100):null;
const validId=id=>typeof id==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
export function claudeModelMetadata(text,id){
  let found={model:null,effort:null,modelSource:'last response'};
  for(const line of text.split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row.type!=='assistant' || row.isSidechain===true || (row.sessionId || row.session_id)!==id)continue;
    const model=clean(row.message?.model);
    if(!model || model==='<synthetic>')continue;
    found={model,effort:clean(row.effort),modelSource:'last response'};
  }
  return found;
}
export function readClaudeModel(home,id){
  if(!validId(id))return null;
  const projects=path.join(home,'projects');
  let dirs;try{dirs=fs.readdirSync(projects,{withFileTypes:true});}catch{return null;}
  for(const dir of dirs.slice(0,4000)){
    if(!dir.isDirectory() || dir.isSymbolicLink())continue;
    const file=path.join(projects,dir.name,id+'.jsonl');
    let fd;
    try{
      const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink())continue;
      fd=fs.openSync(file,'r');
      const length=Math.min(stat.size,4*1024*1024),buffer=Buffer.alloc(length);
      const count=fs.readSync(fd,buffer,0,length,Math.max(0,stat.size-length));
      return claudeModelMetadata(buffer.subarray(0,count).toString('utf8'),id);
    }catch{/* The native transcript may not exist yet. */}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  return null;
}
export class SessionMetadata{
  constructor(root,{claude=readClaudeModel,codex=readThreadMetadata,now=Date.now}={}){
    Object.assign(this,{root,claude,codex,now});this.cache=new Map();
  }
  async enrich(state){
    if(!Array.isArray(state?.accounts))return state;
    const accounts=new Map(state.accounts.map(a=>[a.id,a]));
    const live=new Set();
    const read=async session=>{
      if(!validId(session.nativeId))return session;
      const a=accounts.get(session.accountId),home=a?.nativeHome || (a?path.join(this.root,'accounts',a.id):null);
      // Codex's interactive app-server owns history in the native home; named homes hold logins.
      const homes=[...new Set((session.provider==='codex'
        ?[process.env.CODEX_HOME,path.join(os.homedir(),'.codex'),home]
        :[home,process.env.CLAUDE_CONFIG_DIR,path.join(os.homedir(),'.claude')]).filter(Boolean))];
      const key=JSON.stringify([session.provider,session.nativeId,homes]);live.add(key);
      let cached=this.cache.get(key);
      if(!cached || this.now()-cached.at>=3000){
        let info=null;
        for(const candidate of homes){
          try{
            const value=session.provider==='claude'?this.claude(candidate,session.nativeId):session.provider==='codex'?await this.codex(candidate,session.nativeId):null;
            if(!value || value.internal)continue;
            info={model:clean(value.model),effort:clean(value.effort ?? value.reasoning_effort),modelSource:session.provider==='claude'?'last response':'session metadata'};
            if(info.model || info.effort)break;
          }catch{/* Missing or locked metadata is unknown; never affect native work. */}
        }
        cached={at:this.now(),info};this.cache.set(key,cached);
      }
      return cached.info?{...session,...cached.info}:session;
    };
    const sessions=await Promise.all((state.sessions || []).map(read));
    const externalSessions=await Promise.all((state.externalSessions || []).map(read));
    for(const key of this.cache.keys())if(!live.has(key))this.cache.delete(key);
    return {...state,sessions,externalSessions};
  }
}
