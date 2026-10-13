// User starts A with its existing Continue button, then performs real macOS sleep.
// B waits for participation. No synthetic power events or system setting changes.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import assert from 'node:assert/strict';import {root,data,wait} from './harness.mjs';
const output=path.join(root,'artifacts/human-power-sleep.jsonl');assert(!fs.existsSync(output));
const log=row=>fs.appendFileSync(output,JSON.stringify({at:Date.now(),...row})+'\n');
const call=command=>new Promise((resolve,reject)=>{const c=net.connect(path.join(data,'private-control/lab.sock'),()=>c.write(JSON.stringify(command)+'\n'));let s='';c.on('data',b=>s+=b);c.on('end',()=>{try{const r=JSON.parse(s);if(command.kind!=='snapshot')log({command,...r});assert(r.ok,r.error);resolve(r.result);}catch(e){reject(e);}});c.on('error',reject);c.setTimeout(20000,()=>{c.destroy();reject(Error('control-timeout'));});});
try{
 const initial=await call({kind:'snapshot'});assert(initial.ready&&!initial.maintenance&&!initial.suspended);assert(initial.tasks.every(t=>t.phase==='verified'));
 assert.equal(initial.tasks[0].counter,initial.tasks[0].goal);assert.equal(initial.tasks[1].intent,'completed');
 await call({kind:'continue',task:'A'});await call({kind:'delegate',task:'A',steps:60});await call({kind:'stop',task:'A'});await call({kind:'wait',task:'B'});
 const armed=await call({kind:'snapshot'});assert.equal(armed.tasks[0].phase,'verified');assert.equal(armed.tasks[0].intent,'stopped');assert(armed.tasks[0].goal-armed.tasks[0].counter>=50);assert.equal(armed.tasks[1].intent,'waiting');
 const events=path.join(initial.out,'events.jsonl');let offset=fs.statSync(events).size,previous=armed;const received=[],blocked=new Set();let suspended,resumed,atSuspend,lastPowerAt=0;const blockedInputs=[];
 log({kind:'human-sleep-armed',round:2,run:initial.out,tasks:armed.tasks});await call({kind:'show'});console.log(JSON.stringify({armed:'sleep-after-human-A-continue',tasks:armed.tasks}));
 const deadline=Date.now()+80*60*1000;
 while(Date.now()<deadline){
  const all=fs.readFileSync(events);for(const line of all.subarray(offset).toString().split('\n').filter(Boolean)){const e=JSON.parse(line);received.push(e);
   if(e.kind==='power'){lastPowerAt=e.at;log({kind:'observed-power-event',source:e});if(e.event==='lock-screen')blocked.add('lock');if(e.event==='unlock-screen')blocked.delete('lock');if(e.event==='suspend'){blocked.add('sleep');if(!suspended){suspended=e;atSuspend=previous;log({kind:'state-immediately-before-sleep',tasks:previous.tasks});}}if(e.event==='resume'){blocked.delete('sleep');if(suspended&&!resumed)resumed=e;}}
   if(blocked.size&&e.kind==='command'&&e.method?.startsWith('Input.'))blockedInputs.push(e);
   if(e.kind==='host-exit')throw Error('application-exited-before-sleep-check');
  }offset=all.length;
  previous=await call({kind:'snapshot'});
  if(suspended&&resumed&&!blocked.size&&Date.now()-lastPowerAt>1200&&!previous.suspended&&previous.tasks.every(t=>t.phase!=='verify'))break;
  await wait(250);
 }
 assert(suspended&&resumed,'real suspend/resume not observed');assert.equal(blockedInputs.length,0,'new browser input dispatched before all observed OS pause reasons cleared');
 assert.equal(atSuspend.tasks[0].intent,'running','A had already finished before sleep');assert.equal(previous.tasks[1].intent,'waiting');
 let after=previous;const beforeProgress=after.tasks[0].counter;
 if(after.tasks[0].intent==='running'&&after.tasks[0].phase==='verified'){
  const end=Date.now()+5000;do{await wait(300);after=await call({kind:'snapshot'});}while(after.tasks[0].counter===beforeProgress&&Date.now()<end);assert(after.tasks[0].counter>beforeProgress,'eligible A did not progress after wake verification');
 }
 const website=JSON.parse(fs.readFileSync(path.join(initial.work,'website.json')));assert.equal(website.A.text,'手动接管测试');
 const raw=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));const checks=raw.filter(e=>e.kind==='reopened-and-verified'&&e.at>=resumed.at);assert(checks.some(e=>e.task==='A')&&checks.some(e=>e.task==='B'));
 log({check:'real-sleep-active-work-reconciled-and-waiting-intent-retained',pass:true,powerEvents:{suspend:suspended,resume:resumed},activeAAtSleep:true,result:after.tasks[0].phase==='uncertain'?'unknown-remains-paused':after.tasks[0].intent,blockedBrowserInputs:blockedInputs.length,tasks:after.tasks,textRetained:true,requiresHumanReport:true});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
