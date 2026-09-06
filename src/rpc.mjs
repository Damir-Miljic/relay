import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import {executable,accountEnv} from './process.mjs';
export class CodexRPC extends EventEmitter {
  constructor(home, command = executable('codex'), args = ['app-server','--stdio']) {
    super(); this.next=1; this.pending=new Map(); this.closed=false;
    this.child=spawn(command,args,{env:accountEnv('codex',home),stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    this.child.stderr.resume(); // Never persist native diagnostic output containing auth details.
    this.child.stdin.on('error',()=>{});
    this.lines=createInterface({input:this.child.stdout,crlfDelay:Infinity});
    this.lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch{}});
    const fail = e => { if(this.closed) return; this.closed=true; for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);} this.pending.clear(); this.emit('closed',e); };
    this.child.once('error',e=>fail(new Error('Codex could not start: '+e.message)));
    this.child.once('exit',()=>fail(new Error('Codex app-server exited.')));
  }
  receive(msg) {
    if(msg.id != null && !msg.method) {
      const p=this.pending.get(msg.id); if(!p)return;
      this.pending.delete(msg.id);clearTimeout(p.timer);
      if(msg.error){const error=new Error(msg.error.message || 'Codex request failed');error.rpcError=msg.error;p.reject(error);}else p.resolve(msg.result);
    } else if(msg.id != null && msg.method) this.emit('request',msg);
    else if(msg.method)this.emit('notification',msg);
  }
  send(value) { if(!this.closed)this.child.stdin.write(JSON.stringify(value)+'\n'); }
  request(method,params={},timeout=30000) {
    if(this.closed)return Promise.reject(new Error('Codex connection is closed.'));
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex timed out: '+method));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  async initialize() {await this.request('initialize',{clientInfo:{name:'relay_accounts',version:'0.1.0'},capabilities:{experimentalApi:false}});this.send({method:'initialized',params:{}});}
  async close() {
    if(this.child.exitCode !== null || this.child.signalCode !== null || (!this.child.pid && this.closed))return;
    if(this.closing)return this.closing;
    this.closing=new Promise((resolve,reject)=>{
      const force=setTimeout(()=>this.child.kill('SIGKILL'),2000);
      const deadline=setTimeout(()=>reject(new Error('Codex did not exit; history transfer was stopped.')),10000);
      this.child.once('exit',()=>{clearTimeout(force);clearTimeout(deadline);resolve();});
      this.child.stdin.end();
    });
    return this.closing;
  }
}
