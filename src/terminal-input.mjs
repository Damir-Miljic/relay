// Native input is forwarded unchanged. This tracker keeps only temporary editor state,
// never writes input to disk/RPC, and separates terminal reports from keyboard input.
export class TerminalInputState {
  constructor(){this.left=[];this.right=[];this.uncertain=false;this.pendingSubmit=false;this.paste=false;this.escape='';this.mode='text';this.revision=0;}
  get hasDraft(){return this.pendingSubmit || this.uncertain || this.left.length>0 || this.right.length>0;}
  submitted(){this.pendingSubmit=false;}
  reset(){this.left=[];this.right=[];this.uncertain=false;this.pendingSubmit=false;}
  feed(value){
    for(const c of String(value)){
      if(this.left.length+this.right.length>65536){this.left=[];this.right=[];this.uncertain=true;}
      if(this.mode==='string' || this.mode==='stringEscape'){
        if(c==='\x07' || (this.mode==='stringEscape' && c==='\\')){this.mode='text';this.escape='';}
        else this.mode=c==='\x1b'?'stringEscape':'string';
        continue;
      }
      if(this.mode==='escape'){
        if(c==='['){this.mode='csi';this.escape='';continue;}
        if([']','P','_','^','X'].includes(c)){if(this.paste)this.uncertain=true;this.mode='string';this.escape='';continue;}
        if(c==='O'){this.mode='ss3';continue;}
        this.mode='text';this.escape='';
        if(c==='\x1b'){this.mode='escape';continue;}
        if(['b','f','\x7f'].includes(c)){this.uncertain=true;this.revision++;continue;}
        this.uncertain=true;this.revision++;continue;
      }
      if(this.mode==='csi'){
        if(c>='@' && c<='~'){const params=this.escape;this.mode='text';this.escape='';this.csi(params,c);}
        else if(this.escape.length<128)this.escape+=c;
        else{this.mode='text';this.escape='';this.uncertain=true;}
        continue;
      }
      if(this.mode==='ss3'){this.mode='text';this.csi('',c);continue;}
      if(c==='\x1b'){this.mode='escape';continue;}
      this.key(c);
    }
  }
  csi(params,final){
    if(this.paste && !(final==='~' && params==='201')){this.uncertain=true;this.revision++;return;}
    // Focus, device/status reports, window reports and mouse events are not text.
    if((!params && ['I','O'].includes(final)) || /^[?>=]/.test(params) || ['R','c','n','t'].includes(final) || params.startsWith('<'))return;
    if(final==='~' && params==='200'){this.paste=true;return;}
    if(final==='~' && params==='201'){this.paste=false;return;}
    // Kitty keyboard reports: ignore releases; private '?' capability replies above.
    if(final==='u'){
      const [code,modifier='1']=params.split(';'),[mods,event='1']=modifier.split(':');
      if(event==='3')return;
      const n=Number(code.split(':')[0]);if(!Number.isInteger(n) || n<1 || n>0x10ffff)return;
      const ctrl=(Number(mods)-1)&4;
      this.key(ctrl && n>=64 && n<=127?String.fromCodePoint(n&31):String.fromCodePoint(n));return;
    }
    // Windows Terminal Win32 input mode: virtual-key;scan;unicode;down;mods;repeat.
    if(final==='_'){
      const [vk,,uc,down,,repeat=1]=params.split(';').map(Number);if(!down)return;
      for(let i=0;i<Math.min(repeat || 1,100);i++){
        if(uc>0)this.key(String.fromCodePoint(uc));
        else if([37,38,39,40,35,36,46].includes(vk))this.csi('',({37:'D',38:'A',39:'C',40:'B',35:'F',36:'H',46:'delete'})[vk]);
      }return;
    }
    if(final==='D'){if(this.left.length)this.right.unshift(this.left.pop());this.revision++;return;}
    if(final==='C'){if(this.right.length)this.left.push(this.right.shift());this.revision++;return;}
    if(final==='H' || (final==='~' && ['1','7'].includes(params))){this.right=[...this.left,...this.right];this.left=[];this.revision++;return;}
    if(final==='F' || (final==='~' && ['4','8'].includes(params))){this.left.push(...this.right);this.right=[];this.revision++;return;}
    if(final==='delete' || (final==='~' && params==='3')){this.right.shift();this.revision++;return;}
    if(final==='A' || final==='B'){this.uncertain=true;this.revision++;}
  }
  key(c){
    if(this.paste){this.left.push(c);this.revision++;return;}
    const n=c.codePointAt(0);this.revision++;
    if(c==='\r' || c==='\n'){
      // Native UserPromptSubmit, not Enter alone, confirms that text was accepted.
      this.pendingSubmit=true;this.left=[];this.right=[];this.uncertain=false;return;
    }
    if(c==='\x03'){this.reset();return;}
    if(c==='\x15'){
      while(this.left.length && this.left.at(-1)!=='\n')this.left.pop();
      // A known one-line draft can now be empty; unknown history remains protected.
      return;
    }
    if(c==='\x0b'){while(this.right.length && this.right[0]!=='\n')this.right.shift();return;}
    if(c==='\x17'){while(this.left.length && /\s/.test(this.left.at(-1)))this.left.pop();while(this.left.length && !/\s/.test(this.left.at(-1)))this.left.pop();return;}
    if(c==='\x08' || c==='\x7f'){this.left.pop();return;}
    if(c==='\x01'){this.right=[...this.left,...this.right];this.left=[];return;}
    if(c==='\x05'){this.left.push(...this.right);this.right=[];return;}
    if(c==='\t'){this.uncertain=true;return;}
    if(n>=32 && n!==127)this.left.push(c);
  }
}
