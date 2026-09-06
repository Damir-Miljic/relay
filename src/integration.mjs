import {probeTerminalRuntime} from './terminal-runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute,executable} from './process.mjs';
import {readIdentity} from './identity.mjs';
import {Store,privateDir,writeJson,readJson,dataRoot} from './storage.mjs';
import {installationFile,integration,nativeHome} from './native-common.mjs';

const quotePS=s=>"'"+s.replaceAll("'","''")+"'";
const quoteSH=s=>"'"+s.replaceAll("'","'\\''")+"'";
const start='# >>> Relay native integration >>>',end='# <<< Relay native integration <<<';
export function replaceBlock(content,block){
  const a=content.indexOf(start),b=content.indexOf(end);
  if((a<0)!==(b<0) || (a>=0 && b<a))throw new Error('Incomplete Relay block. Restore this shell profile from its backup.');
  const clean=a>=0?content.slice(0,a)+content.slice(b+end.length).replace(/^\r?\n/,''):content;
  return block?clean.replace(/\s*$/,'')+'\n\n'+start+'\n'+block+'\n'+end+'\n':clean;
}
function profileEdit(file,block){
  privateDir(path.dirname(file));const current=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const next=replaceBlock(current,block);if(next===current)return;
  if(current && !fs.existsSync(file+'.pre-relay'))fs.copyFileSync(file,file+'.pre-relay');
  fs.writeFileSync(file,next,{mode:0o600});
}
async function powershell(script){return execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000});}
function copyProfile(source,target){
  privateDir(target);
  for(const name of ['.credentials.json','.claude.json','settings.json','auth.json','config.toml']){
    const file=path.join(source,name);if(fs.existsSync(file) && fs.statSync(file).isFile()){fs.copyFileSync(file,path.join(target,name));if(process.platform!=='win32')fs.chmodSync(path.join(target,name),0o600);}
  }
}
export function resolveIntegrationExecutables(previous={}, {find=executable,exists=file=>fs.existsSync(file) && fs.statSync(file).isFile()}={}){
  const result={};
  for(const provider of ['claude','codex']){
    try{result[provider]=previous[provider] && exists(previous[provider])?previous[provider]:find(provider);}
    catch(error){if(error.code!=='RELAY_CLI_NOT_FOUND')throw error;}
  }
  if(!Object.keys(result).length)throw new Error('Install Claude Code or Codex before installing Relay. Only one native client is required.');
  return result;
}
export async function installIntegration(){
  await probeTerminalRuntime(); // Check and repair the terminal dependency before changing shell profiles.
  const previous=integration(),oldRoot=dataRoot();
  const base=path.dirname(installationFile()),root=previous?.root || path.join(base,'data'),bin=path.join(base,'bin');
  const executables=resolveIntegrationExecutables(previous?.executables),providers=Object.keys(executables),commands=[...providers,'relay'];
  privateDir(base);privateDir(root);privateDir(bin);
  const source=fileURLToPath(new URL('..',import.meta.url));
  const store=new Store(root),found=[];
  if(!previous && path.resolve(oldRoot)!==path.resolve(root)){
    const legacy=new Store(oldRoot);
    if(legacy.state.accounts.length){
      for(const a of legacy.state.accounts){if(store.state.accounts.some(x=>x.id===a.id))continue;const home=legacy.home(a);store.state.accounts.push({...a,nativeHome:undefined});copyProfile(home,store.home(a));}
      store.state.settings={...store.state.settings,...legacy.state.settings};
    }else{
      // Recover valid isolated logins from early preview versions without changing the old store.
      const accounts=path.join(oldRoot,'accounts');
      if(fs.existsSync(accounts))for(const folder of fs.readdirSync(accounts,{withFileTypes:true}).filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
        const home=path.join(accounts,folder.name),provider=fs.existsSync(path.join(home,'.credentials.json'))?'claude':fs.existsSync(path.join(home,'auth.json'))?'codex':null;
        if(!providers.includes(provider) || !await readIdentity(provider,home).catch(()=>null))continue;
        const n=store.state.accounts.filter(a=>a.provider===provider).length+1,a=store.add(provider,(provider==='claude'?'Claude':'Codex')+' Account '+n);copyProfile(home,store.home(a));a.auth='ready';
      }
    }
  }
  for(const provider of providers){
    const home=nativeHome(provider),identity=await readIdentity(provider,home).catch(()=>null);if(!identity)continue;
    let match;
    for(const a of store.state.accounts.filter(a=>a.provider===provider)){const id=await readIdentity(provider,store.home(a)).catch(()=>null);if(id?.key===identity.key){match=a;break;}}
    if(!match){match=store.add(provider,(provider==='claude'?'Claude':'Codex')+' current');match.nativeHome=home;match.auth='ready';}
    if(!previous)match.nativeHome=home;
    store.state.settings.nativeDefaults ||= {};store.state.settings.nativeDefaults[provider] ||= match.id;found.push({provider,name:match.name});
  }
  store.save();
  fs.writeFileSync(path.join(bin,'.relay-shims'),'Relay generated command launchers\n');
  const native=path.join(source,'bin','relay-native.mjs'),relay=path.join(source,'bin','relay.mjs');
  // Remove only our obsolete launchers if a previously installed client was removed.
  for(const provider of ['claude','codex'].filter(p=>!providers.includes(p))){
    const shim=path.join(bin,provider+(process.platform==='win32'?'.cmd':''));
    if(fs.existsSync(shim) && fs.readFileSync(shim,'utf8').includes('relay-native.mjs'))fs.unlinkSync(shim);
  }
  const profiles=[];
  if(process.platform==='win32'){
    for(const provider of commands)fs.writeFileSync(path.join(bin,provider+'.cmd'),'@echo off\r\n"'+process.execPath+'" "'+(provider==='relay'?relay:native)+'" '+(provider==='relay'?'':provider+' ')+'%*\r\n');
    const {stdout}=await powershell('[Environment]::GetFolderPath("MyDocuments")');const documents=stdout.trim();if(!path.isAbsolute(documents))throw new Error('Cannot resolve the PowerShell profile folder.');
    for(const shell of ['WindowsPowerShell','PowerShell']){
      const file=path.join(documents,shell,'profile.ps1');
      const lines=commands.map(p=>'function global:'+p+' { & '+quotePS(process.execPath)+' '+quotePS(p==='relay'?relay:native)+(p==='relay'?'':' '+quotePS(p))+' @args }');
      profiles.push(file);profileEdit(file,lines.join('\n'));
    }
    await powershell('$relayBin='+quotePS(bin)+'; $relayPath=[Environment]::GetEnvironmentVariable("Path","User"); $relayParts=@($relayPath -split ";" | Where-Object { $_ -and $_ -ne $relayBin }); [Environment]::SetEnvironmentVariable("Path",(($relayBin)+";"+($relayParts -join ";")),"User")');
  }else{
    for(const provider of commands)fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nexec '+quoteSH(process.execPath)+' '+quoteSH(provider==='relay'?relay:native)+(provider==='relay'?'':' '+provider)+' "$@"\n',{mode:0o755});
    for(const name of ['.zshrc','.bashrc','.bash_profile']){const file=path.join(os.homedir(),name);profiles.push(file);profileEdit(file,'export PATH='+quoteSH(bin)+':"$PATH"');}
  }
  const config={version:1,enabled:true,root,source,node:process.execPath,executables,profiles,installedAt:previous?.installedAt || Date.now()};writeJson(installationFile(),config);
  return {root,profiles,accounts:store.state.accounts.map(a=>({id:a.id,name:a.name,provider:a.provider})),defaults:found,providers,message:'Integration installed for '+providers.join(' and ')+'. Open a new terminal and keep using your normal commands. To add another provider later, install its native client and run relay install again.'};
}
export async function uninstallIntegration(){
  const config=integration();if(!config)return {message:'Integration is not installed.'};
  for(const file of config.profiles || [])if(fs.existsSync(file))profileEdit(file,null);
  const bin=path.join(path.dirname(installationFile()),'bin');
  if(process.platform==='win32')await powershell('$relayBin='+quotePS(bin)+'; $relayPath=[Environment]::GetEnvironmentVariable("Path","User"); [Environment]::SetEnvironmentVariable("Path",((@($relayPath -split ";" | Where-Object { $_ -and $_ -ne $relayBin })) -join ";"),"User")');
  config.enabled=false;writeJson(installationFile(),config);return {message:'Native launch integration removed. Account data is preserved in '+config.root};
}
