import {safeText} from './storage.mjs';
export const palette={bg:[12,17,27],text:[228,236,247],muted:[125,143,164],line:[42,57,76],mint:[105,224,193],blue:[135,184,250],amber:[239,192,113],red:[244,141,149]};
const esc='\x1b[';
export const color=(name,text)=>esc+'38;2;'+palette[name].join(';')+'m'+text+esc+'39m';
export const bold=text=>esc+'1m'+text+esc+'22m';
export const plain=text=>String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
const clean=value=>safeText(value ?? '').replace(/[\r\n\t]/g,' ');
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function cellWidth(s){if(!s || /^\p{Mark}+$/u.test(s))return 0;const n=s.codePointAt(0);return /\p{Extended_Pictographic}/u.test(s) || n>=0x1100 && (n<=0x115f || n>=0x2e80 && n<=0xa4cf || n>=0xac00 && n<=0xd7a3 || n>=0xf900 && n<=0xfaff || n>=0xfe10 && n<=0xfe6f || n>=0xff00 && n<=0xff60 || n>=0xffe0 && n<=0xffe6 || n>=0x20000)?2:1;}
export const width=text=>[...segmenter.segment(plain(text))].reduce((n,x)=>n+cellWidth(x.segment),0);
export function fit(text,size){
  size=Math.max(0,size);let out='',used=0;const parts=String(text).split(/(\x1b\[[0-?]*[ -/]*[@-~])/g);
  outer:for(const part of parts){if(part.startsWith('\x1b[')){out+=part;continue;}for(const {segment} of segmenter.segment(part)){const n=cellWidth(segment);if(used+n>size)break outer;out+=segment;used+=n;}}
  return out+' '.repeat(Math.max(0,size-used));
}
const label=(value,n)=>{const s=clean(value);return width(s)>n?fit(s,n-1)+'…':fit(s,n);};
const across=(left,right,n)=>fit(left,Math.max(0,n-width(right)))+right;
const provider=p=>p==='claude'?'Claude Code':p==='codex'?'Codex':clean(p);
const remaining=a=>typeof a.remaining==='number' && Number.isFinite(a.remaining)?Math.max(0,Math.min(100,a.remaining)):null;
const shade=a=>!a.enabled?'muted':remaining(a)===null?'muted':a.remaining<=10?'red':a.remaining<=25?'amber':'mint';
function resets(epoch,now=Date.now()){if(!epoch)return 'Reset unknown';const minutes=Math.ceil((epoch*1000-now)/60000);return minutes<=0?'Awaiting reset':minutes<60?'Resets in '+minutes+'m':minutes<1440?'Resets in '+Math.ceil(minutes/60)+'h':'Resets in '+Math.ceil(minutes/1440)+'d';}
function bar(a,n){const value=remaining(a);if(value===null || !a.enabled)return color('line','─'.repeat(n));const count=Math.round(value*n/100);return color(shade(a),'━'.repeat(count))+color('line','━'.repeat(n-count));}
const words=value=>clean(value).replace(/[_-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
export function modelLabel(value){
  const raw=clean(value);if(!raw)return 'Model unknown';
  const claude=/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(raw);
  if(claude)return words(claude[1])+' '+claude[2]+(claude[3]?'.'+claude[3]:'');
  if(/^gpt-/i.test(raw))return raw.replace(/^gpt-/i,'GPT-').replace(/-([a-z])/gi,(_,c)=>' '+c.toUpperCase());
  return raw;
}
export function effortLabel(value){
  const raw=clean(value);if(!raw)return 'Effort unknown';
  const names={none:'No reasoning',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Maximum',ultra:'Ultra'};
  return (names[raw.toLowerCase()] || raw)+' effort';
}
// Provider-reported names also cover accounts read by an older running service.
const limitNames={codex_bengalfox:'GPT-5.3-Codex-Spark',base_model_inference:'gpt-reserve'};
export function usageLimit(window){
  if(!window)return 'Limit unavailable';
  const raw=clean(window.label || window.id || '');
  const match=raw.match(/(?:^|[/:_])(5h|7d|\d+[mhd])(?:$|[_/])/);
  if(!match)return raw?words(raw)+' limit':'Usage limit';
  let unit=match[1];
  if(unit.endsWith('m')){const minutes=Number.parseInt(unit);if(minutes%1440===0)unit=minutes/1440+'d';else if(minutes%60===0)unit=minutes/60+'h';}
  const name=unit==='7d'?'Weekly':unit==='5h'?'5-hour':unit.replace(/(\d+)m$/,'$1-minute').replace(/(\d+)h$/,'$1-hour').replace(/(\d+)d$/,'$1-day');
  const detail=raw.slice(0,match.index).replace(/[/:_]$/,'') || raw.slice(match.index+match[0].length).replace(/^[_/]/,'');
  const display=clean(window.limitName) || limitNames[detail] || detail;
  return name+' limit'+(display?' · '+(/^gpt-/i.test(display)?modelLabel(display):words(display)):'');
}
function card(a,n,compact,settings,now){
  const inner=n-4,tone=shade(a),percent=!a.enabled?'Disabled':remaining(a)===null?'Lowest limit: unknown':'Lowest limit: '+Math.round(a.remaining)+'%';
  const edge=s=>color('line','│')+' '+fit(s,inner)+' '+color('line','│');
  const order=w=>/^(5h|300m)$/.test(w.label)?0:/^(7d|10080m)$/.test(w.label)?1:w.bucket==='codex'?2:3;
  const windows=[...(a.usage?.windows || [])].sort((a,b)=>order(a)-order(b) || String(a.label).localeCompare(String(b.label)));
  const lines=[color('line','╭'+'─'.repeat(n-2)+'╮')];
  if(width(a.name)+width(percent)+2<=inner)lines.push(edge(across(color('text',bold(clean(a.name))),color(tone,bold(percent)),inner)));
  else lines.push(edge(color('text',bold(label(a.name,inner)))),edge(color(tone,label(percent,inner))));
  for(const w of windows){
    const observed=w.observedAt ?? a.usage?.observedAt;
    const stale=Number.isFinite(observed) && (now-observed>(settings?.staleSeconds ?? 180)*1000 || observed>now+5000) || w.resetsAt!=null && w.resetsAt*1000<=now;
    const valid=a.enabled && !a.usage?.error && !stale && Number.isFinite(w.remaining);
    const value={enabled:valid,remaining:valid?w.remaining:null};
    const left=!a.enabled?'OFF':stale?'STALE':!valid?'UNKNOWN':Math.round(remaining(value))+'% left';
    const reset=resets(w.resetsAt,now).replace(/^Resets/,'resets');
    const title=usageLimit(w).replace(' limit','')+(a.provider==='claude' && w.label==='7d'?' · all models':'');
    const percentWidth=9,resetWidth=Math.max(16,width(reset));
    const amount=color(valid?shade(value):'muted',bold(left.padStart(percentWidth))),resetColumn=color('muted',fit(reset,resetWidth));
    if(compact && inner>=58){
      const barWidth=Math.min(12,Math.max(8,Math.floor(inner/8))),titleWidth=inner-barWidth-percentWidth-resetWidth-5;
      lines.push(edge(color('muted',label(title,titleWidth))+' '+bar(value,barWidth)+' '+amount+color('muted',' · ')+resetColumn));
    }else{
      lines.push(edge(across(color('muted',label(title,Math.max(1,inner-percentWidth-1))),amount,inner)));
      const barWidth=Math.max(1,inner-resetWidth-3);
      lines.push(edge(bar(value,barWidth)+color('muted',' · ')+resetColumn));
    }
  }
  if(a.usage?.error || !a.enabled || !windows.length){
    const note=a.usage?.error?'Usage unavailable':!a.enabled?'Account disabled':'Usage unknown';
    lines.push(edge(color(a.usage?.error?'amber':'muted',label(note,inner))));
  }
  lines.push(color('line','╰'+'─'.repeat(n-2)+'╯'));return lines;
}
function alignCard(lines,height,n){
  if(!lines.length)return Array(height).fill('');
  return [...lines.slice(0,-1),...Array(height-lines.length).fill(color('line','│')+' '.repeat(n-2)+color('line','│')),lines.at(-1)];
}
function wrap(text,n,max=2){const words=clean(text).split(/\s+/);const lines=[];let line='';for(const word of words){if(width(line+' '+word)>n && line){lines.push(line);line='';}if(lines.length>=max)return [...lines.slice(0,max-1),label(lines[max-1],n-1)+'…'];line+=(line?' ':'')+word;}if(line)lines.push(line);return lines.slice(0,max).map(x=>label(x,n));}
function noticeFor(s){return s.restartRequired || s.boundary==='waiting for your draft to be submitted'?'Restart this terminal to load the installed Relay update.':s.error || (s.pendingName?s.boundary:null);}
function sessionColumns(n){return {name:Math.floor(n*0.36),account:Math.floor(n*0.30),routing:12};}
function sessionHeading(n){
  if(n<70)return color('muted',across('SESSION','STATUS',n));
  const cols=sessionColumns(n);return color('muted',fit('SESSION',cols.name)+' '+fit('ACCOUNT',cols.account)+' '+fit('MODE',cols.routing)+' STATUS');
}
export function queuedDuration(s,now=Date.now()){
  if(!Number.isFinite(s.pendingSince))return '';
  const seconds=Math.max(0,Math.floor((now-s.pendingSince)/1000));
  const value=seconds<60?seconds+'s':seconds<3600?Math.floor(seconds/60)+'m '+seconds%60+'s':Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m';
  return 'queued '+(s.waitObserved?'≥':'')+value;
}
function sessionRows(s,n,compact,external=false,now=Date.now()){
  const cols=sessionColumns(n),nameWidth=n>=70?cols.name:Math.max(8,n-12);
  const status=external?'VIEW ONLY':s.committing?'SWITCHING':s.pendingName?'QUEUED':s.status==='busy' || s.status==='running'?'WORKING':clean(s.status || 'idle').toUpperCase();
  const tone=external?'muted':s.error?'red':s.pendingName?'amber':status==='WORKING'?'mint':'blue';
  const name=color(tone,external?'○ ':'● ')+color('text',bold(label(s.name,nameWidth-2)));
  const account=color('text',label(s.accountName || 'Account unknown',cols.account));
  const mode=external?'':s.auto?'AUTO '+s.threshold+'%':'KEEP ACCOUNT';
  const first=n>=70?name+' '+account+' '+color('muted',fit(mode,cols.routing))+' '+color(tone,status):across(name,color(tone,status),n);
  const rows=[fit(first,n)];
  if(n<70)rows.push('  '+color('muted',label('Account: '+(s.accountName || 'Unknown')+(external?'':' · '+mode),n-2)));
  rows.push(...wrap(modelLabel(s.model)+' · '+effortLabel(s.effort)+(s.modelSource==='last response'?' · last response':''),n-2,3).map(line=>'  '+color('muted',line)));
  if(!compact && (s.model || s.effort))rows.push(...wrap('Native values: '+clean(s.model || 'unknown')+' · '+clean(s.effort || 'unknown'),n-2,3).map(line=>'  '+color('muted',line)));
  if(!compact)rows.push('  '+color('muted',label(s.cwd || provider(s.provider),n-2)));
  if(s.pendingName)rows.push(...wrap((s.accountName || 'Current account')+' → '+s.pendingName,n-2,2).map(line=>'  '+color('amber',line)));
  let note=s.committing?'Switch started; cancellation is no longer available.':noticeFor(s);
  if(s.pendingName){const elapsed=queuedDuration(s,now);note=(note || 'Waiting for a safe stopping point.').replace(/\.$/,'')+(elapsed?' · '+elapsed:'');}
  if(note)for(const line of wrap(note,n-2,3))rows.push('  '+color(s.error?'red':'amber',line));
  return rows;
}
export function premiumBody(state,n,{compact=false,detectedExpanded=false,now=Date.now()}={}){
  const lines=[],accounts=state.accounts || [],sessions=state.sessions || [],external=state.externalSessions || [];
  const section=(title,count)=>{lines.push(color('muted',title.toUpperCase()+(count===undefined?'':'  '+count)),color('line','─'.repeat(n)));};
  section('Accounts',accounts.length);
  if(!accounts.length)lines.push(color('muted','No accounts connected. Press A to add one.'));
  const groups=new Map();
  for(const account of accounts){if(!groups.has(account.provider))groups.set(account.provider,[]);groups.get(account.provider).push(account);}
  const rank=p=>p==='claude'?0:p==='codex'?1:2;
  const ordered=[...groups.entries()].sort(([a],[b])=>rank(a)-rank(b));
  const columns=Math.min(ordered.length || 1,n>=62?2:1),gap=2,cardWidth=Math.floor((n-gap*(columns-1))/columns);
  for(let i=0;i<ordered.length;i+=columns){
    const batch=ordered.slice(i,i+columns);
    lines.push(batch.map(([p,group])=>fit(color(p==='claude'?'mint':'blue',bold((p==='claude'?'CLAUDE':provider(p).toUpperCase())+'  '+group.length)),cardWidth)).join(' '.repeat(gap)));
    for(let index=0;index<Math.max(...batch.map(([,group])=>group.length));index++){
      const cards=batch.map(([,group])=>group[index]?card(group[index],cardWidth,compact,state.settings,now):[]);
      const height=Math.max(...cards.map(c=>c.length)),aligned=cards.map(c=>alignCard(c,height,cardWidth));
      for(let row=0;row<height;row++)lines.push(aligned.map(c=>fit(c[row],cardWidth)).join(' '.repeat(gap)));
      if(index<Math.max(...batch.map(([,group])=>group.length))-1)lines.push('');
    }
  }
  lines.push('');section('Your sessions',sessions.length);
  if(!sessions.length)lines.push(color('muted','Launch claude or codex in your usual terminal.'));
  else lines.push(sessionHeading(n));
  for(const s of sessions){lines.push(...sessionRows(s,n,compact,false,now),'');}
  const other=state.externalProcesses?.length || 0;
  if(external.length || other){
    const title=(detectedExpanded?'▾ ':'▸ ')+(external.length?'Detected · View only ('+external.length+')':'Detected · Processes ('+other+')');
    lines.push('',across(color('muted',label(title,Math.max(1,n-13))),color('mint',detectedExpanded?'D Collapse':'D Expand'),n));
    if(detectedExpanded){
      lines.push(color('line','─'.repeat(n)));
      if(external.length)lines.push(sessionHeading(n));
      for(const s of external){lines.push(...sessionRows(s,n,compact,true,now),'');}
      if(other)lines.push(color('muted',label(other+' other native process'+(other===1?'':'es')+' · session details unavailable',n)));
    }
  }
  if(state.discovery?.error)lines.push('',color('amber',label(state.discovery.error,n)));
  return lines;
}
export function premiumFrame(state,{columns=100,rows=30,compact=false,offset=0,notice='',noticeTone='amber',dialog=null,detectedExpanded=false,now=Date.now()}={}){
  const cols=Math.max(1,columns-1),height=Math.max(1,rows),n=Math.max(1,cols-4);
  if(cols<36 || height<12){const small=[bold('RELAY'), 'Enlarge this window to continue.', 'Minimum: 38 columns × 12 rows.', 'Q  Quit'];return {lines:Array.from({length:height},(_,i)=>fit(small[i] || '',cols)),maxOffset:0};}
  const commands=[];let commandLine='';
  for(const item of ['R Switch account','C Cancel switch','T Threshold','S Settings','? Help','Q Quit','Tab Compact / Detailed']){
    if(commandLine && width(commandLine+'   '+item)>n){commands.push(commandLine);commandLine='';}
    commandLine+=(commandLine?'   ':'')+item;
  }
  if(commandLine)commands.push(commandLine);
  const footerHeight=commands.length+3,bodyHeight=Math.max(1,height-4-footerHeight);
  const data=state || {accounts:[],sessions:[],externalSessions:[]};let body=premiumBody(data,n,{compact,detectedExpanded,now}),maxOffset=Math.max(0,body.length-bodyHeight);offset=Math.min(maxOffset,Math.max(0,offset));
  const title=dialog?dialog.title:'ACCOUNT CONTROL';
  const header=across(color('mint',bold('R E L A Y'))+'   '+color('muted',title),color('muted','LOCAL  /  0.2.3'),n);
  let detail=color('muted',(data.accounts?.length || 0)+' accounts  ·  '+(data.sessions?.length || 0)+' controlled sessions');
  if(dialog){
    body=[color('text',bold(dialog.title)),color('muted',label(dialog.hint || '',n)),''];
    if(dialog.kind==='select'){
      const available=Math.max(1,bodyHeight-4),start=Math.max(0,Math.min(dialog.index-Math.floor(available/2),dialog.items.length-available));
      body.push(...dialog.items.slice(start,start+available).map((item,i)=>{const index=i+start,active=index===dialog.index;return color(active?'mint':'muted',(active?'› ':'  ')+String(index+1).padStart(2)+'  ')+color(active?'text':'muted',label(item.label,n-7));}));
      if(dialog.items.length>available)body.push(color('muted','↑ ↓ to see more choices'));
    }else if(dialog.kind==='text')body.push(color('mint','› ')+color('text',label(dialog.value+'▏',n-2)));
    else body.push(...dialog.lines.flatMap(line=>wrap(line,n,100)).map(line=>color('text',line)));
    detail=color('muted',dialog.kind==='select'?'↑ ↓ or number to choose  ·  Enter select  ·  Esc back':dialog.kind==='text'?'Enter save  ·  Esc cancel':'↑ ↓ scroll  ·  Enter or Esc to return');maxOffset=dialog.kind==='info'?Math.max(0,body.length-bodyHeight):0;offset=Math.min(maxOffset,dialog.offset || 0);
  }
  const content=body.slice(offset,offset+bodyHeight);while(content.length<bodyHeight)content.push('');
  const status=notice?color(noticeTone,label(notice,n)):color('muted','Usage remaining · Each bar shows a separate limit.');
  const progress=maxOffset?color('muted','↑ ↓ / PgUp PgDn  ·  '+(offset+1)+'–'+Math.min(offset+bodyHeight,body.length)+' of '+body.length):color('muted','Live updates  ·  '+(dialog?'Choose an option':'Press a highlighted letter'));
  const foot=[color('line','─'.repeat(n)),...commands.map(s=>color('muted',s.replace(/(?:\bTab|[A-Z?])(?=\s)/g,x=>color('mint',bold(x))+color('muted','')))),status,progress];
  const lines=['',header,detail,'',...content,...foot];return {lines:lines.slice(0,height).map(line=>'  '+fit(line,n)+'  '),maxOffset};
}
