import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';
import {premiumFrame,width,plain} from '../src/premium-display.mjs';import {TerminalScreen,runDashboard} from '../src/tui.mjs';
const fixture=()=>({settings:{staleSeconds:300},accounts:[{id:'a',name:'Claude Personal',provider:'claude',remaining:79,enabled:true,auth:'ready',usage:{windows:[{label:'5h',remaining:91,resetsAt:Date.now()/1000+5000}]}},{id:'b',name:'Work 世界 👩‍💻',provider:'claude',remaining:22,enabled:true,auth:'ready',usage:{windows:[]}},{id:'c',name:'Codex',provider:'codex',remaining:null,enabled:true,auth:'ready',usage:{windows:[]}}],sessions:[{id:'s',name:'Demo',provider:'claude',accountId:'a',accountName:'Claude Personal',status:'idle',auto:false,threshold:10,integrated:true,canRoute:true,cwd:'C:/work/project'}],externalSessions:[{name:'Other session',accountName:'Codex',provider:'codex',status:'open',cwd:'C:/work'}],externalProcesses:[]});
const pause=()=>new Promise(r=>setTimeout(r,20));
test('dashboard stays inside the viewport at narrow, wide, short and resized dimensions',()=>{
  const state=fixture();state.accounts.push(...Array.from({length:8},(_,i)=>({...state.accounts[0],name:'Account '+i})));state.sessions.push(...Array.from({length:15},(_,i)=>({...state.sessions[0],name:'Session '+i,pendingName:'Backup',boundary:'Waiting for a background task to finish before continuing safely.'})));
  for(const columns of [25,38,55,80,120,180])for(const rows of [8,12,18,30,45])for(const compact of [true,false])for(const detectedExpanded of [true,false]){
    const frame=premiumFrame(state,{columns,rows,compact,detectedExpanded,offset:200});assert.equal(frame.lines.length,rows);for(const line of frame.lines)assert.ok(width(line)<=columns-1,'Overflow at '+columns+'x'+rows+': '+plain(line));
    assert.doesNotMatch(frame.lines.join(''),/Open session/);
  }
});
test('screen refreshes use absolute cursor placement without line feeds or scroll commands',()=>{
  const output=new PassThrough();output.columns=80;output.rows=24;let all='';output.on('data',d=>all+=d);const screen=new TerminalScreen(output);screen.enter();screen.paint(['First frame']);const before=all.length;screen.paint(['First frame']);assert.equal(all.length,before);screen.paint(['Changed frame']);output.columns=45;output.rows=16;screen.paint(['Resized frame']);screen.leave();
  assert.match(all,/\x1b\[\?1049h/);assert.match(all,/\x1b\[\?1049l/);assert.doesNotMatch(all,/[\r\n]/);assert.doesNotMatch(all,/\x1b\[\d*[ST]/);assert.match(all,/\x1b\[\?7h/);
});
test('routing through the keyboard menu preserves per-session targeting and exits the alternate screen',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.columns=100;output.rows=30;input.setRawMode=value=>{input.isRaw=value;};let all='';output.on('data',d=>all+=d);const state=fixture(),calls=[];
  const api=async(op,args)=>{calls.push({op,args});if(op==='session-route')return {};return structuredClone(state);};
  const running=runDashboard(api,{input,output});await pause();input.emit('keypress','r',{name:'r'});await pause();input.emit('keypress','\r',{name:'return'});await pause();input.emit('keypress','',{name:'down'});input.emit('keypress','\r',{name:'return'});await pause();
  assert.deepEqual(calls.find(x=>x.op==='session-route').args,{session:'s',account:'b'});input.emit('keypress','q',{name:'q'});await running;assert.equal(input.isRaw,false);assert.match(all,/\x1b\[\?1049l/);assert.doesNotMatch(all,/[\r\n]/);
});
test('canceling a menu performs no account mutation',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.columns=75;output.rows=25;input.setRawMode=value=>{input.isRaw=value;};output.resume();const calls=[];const running=runDashboard(async(op,args)=>{calls.push({op,args});return fixture();},{input,output});await pause();input.emit('keypress','n',{name:'n'});await pause();input.emit('keypress','',{name:'escape'});await pause();input.emit('keypress','q',{name:'q'});await running;assert.equal(calls.some(c=>c.op==='account-rename'),false);
});

test('Settings saves a default above 50 without changing a session threshold',async()=>{
 const input=new PassThrough(),output=new PassThrough();output.columns=100;output.rows=30;input.setRawMode=value=>{input.isRaw=value;};let all='';output.on('data',d=>all+=d);const state=fixture(),calls=[];state.settings.threshold=10;
 const api=async(op,args)=>{calls.push({op,args});if(op==='settings'){state.settings.threshold=args.threshold;return state.settings;}return structuredClone(state);};
 const running=runDashboard(api,{input,output});await pause();input.emit('keypress','s',{name:'s'});await pause();input.emit('keypress','\r',{name:'return'});await pause();input.emit('keypress','75',{name:'7'});input.emit('keypress','\r',{name:'return'});await pause();
 assert.deepEqual(calls.find(c=>c.op==='settings').args,{threshold:75});assert.equal(state.sessions[0].threshold,10);assert.equal(calls.some(c=>c.op==='session-configure'),false);
 input.emit('keypress','q',{name:'q'});await running;assert.match(plain(all),/Settings/);
});


test('Help opens working commands and detected rows stay hidden until expanded',async()=>{
 const input=new PassThrough(),output=new PassThrough();output.columns=120;output.rows=45;input.setRawMode=value=>{input.isRaw=value;};let all='';output.on('data',d=>all+=d);const state=fixture(),calls=[];state.externalProcesses=[{}];
 const running=runDashboard(async(op,args)=>{calls.push({op,args});return structuredClone(state);},{input,output});
 try{
  await pause();assert.doesNotMatch(plain(all),/Other session|other native process/);assert.match(plain(all),/D Expand/);
  all='';input.emit('keypress','d',{name:'d'});await pause();assert.match(plain(all),/Other session/);assert.match(plain(all),/other native process/);
  input.emit('keypress','d',{name:'d'});await pause();all='';input.emit('keypress','?',{name:undefined});await pause();assert.match(plain(all),/Help & commands/);
  input.emit('keypress','6',{name:'6'});input.emit('keypress','\r',{name:'return'});await pause();input.emit('keypress','\r',{name:'return'});await pause();
  assert.deepEqual(calls.find(c=>c.op==='session-configure').args,{session:'s',auto:true});
 }finally{input.emit('keypress','q',{name:'q'});await running;}
});

test('success banners expire while action errors stay visible',async()=>{
 const input=new PassThrough(),output=new PassThrough();output.columns=110;output.rows=35;input.setRawMode=value=>{input.isRaw=value;};let all='';output.on('data',d=>all+=d);let fail=false;
 const running=runDashboard(async op=>{if(op==='refresh'&&fail)throw new Error('Usage service unavailable');return fixture();},{input,output,noticeDuration:60});
 try{
  await pause();input.emit('keypress','f',{name:'f'});await pause();assert.match(plain(all),/Usage and sessions refreshed/);
  all='';await new Promise(r=>setTimeout(r,100));assert.match(plain(all),/Usage remaining/);
  fail=true;all='';input.emit('keypress','f',{name:'f'});await pause();assert.match(plain(all),/Usage service unavailable/);
  all='';await new Promise(r=>setTimeout(r,100));assert.doesNotMatch(plain(all),/Usage remaining/);
 }finally{input.emit('keypress','q',{name:'q'});await running;}
});

test('manual cross-provider routing displays an explanation and defaults to going back',async()=>{
 const state=fixture();state.sessions[0].canHandoff=true;const input=new PassThrough(),output=new PassThrough();output.columns=115;output.rows=36;input.setRawMode=()=>{};let all='';output.on('data',d=>all+=d);const calls=[];
 const run=runDashboard(async(op,args)=>{calls.push({op,args});return structuredClone(state);},{input,output});
 const key=async(name,text='')=>{input.emit('keypress',text,{name});await pause();};
 try{
  await pause();await key('r','r');await key('return');await key('down');await key('down');await key('return');
  assert.match(plain(all),/new conversation/i);assert.match(plain(all),/other provider/);assert.equal(calls.some(c=>c.op==='session-route'),false);
  await key('return');await key('return');assert.equal(calls.some(c=>c.op==='session-route'),false);
  await key('r','r');await key('return');await key('down');await key('down');await key('return');await key('return');await key('down');await key('return');
  assert.deepEqual(calls.find(c=>c.op==='session-route').args,{session:'s',account:'c'});
 }finally{input.emit('keypress','q',{name:'q'});await run;}
});
test('Settings provider auto is explicit and cancellation targets the selected command',async()=>{
 const state=fixture();state.sessions[0]={...state.sessions[0],pending:'b',pendingName:'Backup',pendingReason:'manual',commandId:'expected-command',canCancel:true};
 const input=new PassThrough(),output=new PassThrough();output.columns=110;output.rows=36;input.setRawMode=()=>{};output.resume();const calls=[];
 const run=runDashboard(async(op,args)=>{calls.push({op,args});return structuredClone(state);},{input,output});
 const key=async name=>{input.emit('keypress',name,{name});await pause();};
 try{
  await pause();await key('s');await key('down');await key('return');await key('return');await key('down');await key('return');
  assert.deepEqual(calls.find(c=>c.op==='settings').args,{crossProviderAuto:true});
  await key('c');await key('return');assert.deepEqual(calls.find(c=>c.op==='session-cancel-route').args,{session:'s',commandId:'expected-command'});
 }finally{input.emit('keypress','q',{name:'q'});await run;}
});
test('committed route displays switching and long notices can scroll in a small terminal',()=>{
 const state=fixture();state.sessions[0]={...state.sessions[0],pending:'b',pendingName:'Backup',committing:'command'};
 assert.match(plain(premiumFrame(state,{columns:100,rows:35}).lines.join('\n')),/SWITCHING/);
 const frame=premiumFrame(state,{columns:42,rows:15,dialog:{kind:'info',title:'Handoff',lines:['First paragraph '.repeat(20),'Last paragraph'],offset:100}});
 assert.ok(frame.maxOffset>0);assert.match(plain(frame.lines.join('\n')),/Last paragraph/);
});
