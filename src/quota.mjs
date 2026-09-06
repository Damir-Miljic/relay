const clamp = n => Math.max(0, Math.min(100, n));
function windowValue(id, label, used, resets, now) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const reset = typeof resets === 'number' ? resets : Date.parse(resets) / 1000;
  return {id, label, remaining:clamp(100-used), resetsAt:Number.isFinite(reset) ? reset : null, observedAt:now};
}
export function codexUsage(data, now = Date.now()) {
  const buckets = data.rateLimitsByLimitId || (data.rateLimits ? {[data.rateLimits.limitId || 'codex']:data.rateLimits} : {});
  const windows = [];
  for (const [bucket, limits] of Object.entries(buckets)) {
    for (const key of ['primary','secondary']) {
      const w = limits?.[key];
      if (!w) continue;
      const mins = w.windowDurationMins;
      const label = mins === 10080 ? '7d' : mins === 300 ? '5h' : mins ? mins + 'm' : key;
      const row = windowValue(bucket+':'+key, (bucket === 'codex' ? '' : bucket+'/')+label, w.usedPercent, w.resetsAt, now);
      if (row) windows.push({...row, bucket,...(typeof limits.limitName==='string' && limits.limitName.trim()?{limitName:limits.limitName.trim()}: {})});
    }
  }
  return {windows, observedAt:now, source:'Codex app-server'};
}
export function claudeUsage(data, previous = {windows:[]}, now = Date.now()) {
  const windows = [...(previous.windows || [])];
  const values = data.rate_limits || data;
  for (const [key,w] of Object.entries(values)) {
    if (!w || typeof w !== 'object' || !/^(five_hour|seven_day)/.test(key)) continue;
    const row = windowValue(key, key.replace('five_hour','5h').replace('seven_day','7d'), w.utilization ?? w.used_percentage, w.resets_at, now);
    if (row) { const idx = windows.findIndex(x=>x.id===key); if(idx < 0) windows.push(row); else windows[idx]=row; }
  }
  if (Array.isArray(values.model_scoped)) {
    // A full model list replaces the last list; incremental SDK events omit it.
    for (let i=windows.length-1;i>=0;i--)if(windows[i].id.startsWith('model_scoped:'))windows.splice(i,1);
    for (const w of values.model_scoped) {
      if (!w || typeof w.display_name!=='string' || !w.display_name.trim()) continue;
      const name=w.display_name.trim();
      const row=windowValue('model_scoped:'+name,'7d/'+name,w.utilization,w.resets_at,now);
      if(row)windows.push(row);
    }
  }
  return {windows, observedAt:now, source:'Claude usage'};
}
export function claudeRateEvent(event, previous, now = Date.now()) {
  const info = event.rate_limit_info;
  if (!info?.rateLimitType || typeof info.utilization !== 'number') return previous;
  // The SDK utilization is a fraction; the OAuth usage endpoint uses a percentage.
  const key = info.rateLimitType;
  const usage = claudeUsage({[key]:{utilization:info.utilization * 100, resets_at:info.resetsAt}}, previous, now);
  usage.source = 'Claude SDK event';
  return usage;
}
export function headroom(account, settings, now = Date.now()) {
  if (!account.enabled || account.auth !== 'ready' || account.usage?.error || account.blockedUntil > now) return null;
  const windows = account.usage?.windows || [];
  if (!windows.length) return null;
  // Every known window must be fresh. A passed reset is unknown until refreshed.
  if (windows.some(w => !Number.isFinite(w.remaining) || !Number.isFinite(w.observedAt) || w.observedAt>now+5000 || now-w.observedAt > settings.staleSeconds*1000 || (w.resetsAt != null && w.resetsAt*1000 <= now))) return null;
  return Math.min(...windows.map(w=>w.remaining));
}
// Keep the reserve near 100% reachable, and never rotate into less headroom.
export function switchFloor(session,accounts,settings,now=Date.now()) {
  const current=accounts.find(a=>a.id===session.accountId);
  return Math.max(Math.min((session.threshold ?? settings.threshold)+5,99),current?headroom(current,settings,now) ?? -1:-1);
}
export function chooseAccount(session, accounts, sessions, settings, excluded = [], now = Date.now()) {
  const floor = switchFloor(session,accounts,settings,now);
  return accounts.filter(a => a.provider === session.provider && a.id !== session.accountId && !excluded.includes(a.id) && (!session.pool?.length || session.pool.includes(a.id)))
    .map(a=>({a, remaining:headroom(a,settings,now), load:sessions.filter(s=>s.id!==session.id && s.accountId===a.id && ['running','waiting','switching'].includes(s.status)).length}))
    .filter(x=>x.remaining !== null && x.remaining > floor)
    .sort((x,y)=>x.load-y.load || y.remaining-x.remaining || x.a.name.localeCompare(y.a.name))[0]?.a || null;
}
