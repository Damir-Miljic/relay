import {safeText} from './storage.mjs';
const pad=(text,n)=>{const clean=safeText(text).replace(/\n/g,' ');return clean.length>n?clean.slice(0,n-1)+'…':clean.padEnd(n);};
function restartNotice(s){return s.integrated && s.provider==='claude' && s.boundary==='waiting for your draft to be submitted'?'This Claude terminal still runs old Relay code. Exit and resume Claude to load the installed fixes.':null;}
function resetText(epoch){
  if(!epoch)return 'reset unknown';
  const mins=Math.ceil((epoch*1000-Date.now())/60000);
  if(mins<=0)return 'awaiting refresh';
  return mins<60?'reset '+mins+'m':mins<1440?'reset '+Math.ceil(mins/60)+'h':'reset '+Math.ceil(mins/1440)+'d';
}
export function dashboard(state,width=100){
  const lines=['RELAY  /  ACCOUNTS & SESSION ROUTING',''];
  const nameWidth=Math.max(16,Math.min(26,width-65));
  lines.push(pad('ACCOUNT',nameWidth)+pad('PROVIDER',10)+pad('LEFT',10)+'USAGE WINDOWS');
  lines.push('─'.repeat(Math.max(40,Math.min(width,110))));
  if(!state.accounts.length)lines.push('No accounts yet. Press a to add your first account.');
  for(const a of state.accounts){
    const windows=(a.usage?.windows || []).map(w=>{
      const stale=Date.now()-w.observedAt>state.settings.staleSeconds*1000 || (w.resetsAt && w.resetsAt*1000<Date.now());
      return w.label+' '+Math.round(w.remaining)+'%'+(stale?' (stale)':'')+' · '+resetText(w.resetsAt);
    });
    const left=!a.enabled?'Disabled':a.remaining===null?'Unknown':Math.round(a.remaining)+'%';
    lines.push(pad(a.name,nameWidth)+pad(a.provider,10)+pad(left,10)+(windows.join(' | ') || a.auth));
    if(a.usage?.error)lines.push('  '+safeText(a.usage.error).slice(0,Math.max(30,width-3)));
  }
  lines.push('','CONTROLLED SESSIONS',pad('NAME',22)+pad('ACCOUNT',nameWidth)+pad('MODE',18)+'STATE');
  if(!state.sessions.length)lines.push('Open a new terminal and run claude or codex after relay install.');
  for(const s of state.sessions){
    lines.push(pad(s.name,22)+pad(s.accountName,nameWidth)+pad(s.auto?'Auto < '+s.threshold+'%':'Keep account',18)+(s.integrated?'Native · ':'')+(s.pendingName && s.status==='idle'?'switch queued':s.status)+(s.pendingName?' → '+s.pendingName:''));
    if(restartNotice(s))lines.push('  '+restartNotice(s));
    else if(s.integrated && s.pendingName)lines.push('  '+safeText(s.boundary || 'Waiting for the native session.'));
    if(s.error)lines.push('  '+safeText(s.error));
  }
  lines.push(...nativeRows(state,width));
  lines.push('','All percentages are remaining subscription usage. Unknown usage is never treated as zero.');
  return lines.join('\n');
}

function nativeRows(state,width=100){
  const rows=[],sessions=state.externalSessions || [],processes=state.externalProcesses || [];
  rows.push('','DETECTED NATIVE SESSIONS');
  if(state.discovery?.error)rows.push(safeText(state.discovery.error));
  else if(state.discovery?.disabled)rows.push('Native session detection disabled by RELAY_DISABLE_DISCOVERY.');
  else if(!sessions.length)rows.push('No other native sessions detected.');
  for(const s of sessions){
    rows.push(pad(s.name,22)+pad(s.provider+' #'+s.pid,18)+pad(s.status,12)+'External - view only');
    rows.push('  '+safeText(s.cwd));
    rows.push('  Login profile: '+safeText(s.accountName));
  }
  if(state.discovery?.warning)rows.push(safeText(state.discovery.warning));
  if(processes.length){
    rows.push('','OTHER NATIVE PROCESSES');
    for(const p of processes)rows.push(safeText(p.name)+' #'+p.pid+' | '+safeText(p.detail));
  }
  if(sessions.length || processes.length)rows.push('Detected sessions keep their native login. Open a new terminal after relay install to enable control.');
  return rows;
}

export function compactStatus(state){
  const lines=['RELAY | remaining usage'];
  for(const a of state.accounts)lines.push(pad(a.name,24)+(a.enabled?(a.remaining===null?'unknown':Math.round(a.remaining)+'%'):'disabled'));
  if(!state.accounts.length)lines.push('No accounts connected. Press a to add one.');
  for(const s of state.sessions){
    lines.push(safeText(s.name)+' -> '+safeText(s.accountName)+' | '+(s.auto?'auto '+s.threshold+'%':'pinned')+' | '+(s.pendingName && s.status==='idle'?'switch queued':s.status)+(s.pendingName?' -> '+safeText(s.pendingName):''));
    if(restartNotice(s))lines.push('  '+restartNotice(s));
    else if(s.pendingName)lines.push('  '+safeText(s.boundary || 'Waiting for a safe stopping point.'));
    if(s.error)lines.push('  '+safeText(s.error));
  }
  for(const s of state.externalSessions || [])lines.push(safeText(s.name)+' | '+s.provider+' #'+s.pid+' | '+s.status+' | external');
  for(const p of state.externalProcesses || [])lines.push(safeText(p.name)+' #'+p.pid+' | process only');
  if(state.discovery?.error)lines.push(safeText(state.discovery.error));
  return lines.join('\n');
}
