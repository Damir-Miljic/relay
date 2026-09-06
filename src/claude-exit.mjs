import {delay} from './native-common.mjs';

// Ctrl+D is Claude's hardcoded app-exit action. Enter can activate a selected
// footer artifact instead of submitting /exit, so handovers never send Enter.
// The caller has already established an empty draft and a safe native boundary.
export async function requestClaudeExit(terminal,{pause=delay}={}){
  terminal.child.write('\x04');
  const closed=await Promise.race([terminal.exited.then(()=>true),pause(180).then(()=>false)]);
  if(!closed)terminal.child.write('\x04');
}
