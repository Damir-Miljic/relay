#!/usr/bin/env node
// Claude hook input can contain prompts and tool output. Only send lifecycle metadata.
let raw='';
try{
  for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16*1024*1024)throw new Error('Hook too large.');}
  const p=JSON.parse(raw),url=process.env.RELAY_HOOK_URL;
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || ''))throw new Error('Invalid callback.');
  const data={event:p.hook_event_name,sessionId:p.session_id,source:p.source,tool:p.tool_name,toolId:p.tool_use_id,
    shellCompleted:p.tool_name==='Bash' && p.hook_event_name==='PostToolUse'?!!(p.tool_response && typeof p.tool_response.stdout==='string' && typeof p.tool_response.stderr==='string' && p.tool_response.interrupted===false && !p.tool_response.backgroundTaskId && !p.tool_response.backgroundedByUser && p.tool_response.timedOutAfterMs==null):undefined,
    tools:Array.isArray(p.tool_calls)?p.tool_calls.map(t=>t.tool_name):undefined,
    backgroundCount:Array.isArray(p.background_tasks)?p.background_tasks.length:null,
    backgroundKinds:Array.isArray(p.background_tasks)?[...new Set(p.background_tasks.map(t=>t.type).filter(t=>['shell','subagent','monitor','workflow','teammate','cloud session','MCP task'].includes(t)))]:[],
    cronCount:Array.isArray(p.session_crons)?p.session_crons.length:null};
  const result=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.RELAY_HOOK_TOKEN},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});
  if(result.ok)process.stdout.write(JSON.stringify(await result.json()));
}catch{/* No Relay connection must never block native work. */}
