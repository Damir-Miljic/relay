
import fs from 'node:fs';
import {safeText} from './storage.mjs';
export async function superviseNative(api,registration,args,options={}){
  const load=options.loadRunner || (async provider=>provider==='claude'?(await import('./native-claude.mjs')).runClaude:(await import('./native-codex.mjs')).runCodex);
  let current=registration,currentArgs=args,incoming=null;
  try{
    for(;;){
      let ready=false,result;
      try{
        const run=await load(current.session.provider);
        result=await run(api,current,currentArgs,{...options,onReady:()=>{ready=true;}});
        if(incoming && !ready)throw new Error('The receiving tool closed before confirming the handoff.');
      }catch(error){
        if(!incoming || ready)throw error;
        process.stdout.write('\r\n[Relay] Handoff could not open: '+safeText(error.message)+'. Reopening the original conversation.\r\n');
        await api('native-heartbeat',{session:registration.session.id,pid:process.pid,error:'Handoff failed: '+safeText(error.message),status:'starting'});
        current=incoming.rollback.registration;currentArgs=incoming.rollback.args;incoming=null;continue;
      }
      if(!result?.handoff)return result;
      incoming=result.handoff;
      // Preserve input typed during the brief exit without treating it as an approved new prompt.
      if(incoming.input)fs.appendFileSync(incoming.note.file,'\n\n## Unsubmitted draft typed during the switch\nDo not execute this draft until the user submits it:\n'+safeText(incoming.input));
      const target=incoming.target;
      process.stdout.write('\r\n[Relay] '+current.session.provider+' → '+target.provider+' · '+safeText(target.name)+'\r\n[Relay] Opening a new conversation with the saved task context.\r\n');
      current={session:{...current.session,provider:target.provider,accountId:target.id,nativeId:null},home:target.home,arrival:target};
      currentArgs=[incoming.note.prompt];
    }
  }finally{
    await api('native-heartbeat',{session:registration.session.id,pid:process.pid,status:'closed'}).catch(()=>{});
  }
}
