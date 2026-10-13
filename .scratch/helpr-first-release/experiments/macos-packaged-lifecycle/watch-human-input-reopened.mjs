// Same unperformed first human round after the app runtime cap; initial evidence retained.
// Observe human actions; never synthesize page input. Start B only after the human starts A.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import assert from 'node:assert/strict';import {root,data,wait} from './harness.mjs';
const output=path.join(root,'artifacts/packaged-human-input-reopened.jsonl');assert(!fs.existsSync(output));
const log=row=>fs.appendFileSync(output,JSON.stringify({at:Date.now(),...row})+'\n');
const call=command=>new Promise((resolve,reject)=>{const c=net.connect(path.join(data,'private-control/lab.sock'),()=>c.write(JSON.stringify(command)+'\n'));let s='';c.on('data',b=>s+=b);c.on('end',()=>{try{const r=JSON.parse(s);assert(r.ok,r.error);resolve(r.result);}catch(e){reject(e);}});c.on('error',reject);c.setTimeout(20000,()=>{c.destroy();reject(Error('control-timeout'));});});
try{
 const initial=await call({kind:'snapshot'});assert(initial.ready&&!initial.maintenance);assert.equal(initial.tasks[0].intent,'stopped');assert(initial.tasks[0].goal-initial.tasks[0].counter>=8);assert.equal(initial.tasks[1].intent,'completed');
 const events=path.join(initial.out,'events.jsonl');let offset=fs.statSync(events).size;let bStarted=false,continueSeen=0,takeover=false,lastPhase='',lastAAdvance=0;
 log({kind:'human-round-armed',round:1,version:initial.version,run:initial.out,tasks:initial.tasks});await call({kind:'show'});
 const deadline=Date.now()+85*60*1000;
 while(Date.now()<deadline){
  const all=fs.readFileSync(events);const lines=all.subarray(offset).toString().split('\n').filter(Boolean);offset=all.length;
  for(const line of lines){const e=JSON.parse(line);
   if(e.kind==='effect-verified'&&e.task==='A')lastAAdvance=e.at;
   if(e.kind==='interface-request'&&e.request.kind==='continue'&&e.request.task==='A'){continueSeen++;log({kind:'human-continue-request',sequence:continueSeen,sourceEventAt:e.at});}
   if(e.kind==='native-input'&&e.owner==='A'){takeover=true;log({kind:'observed-native-A-input',sourceEvent:e,lastAAdvance});}
   if(e.kind==='effect-verified'&&e.task==='B'&&takeover)log({kind:'B-advanced-after-A-input',counter:e.counter,sourceEventAt:e.at});
   if(['quit-dispatch-closed','host-exit'].includes(e.kind))throw Error('application-ended-during-human-round');
  }
  if(continueSeen&&!bStarted){const s=await call({kind:'snapshot'});if(s.tasks[0].intent==='running'){const r=await call({kind:'delegate',task:'B',steps:60});bStarted=true;log({kind:'B-started-after-human-A-continue',tasks:r.tasks});}}
  if(takeover&&continueSeen>=2){const s=await call({kind:'snapshot'});const website=JSON.parse(fs.readFileSync(path.join(initial.work,'website.json')));const key=JSON.stringify(s.tasks.map(t=>[t.intent,t.phase]));if(key!==lastPhase){log({kind:'after-human-resume',tasks:s.tasks,website});lastPhase=key;}
   if(s.tasks[0].intent==='completed'&&s.tasks[1].intent==='completed'){assert.equal(website.A.text,'手动接管测试');log({kind:'human-round-automatic-checks',pass:true,textRetained:true,requiresHumanReport:true});process.exit(0);}
   if(s.tasks[0].phase==='uncertain'){log({kind:'human-round-automatic-checks',pass:false,reason:'A result uncertain; explicit resume correctly remains blocked',requiresHumanReport:true});process.exitCode=1;break;}
  }
  await wait(250);
 }
 if(!takeover)throw Error('human-input-not-observed-before-deadline');
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
