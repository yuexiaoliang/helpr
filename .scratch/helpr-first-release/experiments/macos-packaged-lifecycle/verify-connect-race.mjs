import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {harness,root,wait} from './harness.mjs';
const label=process.argv[2];if(!['before','after','after-authorized'].includes(label))throw Error('label-invalid');const {log,call,result,until}=harness('connect-race-'+label);
let pid;
try{
 const state=await until(s=>s.ready&&s.tasks[0].intent==='completed');const controller=JSON.parse(fs.readFileSync(path.join(state.out,'pids.json'))).controller;
 const children=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').filter(l=>l.includes('helpr Lifecycle Lab.app/Contents/Frameworks/')&&l.includes('--utility-sub-type=node.mojom.NodeService')).map(l=>l.trim().match(/^(\d+)\s+(\d+)\s/)).filter(m=>m&&Number(m[2])===controller).map(m=>Number(m[1]));
 const original=new Set(children());const bFile=path.join(root,'budget.json'),b=JSON.parse(fs.readFileSync(bFile));assert((b.faults||0)<12);b.faults=(b.faults||0)+1;fs.writeFileSync(bFile,JSON.stringify(b,null,2)+'\n');
 const pending=call({kind:'delegate',task:'A',steps:1});const deadline=Date.now()+2500;
 while(!pid&&Date.now()<deadline){pid=children().find(p=>!original.has(p));if(!pid)await wait(15);}assert(pid,'new owned worker not found');process.kill(pid,'SIGSTOP');log({kind:'worker-start-delayed',pid,milliseconds:1400});await wait(1400);process.kill(pid,'SIGCONT');pid=null;
 const outcome=await pending;log({check:'new-work-waits-for-browser-connection',pass:outcome.ok,error:outcome.error});assert(outcome.ok,outcome.error);await until(s=>s.tasks[0].intent==='completed');
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}finally{if(pid)try{process.kill(pid,'SIGCONT');}catch{}}
