import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalInputState} from '../src/terminal-input.mjs';
import {ClaudeBoundary,claudeWaitReason} from '../src/native-claude.mjs';
import {dashboard,compactStatus} from '../src/display.mjs';

test('VS Code focus and terminal reports never become a draft, even in split chunks',()=>{
  const reports=['\x1b[I','\x1b[O','\x1b[1;42R','\x1b[?1;2c','\x1b[>0;10;1c','\x1b[8;32;110t','\x1b[?1u','\x1b]10;rgb:ffff/ffff/ffff\x07','\x1b]11;rgb:0000/0000/0000\x1b\\','\x1bP>|terminal\x1b\\','\x1b[<35;10;20M'];
  for(const sequence of reports)for(let split=0;split<=sequence.length;split++){
    const input=new TerminalInputState();input.feed(sequence.slice(0,split));input.feed(sequence.slice(split));assert.equal(input.hasDraft,false,JSON.stringify(sequence));assert.equal(input.revision,0);
  }
});
test('a completed turn can switch while idle after focus reports, without a new user prompt',()=>{
  const input=new TerminalInputState(),boundary=new ClaudeBoundary(),send=(event,extra={})=>boundary.observe({event,sessionId:'s',...extra});
  send('SessionStart',{source:'startup'});input.feed('Please finish the task.\r');assert.equal(input.hasDraft,true);send('UserPromptSubmit');input.submitted();send('Stop',{backgroundCount:0,cronCount:0});
  input.feed('\x1b[O\x1b[I\x1b[1;1R');assert.equal(boundary.safeIdle && !input.hasDraft,true);
  input.feed('Keep this draft');assert.equal(boundary.safeIdle && !input.hasDraft,false);
  input.feed('\x15');assert.equal(boundary.safeIdle && !input.hasDraft,true);
});
test('typing then deleting or clearing an ordinary draft unblocks the idle switch',()=>{
  for(const [text,clear] of [['abc','\x7f\x7f\x7f'],['abc','\x08\x08\x08'],['abc','\x15'],['one two','\x17\x17']]){
    const input=new TerminalInputState();input.feed(text);assert.equal(input.hasDraft,true);input.feed(clear);assert.equal(input.hasDraft,false);
  }
  const input=new TerminalInputState();input.feed('abc\x1b[H\x1b[3~\x1b[3~\x1b[3~');assert.equal(input.hasDraft,false);
  input.feed('abc\x1b[D\x15');assert.equal(input.hasDraft,true);input.feed('\x0b');assert.equal(input.hasDraft,false);
});
test('Enter needs native submission confirmation, which preserves a newly typed next draft',()=>{
  const input=new TerminalInputState();input.feed('first\r');assert.equal(input.hasDraft,true);input.feed('next draft');input.submitted();assert.equal(input.hasDraft,true);input.feed('\x15');assert.equal(input.hasDraft,false);
  input.feed('another\r');input.submitted();assert.equal(input.hasDraft,false);
});
test('pasted multiline input is not a submission and control-looking pasted text stays protected',()=>{
  const input=new TerminalInputState();for(const c of '\x1b[200~one\ntwo\x1b[201~')input.feed(c);assert.equal(input.hasDraft,true);assert.equal(input.pendingSubmit,false);input.feed('\r');input.submitted();assert.equal(input.hasDraft,false);
  input.feed('\x1b[200~\x1b[I\x1b[201~');assert.equal(input.hasDraft,true);
});
test('history and uncertain editor operations are protected until submit or cancel',()=>{
  const input=new TerminalInputState();input.feed('\x1b[A');assert.equal(input.hasDraft,true);input.feed('\x15');assert.equal(input.hasDraft,true);input.feed('\r');input.submitted();assert.equal(input.hasDraft,false);
  input.feed('\t');assert.equal(input.hasDraft,true);input.feed('\x03');assert.equal(input.hasDraft,false);
});
test('extended Windows and Kitty keyboard reports distinguish actual text and key releases',()=>{
  const input=new TerminalInputState();input.feed('\x1b[97;1:3u');assert.equal(input.hasDraft,false);input.feed('\x1b[97;1u');assert.equal(input.hasDraft,true);input.feed('\x7f');assert.equal(input.hasDraft,false);
  input.feed('\x1b[65;30;97;0;0;1_');assert.equal(input.hasDraft,false);input.feed('\x1b[65;30;97;1;0;1_');assert.equal(input.hasDraft,true);input.feed('\x1b[8;14;8;1;0;1_');assert.equal(input.hasDraft,false);
});
test('background work remains a visible switch blocker despite an empty native prompt',()=>{
  const boundary=new ClaudeBoundary();boundary.observe({event:'SessionStart',sessionId:'s',source:'startup'});boundary.observe({event:'Stop',sessionId:'s',backgroundCount:1,cronCount:0,backgroundKinds:['shell']});
  assert.equal(boundary.safeIdle,false);assert.match(claudeWaitReason(boundary),/1 background task \(shell\)/);
  boundary.observe({event:'Stop',sessionId:'s',backgroundCount:null,cronCount:0});assert.equal(boundary.safeIdle,false);assert.match(claudeWaitReason(boundary),/confirm/);
  boundary.observe({event:'Stop',sessionId:'s',backgroundCount:0,cronCount:0});assert.match(claudeWaitReason(boundary,true),/unsubmitted/);assert.equal(claudeWaitReason(boundary),'Ready to switch.');
});
test('compact and full panels show each queued reason directly under its own session',()=>{
  const state={accounts:[],settings:{staleSeconds:300},sessions:[{name:'VS Code',accountName:'First',pendingName:'Second',status:'idle',integrated:true,boundary:'Waiting for 1 background task (shell).',auto:false},{name:'Terminal',accountName:'First',pendingName:'Second',status:'idle',integrated:true,boundary:'Waiting for unsubmitted text.',error:'Login failed.',auto:false}],externalSessions:[],externalProcesses:[]};
  for(const render of [dashboard,compactStatus]){const lines=render(state).split('\n');const vs=lines.findIndex(x=>x.includes('VS Code')),terminal=lines.findIndex(x=>x.includes('Terminal'));assert.match(lines[vs],/switch queued/);assert.match(lines[vs+1],/background task/);assert.match(lines[terminal+1],/unsubmitted text/);assert.equal(lines[terminal+2].trim(),'Login failed.');}
});
test('Relay-confirmed clean resume remains eligible for another idle route without a new prompt',()=>{
  const b=new ClaudeBoundary();b.observe({event:'SessionStart',sessionId:'s',source:'startup'});b.observe({event:'Stop',sessionId:'s',backgroundCount:0,cronCount:0});b.prepareCleanResume();b.observe({event:'SessionStart',sessionId:'s',source:'resume'});assert.equal(b.safeIdle,true);assert.equal(claudeWaitReason(b),'Ready to switch.');
  const unknown=new ClaudeBoundary();unknown.observe({event:'SessionStart',sessionId:'s',source:'resume'});assert.equal(unknown.safeIdle,false);
});
