import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
for(const dir of ['src','bin','test'])if(fs.existsSync(dir))for(const file of fs.readdirSync(dir)){
  if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',dir+'/'+file],{stdio:'inherit'});
}
console.log('Syntax checks passed.');
