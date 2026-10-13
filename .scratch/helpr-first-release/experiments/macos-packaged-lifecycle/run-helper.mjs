import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawn} from 'node:child_process';import {root,data} from './harness.mjs';
const mode=process.argv[2],build=process.argv[3]||'build-5';if(!['audit','install-and-interrupt'].includes(mode))throw Error('mode-invalid');
const signature=JSON.parse(fs.readFileSync(path.join(root,'artifacts',`signed-${build}.json`)));if(!signature.verified)throw Error('signature-not-ready');
fs.writeFileSync(path.join(data,'helper-request.json'),JSON.stringify({mode,build}),{mode:0o600});
const bundle=path.join(root,signature.app);execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
const record=path.join(root,'artifacts',`helper-launch-${mode}-${build}.json`);if(fs.existsSync(record))throw Error('evidence-exists');
const child=spawn(path.join(bundle,'Contents/MacOS/helpr Lifecycle Lab'),['--lab-update-helper'],{cwd:'/',env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
const stderr=[];child.stderr.on('data',b=>stderr.push(b.toString()));child.on('exit',(code,signal)=>{const result={at:Date.now(),mode,build,code,signal,stderr:stderr.join('')};fs.writeFileSync(record,JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=mode==='install-and-interrupt'?(signal==='SIGKILL'?0:1):(code||0);});
