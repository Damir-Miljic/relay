import pty from 'node-pty';import {fileURLToPath} from 'node:url';import {runDashboard} from '../src/tui.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv.includes('--child')){
 const state={accounts:[{id:'a',name:'Personal',provider:'claude',remaining:79,enabled:true,auth:'ready',usage:{windows:[]}},{id:'b',name:'Studio',provider:'claude',remaining:99,enabled:true,auth:'ready',usage:{windows:[]}}],sessions:[{id:'s',name:'Demo',provider:'claude',accountName:'Personal',status:'idle',auto:false,threshold:10,canRoute:true,integrated:true}],externalSessions:[]};
 await runDashboard(async(op,args)=>{if(op==='session-route'){if(args.session!=='s' || args.account!=='b')throw new Error('Wrong routing choice');state.sessions[0].accountName='Studio';}return structuredClone(state);});
}else{
 const child=pty.spawn(process.execPath,[fileURLToPath(import.meta.url),'--child'],{name:'xterm-256color',cols:100,rows:30,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'},useConpty:true,useConptyDll:true});let output='',ended=false,exitCode;
 child.onData(text=>{output=(output+text).slice(-100000);});child.onExit(e=>{ended=true;exitCode=e.exitCode;});
 const until=async predicate=>{const end=Date.now()+15000;while(Date.now()<end && !predicate() && !ended)await delay(50);if(!predicate())throw new Error('Terminal UI did not reach expected state.');};
 const has=text=>output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'').includes(text.replace(/\s/g,''));
 try{
  await until(()=>has('Demo'));child.write('r');await until(()=>has('Choose a session'));child.write('\r');await until(()=>has('Route Demo'));child.write('\x1b[B');await delay(100);child.write('\r');await until(()=>has('Route requested:'));
  child.resize(65,22);await delay(300);child.resize(120,36);await delay(300);child.write('q');await until(()=>ended);if(exitCode!==0)throw new Error('Dashboard exited with '+exitCode);console.log('PASS: real Windows terminal opens the dashboard, routes through the menu, resizes and exits cleanly.');
 }finally{if(!ended)child.kill();}
 setTimeout(()=>process.exit(0),200);
}
