import {probeTerminalRuntime} from './terminal-runtime.mjs';
import {handoffNotice} from './handoff.mjs';
import {parseArgs} from 'node:util';
import {installIntegration,uninstallIntegration} from './integration.mjs';
import {integration} from './native-common.mjs';
import readline from 'node:readline';
import {once} from 'node:events';
import {dataRoot,safeText} from './storage.mjs';
import {connect} from './client.mjs';
import {serve} from './server.mjs';
import {dashboard,compactStatus} from './display.mjs';
import {runDashboard} from './tui.mjs';
import {nativeLogin,executable} from './process.mjs';

export const help = 'Relay — named accounts, independent sessions\n\n'+
'  relay                                Open the interactive dashboard\n'+
'  relay install                        Integrate normal claude/codex commands once\n'+
'  relay uninstall                      Remove shell integration; keep accounts\n'+
'  relay default claude --account "Name"   Choose the account for new terminals\n'+
'  relay account add claude --name "Personal"\n'+
'  relay account add codex --name "Codex Work"\n'+
'  relay account rename "Personal" --name "Claude Personal"\n'+
'  relay account disable|enable "Personal"\n'+
'  relay login "Personal"               Renew one account login\n'+
'  relay claude --account "Personal" --session backend\n'+
'  relay codex --account "Codex Work" --session tests\n'+
'  relay claude --account "Personal" --auto --threshold 10\n'+
'        [--pool "Personal,Backup"] [--cwd PATH] [--model MODEL]\n'+
'        [--prompt "task"] [--detach]\n'+
'  relay route backend --account "Backup" [--handoff]\n'+
'  relay cancel-route backend          Cancel a queued manual route\n'+
'  relay pin backend                   Disable automatic account switching\n'+
'  relay auto backend [--threshold 10] [--pool "Personal,Backup"]\n'+
'  relay attach backend                Open a managed session\n'+
'  relay send backend --prompt "Continue the task"\n'+
'  relay stop backend                  Interrupt a session\n'+
'  relay threshold 10 [--session backend]\n'+
'  relay status [--watch] [--compact] [--json]       Account usage and session routes\n'+
'  relay sessions [--json]              Managed and detected native sessions\n'+
'  relay discover                      Refresh running native sessions\n'+
'  relay refresh [--account "Personal"]\n'+
'  relay answer REQUEST_ID --allow|--deny|--text "answer"\n'+
'  relay doctor                        Check installed CLIs and terminal launch\n'+
'  relay shutdown                      Stop the service when sessions are idle\n\n'+
'Explicit account choices are pinned unless --auto is supplied. A pool limits\n'+
'which accounts automatic routing can select. Names can be changed at any time.\n';
function terminal(){return readline.createInterface({input:process.stdin,output:process.stdout});}
function question(rl,text){return new Promise(resolve=>rl.question(text,resolve));}
async function login(api,ref,rl){
  const info=await api('account-login-info',{account:ref});
  console.log('Sign in to '+info.account.provider+' for "'+info.account.name+'".');
  rl?.pause();
  try{await nativeLogin(info.account.provider,info.home);await api('account-login-complete',{account:info.account.id});}
  finally{rl?.resume();}
  console.log('Account connected. Usage refresh requested.');
}
async function pick(rl,items,label){
  if(!items.length)throw new Error('No '+label+' available.');
  items.forEach((item,i)=>console.log('  '+(i+1)+'. '+safeText(item.name)));
  const n=Number(await question(rl,'Choose '+label+' number: '));
  if(!Number.isInteger(n) || n<1 || n>items.length)throw new Error('Invalid selection.');
  return items[n-1];
}
export async function interactiveDashboard(api,compact=false){
  if(!process.stdin.isTTY){console.log((compact?compactStatus:dashboard)(await api('snapshot')));return;}
  await runDashboard(api,{compact,onLogin:account=>login(api,account)});
}
export async function chat(api,ref,initialPrompt){
  const first=await api('session-events',{session:ref});
  const id=first.session.id;
  console.log('\n'+first.session.name+' · '+first.session.provider+' · '+first.session.accountName);
  console.log('Type a message, or /route NAME, /pin, /auto, /threshold N, /stop, /detach.');
  console.log('Approvals: /allow ID or /deny ID. Questions: /answer ID your answer.\n');
  let seq=0,busy=false,closed=false;
  const seen=new Set();
  const rl=terminal();const ended=once(rl,'close');rl.setPrompt('you> ');
  const print=text=>{
    if(process.stdout.isTTY){readline.clearLine(process.stdout,0);readline.cursorTo(process.stdout,0);}
    process.stdout.write(safeText(text)+(text.endsWith('\n')?'':'\n'));
    if(!closed)rl.prompt(true);
  };
  const poll=async()=>{
    if(busy || closed)return;busy=true;
    try{
      const update=await api('session-events',{session:id,after:seq});
      let text='';
      for(const event of update.events){
        seq=event.seq;
        if(event.type==='text' || event.type==='tool-output')text+=event.text || '';
        else if(['notice','route','error','tool'].includes(event.type))text+='\n['+event.type+'] '+event.text+'\n';
      }
      if(text)print(text);
      for(const request of update.approvals){
        if(seen.has(request.id))continue;seen.add(request.id);
        print('\n'+request.kind.toUpperCase()+' '+request.id+'\n'+request.title+'\n'+
          (request.details?JSON.stringify(request.details,null,2)+'\n':'')+
          (request.options?'Options: '+request.options.join(' / ')+'\n':'')+
          (request.kind==='approval'?'Use /allow '+request.id+' or /deny '+request.id:'Use /answer '+request.id+' your answer'));
      }
    }catch(e){print(e.message);}
    finally{busy=false;}
  };
  const timer=setInterval(poll,350);
  rl.on('line',async line=>{
    try{
      const text=line.trim();if(!text){rl.prompt();return;}
      const [command,...parts]=text.split(/\s+/);const rest=parts.join(' ');
      if(command==='/detach' || command==='/quit'){rl.close();return;}
      if(command==='/stop')await api('session-stop',{session:id});
      else if(command==='/route')await api('session-route',{session:id,account:rest.replace(/^"(.*)"$/,'$1')});
      else if(command==='/pin' || command==='/auto')await api('session-configure',{session:id,auto:command==='/auto'});
      else if(command==='/threshold')await api('session-configure',{session:id,threshold:rest});
      else if(command==='/allow' || command==='/deny')await api('answer',{id:rest,allow:command==='/allow'});
      else if(command==='/answer')await api('answer',{id:parts[0],text:parts.slice(1).join(' ')});
      else await api('session-send',{session:id,prompt:line});
    }catch(e){print(e.message);}
    rl.prompt();
  });
  rl.on('SIGINT',async()=>{await api('session-stop',{session:id}).catch(()=>{});rl.close();});
  rl.on('close',()=>{closed=true;clearInterval(timer);});
  try{if(initialPrompt)await api('session-send',{session:id,prompt:initialPrompt});await poll();if(!closed)rl.prompt();await ended;}
  finally{rl.close();clearInterval(timer);}
  console.log('Detached. Reopen with: relay attach "'+first.session.name+'"');
}
export async function main(argv=process.argv.slice(2)){
  const {values:v,positionals:p}=parseArgs({args:argv,allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean'},name:{type:'string'},account:{type:'string'},session:{type:'string'},
    threshold:{type:'string'},pool:{type:'string'},cwd:{type:'string'},model:{type:'string'},prompt:{type:'string'},text:{type:'string'},
    auto:{type:'boolean'},off:{type:'boolean'},watch:{type:'boolean'},compact:{type:'boolean'},json:{type:'boolean'},detach:{type:'boolean'},
    allow:{type:'boolean'},deny:{type:'boolean'},'no-login':{type:'boolean'},handoff:{type:'boolean'}
  }});
  if(v.help || p[0]==='help'){console.log(help);return;}
  if(v.version){console.log('0.2.3');return;}
  if(p[0]==='install'){console.log(JSON.stringify(await installIntegration(),null,2));return;}
  if(p[0]==='uninstall'){console.log((await uninstallIntegration()).message);return;}
  if(p[0]==='serve'){await serve(dataRoot());return;}
  if(p[0]==='doctor'){
    console.log('Native integration: '+(integration()?.enabled?'installed':'not installed'));
    console.log('Node '+process.version+'\nPlatform '+process.platform+'/'+process.arch+'\nData '+dataRoot());
    for(const provider of ['claude','codex'])try{console.log(provider+': '+executable(provider));}catch(e){console.log(e.message);}
    try{await probeTerminalRuntime();console.log('Terminal launch: ready (start, input, resize and exit verified)');}
    catch(error){console.log('Terminal launch: '+safeText(error.message));process.exitCode=1;}
    return;
  }
  const api=await connect();
  const pool=v.pool===undefined?undefined:v.pool.split(',').map(x=>x.trim()).filter(Boolean);
  switch(p[0]){
    case undefined:case 'dashboard':await interactiveDashboard(api);return;
    case 'account':{
      const op=p[1],ref=p[2];
      if(op==='add'){
        if(!v.name)throw new Error('Supply --name "Account name".');
        const a=await api('account-add',{provider:ref,name:v.name});
        if(!v['no-login'])await login(api,a.id);
        console.log('Added '+a.name+' ('+a.id+')');
      }else if(op==='rename'){console.log(await api('account-rename',{account:ref,name:v.name}));}
      else if(op==='enable' || op==='disable'){await api('account-enable',{account:ref,enabled:op==='enable'});}
      else throw new Error('Use account add, rename, enable, or disable.');
      return;
    }
    case 'default':console.log((await api('native-default',{provider:p[1],account:v.account})).name+' will be used for new '+p[1]+' terminals.');return;
    case 'login':await login(api,p[1]);return;
    case 'claude':case 'codex':{
      if(!v.account)throw new Error('Choose an account with --account "Name".');
      const s=await api('session-create',{provider:p[0],account:v.account,name:v.session,cwd:v.cwd || process.cwd(),model:v.model,auto:!!v.auto,threshold:v.threshold,pool});
      if(v.detach){if(v.prompt)await api('session-send',{session:s.id,prompt:v.prompt});console.log(s.name+' ('+s.id+')');}
      else await chat(api,s.id,v.prompt);
      return;
    }
    case 'attach':await chat(api,p[1]);return;
    case 'send':await api('session-send',{session:p[1],prompt:v.prompt});return;
    case 'stop':await api('session-stop',{session:p[1]});return;
    case 'route':{
      const snapshot=await api('snapshot'),session=snapshot.sessions.find(s=>s.id===p[1] || s.name.toLowerCase()===String(p[1]).toLowerCase()),account=snapshot.accounts.find(a=>a.id===v.account || a.name.toLowerCase()===String(v.account).toLowerCase());
      if(session && account && session.provider!==account.provider){
        console.log(handoffNotice.join('\n'));
        if(!v.handoff)throw new Error('Add --handoff to accept this provider handoff, or use Route in the Relay panel.');
      }
      const s=await api('session-route',{session:p[1],account:v.account});console.log(s.pending?'Switch queued at the next supported stopping point.':'Session routed.');return;}
    case 'cancel-route':await api('session-cancel-route',{session:p[1]});console.log('Queued manual route cancelled.');return;
    case 'pin':case 'auto':await api('session-configure',{session:p[1],auto:p[0]==='auto' && !v.off,threshold:v.threshold,pool});return;
    case 'threshold':await api(v.session?'session-configure':'settings',{session:v.session,threshold:p[1]});return;
    case 'discover':console.log(dashboard(await api('discover')));return;
    case 'refresh':await api('refresh',{account:v.account});console.log(dashboard(await api('snapshot')));return;
    case 'status':case 'sessions':{
      if(v.watch){await interactiveDashboard(api,!!v.compact);return;}
      const state=await api('snapshot');
      console.log(v.json?JSON.stringify(p[0]==='sessions'?[...state.sessions,...(state.externalSessions || [])]:state,null,2):v.compact?compactStatus(state):dashboard(state));return;
    }
    case 'answer':await api('answer',{id:p[1],allow:!!v.allow && !v.deny,text:v.text});return;
    case 'shutdown':await api('shutdown');console.log('Relay service stopped.');return;
    default:throw new Error('Unknown command. Run relay --help.');
  }
}
