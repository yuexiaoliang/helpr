import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {spawn,execFileSync} from 'node:child_process';import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'form-native-probe-')), rows=[];const fresh=path.join(dir,'watch-owner');
try{
execFileSync('/usr/bin/xcrun',['clang','-arch','arm64','-mmacosx-version-min=14.0','-Wall','-Wextra','-Werror','app/native/watch-owner.c','-o',fresh],{timeout:15000});execFileSync('/usr/bin/codesign',['--sign','-','--force',fresh],{timeout:15000,stdio:'pipe'});
for(const executable of [path.resolve('dist/native/watch-owner'),fresh,fresh]){
 const start=Date.now(),child=spawn(executable,[process.execPath,'-e','process.exit(64)'],{detached:true,stdio:['ignore','ignore','pipe','pipe','pipe','ipc','pipe']});let receipt='',stderr='';child.stdio[6].on('data',b=>receipt+=b);child.stderr.on('data',b=>stderr+=b);
 const done=await new Promise(resolve=>{const t=setTimeout(()=>{process.kill(-child.pid,'SIGKILL');resolve('timeout');},3000);child.once('close',(code,signal)=>{clearTimeout(t);resolve({code,signal});});});rows.push({executable,pid:child.pid,group:child.pid,ms:Date.now()-start,receipt,stderr,done});
}
const ps=execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,comm='],{encoding:'utf8'}).split('\n').filter(Boolean);const remaining=ps.filter(l=>rows.some(r=>Number(l.trim().split(/\s+/)[2])===r.group));console.log(JSON.stringify({rows,remaining},null,2));if(remaining.length||rows.some(r=>!r.receipt.includes('exit:64:0')))process.exitCode=1;
}finally{rmSync(dir,{recursive:true,force:true});}
