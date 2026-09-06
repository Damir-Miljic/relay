import readline from 'node:readline';
import {handoffNotice} from './handoff.mjs';
import {premiumFrame,fit,palette,usageLimit} from './premium-display.mjs';
import {safeText,threshold} from './storage.mjs';
const E='\x1b[';
export class TerminalScreen {
  constructor(output=process.stdout){this.output=output;this.previous=[];this.active=false;this.size='';}
  enter(){if(this.active)return;this.active=true;this.previous=[];this.output.write(E+'?1049h'+E+'?7l'+E+'?25l'+E+'2J');}
  paint(lines){if(!this.active)return;const columns=this.output.columns || 100,rows=this.output.rows || 30,size=columns+'x'+rows;let text='';if(this.size!==size){this.size=size;this.previous=[];text+=E+'2J';}
    const base=E+'0m'+E+'48;2;'+palette.bg.join(';')+'m'+E+'38;2;'+palette.text.join(';')+'m';
    for(let row=0;row<rows;row++){const line=fit(lines[row] || '',Math.max(0,columns-1));if(line!==this.previous[row])text+=E+(row+1)+';1H'+base+line+base+E+'K';this.previous[row]=line;}
    if(text)this.output.write(text);
  }
  leave(){if(!this.active)return;this.active=false;this.output.write(E+'0m'+E+'?7h'+E+'?25h'+E+'?1049l');this.previous=[];}
}
class Cancelled extends Error{}
export async function runDashboard(api,{compact=false,onLogin=async()=>{},input=process.stdin,output=process.stdout,noticeDuration=4500}={}){
  const screen=new TerminalScreen(output),wasRaw=!!input.isRaw;let state=null,dialog=null,notice='Connecting to Relay…',noticeTone='muted',noticeTimer,detectedExpanded=false,offset=0,maxOffset=0,busy=false,closed=false,polling=false,suspended=false,resolveClosed;
  const queueTimes=new Map();
  const finished=new Promise(resolve=>{resolveClosed=resolve;});
  const dimensions=()=>({columns:output.columns || 100,rows:output.rows || 30});
  const paint=()=>{if(closed || suspended)return;const frame=premiumFrame(state,{...dimensions(),compact,offset,notice,noticeTone,dialog,detectedExpanded});maxOffset=frame.maxOffset;offset=Math.min(offset,maxOffset);screen.paint(frame.lines);};
  const setNotice=(text,tone='mint',expires=false)=>{
    clearTimeout(noticeTimer);notice=text;noticeTone=tone;
    if(text && expires)noticeTimer=setTimeout(()=>{notice='';paint();},noticeDuration);
  };
  const trackQueues=next=>{
    const live=new Set();
    for(const session of next.sessions || []){
      if(!session.pendingName)continue;
      const id=session.id || session.name,key=session.commandId || session.pending || session.pendingName;live.add(id);
      let tracked=queueTimes.get(id);if(!tracked || tracked.key!==key){tracked={key,since:Date.now(),observed:true};queueTimes.set(id,tracked);}
      if(!Number.isFinite(session.pendingSince)){session.pendingSince=tracked.since;session.waitObserved=tracked.observed;}
    }
    for(const id of queueTimes.keys())if(!live.has(id))queueTimes.delete(id);
    return next;
  };
  const refresh=async(force=false)=>{
    if(polling || closed || suspended)return;polling=true;
    try{state=trackQueues(await api(force?'refresh':'snapshot'));if(notice==='Connecting to Relay…' || notice.startsWith('Connection:'))setNotice('');}
    catch(e){setNotice('Connection: '+safeText(e.message),'red');}
    finally{polling=false;paint();}
  };
  const close=()=>{if(closed)return;closed=true;if(dialog?.reject)dialog.reject(new Cancelled());dialog=null;resolveClosed();};
  const select=(title,items,hint='Choose a row below.')=>new Promise((resolve,reject)=>{if(!items.length){reject(new Error('No choices available.'));return;}dialog={kind:'select',title,hint,items,index:0,digits:'',resolve,reject};paint();});
  const field=(title,hint,value='')=>new Promise((resolve,reject)=>{dialog={kind:'text',title,hint,value,replaceOnType:!!value,resolve,reject};paint();});
  const info=(title,lines)=>new Promise(resolve=>{dialog={kind:'info',title,hint:'',lines,resolve,reject:resolve};paint();});
  const chooseAccount=(title,accounts)=>select(title,accounts.map(a=>({value:a,label:a.name+'  ·  '+(a.provider==='claude'?'Claude Code':'Codex')+'  ·  '+(a.remaining===null?'usage unknown':Math.round(a.remaining)+'% left')+(a.enabled?'':'  ·  disabled')})));
  const chooseSession=()=>select('Choose a session',(state?.sessions || []).filter(s=>s.canRoute!==false).map(s=>({value:s,label:s.name+'  →  '+s.accountName})));
  const suspend=()=>{suspended=true;input.off('keypress',key);input.setRawMode?.(wasRaw);input.pause();screen.leave();};
  const resume=()=>{if(closed)return;suspended=false;input.setRawMode?.(true);input.resume();input.on('keypress',key);screen.enter();paint();};
  const login=async account=>{suspend();try{await onLogin(account);}finally{resume();}};
  const command=async name=>{
    if(busy || closed)return;busy=true;setNotice('');
    try{
      if(!state)state=trackQueues(await api('snapshot'));
      if(name==='?')name=await select('Help & commands',[
        {label:'R  Switch account — choose a session’s account',value:'r'},
        {label:'T  Threshold — change one session',value:'t'},
        {label:'S  Settings — threshold and provider switching',value:'s'},
        {label:'A  Add account',value:'a'},
        {label:'N  Rename account',value:'n'},
        {label:'P  Keep account / Auto-switch',value:'p'},
        {label:'U  Usage details — see every limit',value:'u'},
        {label:'L  Login — renew an account login',value:'l'},
        {label:'F  Refresh usage and sessions',value:'f'},
        {label:'D  '+(detectedExpanded?'Collapse':'Expand')+' detected sessions and processes',value:'d'},
        {label:'Tab  '+(compact?'Show full details':'Use compact view'),value:'density'},
        {label:'C  Cancel a queued manual switch',value:'c'},
        {label:'Q  Quit the panel',value:'q'}
      ],'Select a command, or Esc to return. All letter shortcuts also work from the dashboard.');
      if(name==='a'){
        const provider=await select('Add an account',[{label:'Claude Code',value:'claude'},{label:'Codex',value:'codex'}]);
        const accountName=await field('Name this account','Use a name you can recognize, such as Work or Personal.');
        const account=await api('account-add',{provider,name:accountName});await login(account.id);setNotice('Account connected.','mint',true);
      }else if(name==='n'){
        const a=await chooseAccount('Rename an account',state.accounts),value=await field('Rename '+a.name,'Enter its new display name.',a.name);await api('account-rename',{account:a.id,name:value});setNotice('Account renamed.','mint',true);
      }else if(name==='r'){
        const session=await chooseSession(),account=await chooseAccount('Switch account for '+session.name,state.accounts.filter(a=>(a.provider===session.provider || session.canHandoff) && a.enabled && a.auth==='ready'));
        if(account.provider!==session.provider){
          await info('Switch to '+(account.provider==='claude'?'Claude Code':'Codex'),handoffNotice);
          const confirmed=await select('Switch provider with context?',[{label:'Go back without switching',value:false},{label:'Switch to '+account.name,value:true}]);
          if(!confirmed)throw new Cancelled();
        }
        const routed=await api('session-route',{session:session.id,account:account.id});queueTimes.set(session.id,{key:routed?.commandId || routed?.pending || account.id,since:Date.now(),observed:false});setNotice('Switch requested: '+session.name+' → '+account.name+'.','mint',true);
      }else if(name==='c'){
        const choices=(state.sessions || []).filter(s=>s.pending && s.pendingReason==='manual' && s.canCancel!==false);
        if(!choices.length)throw new Error('No manual switch is waiting to be cancelled. A switch already in progress cannot be cancelled.');
        const s=await select('Cancel a manual switch',choices.map(s=>({value:s,label:s.name+' → '+s.pendingName})));
        await api('session-cancel-route',{session:s.id,commandId:s.commandId});setNotice('Switch cancelled. Session stays on '+s.accountName+'.','mint',true);
      }else if(name==='p'){
        const s=await chooseSession();await api('session-configure',{session:s.id,auto:!s.auto});setNotice(s.auto?'Keep account enabled. Session stays on its current account.':'Automatic switching enabled.','mint',true);
      }else if(name==='t'){
        const s=await chooseSession(),value=await field('Switching threshold','Switch at or below this percent of remaining usage (1–100).',String(s.threshold));await api('session-configure',{session:s.id,threshold:threshold(value)});setNotice('Threshold updated.','mint',true);
      }else if(name==='s'){
        const setting=await select('Settings',[
          {label:'Default switching threshold  ·  '+(state.settings?.threshold ?? 10)+'%',value:'threshold'},
          {label:'Switch provider (with context)  ·  '+(state.settings?.crossProviderAuto?'Automatic fallback':'Manual only (default)'),value:'handoff'}
        ]);
        if(setting==='handoff'){
          await info('Switch provider with context', [...handoffNotice,'Automatic fallback applies only to sessions in Auto mode, when no suitable account from the current provider is available. Sessions set to Keep account stay on their current account.']);
          const enabled=await select('Provider switching mode',[
            {label:'Manual only — choose with R Switch account',value:false},
            {label:'Automatic fallback — use the other provider when needed',value:true}
          ]);
          await api('settings',{crossProviderAuto:enabled});setNotice(enabled?'Automatic provider fallback enabled for Auto sessions.':'Provider switching set to manual only.','mint',true);
        }else{
        const value=await field('Default switching threshold','Remaining usage (1–100%). Applies to new sessions; use T for an existing session.',String(state.settings?.threshold ?? 10));
        await api('settings',{threshold:threshold(value)});setNotice('Default threshold saved for new sessions.','mint',true);
        }
      }else if(name==='l'){
        const a=await chooseAccount('Log in to an account',state.accounts);await login(a.id);setNotice('Login refreshed.','mint',true);
      }else if(name==='u'){
        const a=await chooseAccount('Account usage',state.accounts),windows=a.usage?.windows || [];await info(a.name,[a.remaining===null?'Remaining usage unknown':Math.round(a.remaining)+'% remaining across all limits',a.usage?.error || '',...windows.flatMap(w=>[usageLimit(w)+'  ·  '+(Number.isFinite(w.remaining)?Math.round(w.remaining)+'% left':'unknown')+'  ·  '+(w.resetsAt?new Date(w.resetsAt*1000).toLocaleString():'reset unknown'),'Native limit: '+(w.id || w.label)])].filter(Boolean));
      }else if(name==='f'){
        setNotice('Refreshing usage and sessions…','muted');paint();state=trackQueues(await api('refresh'));setNotice('Usage and sessions refreshed.','mint',true);
      }
      else if(name==='d'){detectedExpanded=!detectedExpanded;}
      else if(name==='density'){compact=!compact;offset=0;}
      else if(name==='q'){close();}
    }catch(e){setNotice(e instanceof Cancelled?'Cancelled.':safeText(e.message),e instanceof Cancelled?'muted':'red',e instanceof Cancelled);}
    finally{busy=false;dialog=null;paint();if(!closed)void refresh();}
  };
  function key(str,k={}){
    if(closed || suspended)return;
    if(k.ctrl && k.name==='c'){if(dialog){const d=dialog;dialog=null;d.reject(new Cancelled());paint();}else close();return;}
    if(dialog){
      const d=dialog;
      if(k.name==='escape'){dialog=null;d.reject(new Cancelled());paint();return;}
      if(d.kind==='info'){if(k.name==='return' || k.name==='enter'){dialog=null;d.resolve();paint();}else if(['up','down','pageup','pagedown','home','end'].includes(k.name)){d.offset=k.name==='home'?0:k.name==='end'?maxOffset:Math.max(0,Math.min(maxOffset,(d.offset || 0)+(['up','pageup'].includes(k.name)?-1:1)*(k.name.startsWith('page')?8:1)));paint();}return;}
      if(k.name==='return' || k.name==='enter'){
        if(d.kind==='select'){const i=d.digits?Number(d.digits)-1:d.index;if(i<0 || i>=d.items.length)return;dialog=null;d.resolve(d.items[i].value);}
        else{if(!d.value.trim())return;dialog=null;d.resolve(d.value.trim());}paint();return;
      }
      if(d.kind==='select'){
        if(k.name==='up' || k.name==='down'){d.index=Math.max(0,Math.min(d.items.length-1,d.index+(k.name==='up'?-1:1)));d.digits='';}
        else if(k.name==='pageup' || k.name==='pagedown'){d.index=Math.max(0,Math.min(d.items.length-1,d.index+(k.name==='pageup'?-8:8)));d.digits='';}
        else if(/^\d$/.test(str || '')){d.digits=(d.digits+str).slice(-3);const i=Number(d.digits)-1;if(i>=0 && i<d.items.length)d.index=i;}
        else if(k.name==='backspace'){d.digits=d.digits.slice(0,-1);}
      }else if(d.kind==='text'){
        if(k.name==='backspace'){d.value=d.replaceOnType?'':[...d.value].slice(0,-1).join('');d.replaceOnType=false;}
        else if(k.ctrl && k.name==='u'){d.value='';d.replaceOnType=false;}
        else if(!k.ctrl && !k.meta && str && !str.includes('\x1b')){if(d.replaceOnType){d.value='';d.replaceOnType=false;}d.value=(d.value+str.replace(/[\x00-\x1f\x7f]/g,'')).slice(0,120);}
      }paint();return;
    }
    if(k.name==='q'){close();return;}
    if(!k.ctrl && !k.meta && str==='?'){void command('?');return;}
    if(!k.ctrl && !k.meta && k.name==='d'){detectedExpanded=!detectedExpanded;paint();return;}
    if(k.name==='up' || k.name==='down')offset=Math.max(0,Math.min(maxOffset,offset+(k.name==='up'?-1:1)));
    else if(k.name==='pageup' || k.name==='pagedown')offset=Math.max(0,Math.min(maxOffset,offset+(k.name==='pageup'?-8:8)));
    else if(k.name==='home')offset=0;
    else if(k.name==='end')offset=maxOffset;
    else if(k.name==='tab'){compact=!compact;offset=0;}
    else if(!k.ctrl && !k.meta && ['a','n','r','p','t','s','l','u','f','c'].includes(k.name)){void command(k.name);return;}
    paint();
  }
  readline.emitKeypressEvents(input);input.setRawMode?.(true);input.resume();input.on('keypress',key);output.on('resize',paint);const ended=()=>close();input.on('end',ended);
  const onExit=()=>screen.leave();process.once('exit',onExit);screen.enter();paint();const timer=setInterval(()=>void refresh(),1500);void refresh();
  try{await finished;}finally{clearTimeout(noticeTimer);clearInterval(timer);input.off('keypress',key);input.off('end',ended);output.off('resize',paint);process.off('exit',onExit);input.setRawMode?.(wasRaw);input.pause();screen.leave();}
}
