// Human performs the real OS action. The verifier never locks, sleeps or changes power settings.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import assert from 'node:assert/strict';import {root,data,wait} from './harness.mjs';
const phase=process.argv[2];assert(['lock','sleep'].includes(phase));const output=path.join(root,'artifacts','human-power-'+phase+'.jsonl');assert(!fs.existsSync(output));
const log=row=>fs.appendFileSync(output,JSON.stringify({at:Date.now(),...row})+'\n');
const call=command=>new Promise((resolve,reject)=>{const c=net.connect(path.join(data,'private-control/lab.sock'),()=>c.write(JSON.stringify(command)+'\n'));let s='';c.on('data',b=>s+=b);c.on('end',()=>{try{const r=JSON.parse(s);assert(r.ok,r.error);resolve(r.result);}catch(e){reject(e);}});c.on('error',reject);c.setTimeout(20000,()=>{c.destroy();reject(Error('control-timeout'));});});
try{
 const initial=await call({kind:'snapshot'});assert(initial.ready&&!initial.maintenance&&!initial.suspended);
 if(initial.tasks[0].intent!=='stopped'){assert.equal(initial.tasks[0].phase,'verified');await call({kind:'stop',task:'A'});}
 const events=path.join(initial.out,'events.jsonl');let offset=fs.statSync(events).size;const received=[];
 if(initial.tasks[1].intent==='completed')await call({kind:'delegate',task:'B',steps:60});
 let previous=await call({kind:'snapshot'});log({kind:'human-power-armed',round:2,phase,run:initial.out,tasks:previous.tasks});console.log(JSON.stringify({armed:phase,tasks:previous.tasks}));
 const beginEvent=phase==='lock'?'lock-screen':'suspend',endEvent=phase==='lock'?'unlock-screen':'resume';let began,ended,atBegin;const deadline=Date.now()+80*60*1000;
 while(Date.now()<deadline&&!ended){
  const all=fs.readFileSync(events);for(const line of all.subarray(offset).toString().split('\n').filter(Boolean)){const e=JSON.parse(line);received.push(e);if(e.kind==='power'){log({kind:'observed-power-event',source:e});if(e.event===beginEvent&&!began){began=e;atBegin=previous;log({kind:'state-immediately-before-power',tasks:previous.tasks,suspended:previous.suspended});}if(began&&e.event===endEvent&&!ended)ended=e;}if(e.kind==='host-exit')throw Error('application-exited-before-power-check');}offset=all.length;
  if(!ended){previous=await call({kind:'snapshot'});await wait(250);}
 }
 assert(began&&ended,'real power event pair not observed');
 let after;const checkEnd=Date.now()+20000;do{after=await call({kind:'snapshot'});if(!after.suspended&&after.tasks.every(t=>t.phase!=='verify'))break;await wait(250);}while(Date.now()<checkEnd);
 const intervalInputs=received.filter(e=>e.at>began.at&&e.at<ended.at&&e.kind==='command'&&e.method?.startsWith('Input.'));
 assert.equal(intervalInputs.length,0,'new browser input dispatched during OS pause');assert.equal(after.tasks[0].intent,'stopped');assert(!after.suspended,'system recovery remains blocked');
 const baseCounter=after.tasks[1].counter;
 if(after.tasks[1].intent==='running'&&after.tasks[1].phase==='verified'){
  const progressEnd=Date.now()+5000;do{await wait(300);after=await call({kind:'snapshot'});}while(after.tasks[1].counter===baseCounter&&Date.now()<progressEnd);assert(after.tasks[1].counter>baseCounter,'eligible B did not continue after verification');
 }
 const text=JSON.parse(fs.readFileSync(path.join(initial.work,'website.json'))).A.text;assert.equal(text,'手动接管测试');
 const bBefore=atBegin.tasks[1],bAfter=after.tasks[1];
 log({check:'real-power-pair-retains-stop-and-text-with-no-new-input-while-paused',pass:true,phase,powerEvents:{begin:began,end:ended},activeBAtBegin:bBefore.intent==='running',BResult:bAfter.phase==='uncertain'?'unknown-remains-paused':bAfter.intent==='running'?'continued-after-check':bAfter.intent,intervalBrowserInputs:intervalInputs.length,tasks:after.tasks,textRetained:true,requiresHumanReport:true});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
