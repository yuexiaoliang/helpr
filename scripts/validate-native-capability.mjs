// 只补面板绑定与能力恢复；正式公开入口负责状态和效果，验证故障只改变取样点。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validationRoot} from './workspace-budget.mjs';

const round=process.argv[2]?.match(/^--round=([a-z0-9-]{1,40})$/)?.[1];
assert(round&&process.argv.length===3,'ROUND_REQUIRED');
const root=path.join(validationRoot,round),read=()=>JSON.parse(fs.readFileSync(root+'/result.json'));
assert(read().phase==='ready'&&!read().finished,'LIVE_READY_ROUND_REQUIRED');
const lock=root+'/lifecycle-client.lock';fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const report={scope:'native-panel-and-capability-recovery',started:new Date().toISOString(),stages:[]};
const save=()=>fs.writeFileSync(root+'/lifecycle-client.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
let ids;
async function control(job){
  const id=randomUUID(),target=root+'/command.json',tmp=target+'.'+id;
  assert(!fs.existsSync(target),'COMMAND_PENDING');fs.writeFileSync(tmp,JSON.stringify({...job,id}),{flag:'wx',mode:0o600});fs.renameSync(tmp,target);
  const end=Date.now()+(job.kind==='finish'?60000:20000);
  while(Date.now()<end){const response=root+'/response.json';if(fs.existsSync(response)){const r=JSON.parse(fs.readFileSync(response));if(r.id===id){assert(r.ok,r.error);return r.value;}}await new Promise(r=>setTimeout(r,100));}
  throw Error('CONTROL_TIMEOUT');
}
const rpc=(name,command)=>control({name,command:command.kind==='execution-intent'?{requestId:randomUUID(),...command}:command});
async function state(){const s=await control({kind:'state'});return{...s,tasks:Object.fromEntries(Object.entries(ids).map(([n,id])=>[n,s.snapshot.tasks.find(t=>t.id===id)]))};}
async function wait(predicate){const end=Date.now()+15000;while(Date.now()<end){const s=await state();if(predicate(s))return s;await new Promise(r=>setTimeout(r,100));}throw Error('CAPABILITY_WAIT_EXPIRED');}
const held=(s,name,count)=>s.held.some(h=>h.name===name&&h.count===count&&!h.closed);
const effects=name=>read().effects.filter(e=>e.name===name).map(e=>e.count);
const paused=s=>['Y','Z'].every(n=>s.tasks[n].execution.phase==='paused'&&s.tasks[n].execution.pauseReason==='native-unavailable'&&s.tasks[n].execution.intent==='automatic'&&s.tasks[n].executionControl?.stopSaved===true);
async function checkpoint(label){const s=await state();report.stages.push({label,at:Date.now(),tasks:Object.fromEntries(Object.entries(s.tasks).map(([n,t])=>[n,{execution:t.execution,control:t.executionControl}])),gates:s.gates,held:s.held,effects:read().effects.map(({name,count,at})=>({name,count,at}))});save();await control({kind:'checkpoint',label});console.log(label);}
async function finish(){const r=read();if(r.finished)return;if(r.controlFailure||r.fixtureFailure||r.failure){const end=Date.now()+60000;while(!read().finished&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(read().finished,'FAILED_ROUND_DID_NOT_FINISH');}else await control({kind:'finish'});}
try{
  await control({kind:'native-check',label:'before-panel-checks',available:true});
  for(const panel of ['quit','new','settings','tasks']){
    await control({command:{kind:'panel',panel}});
    await control({kind:'native-check',label:panel+'-panel-preserves-native-capability',available:true});
    await control({command:{kind:'panel',panel:'none'}});
  }
  ids=await control({kind:'pair',names:['Y','Z']});
  for(const n of ['Y','Z'])await rpc(n,{kind:'execution-intent',intent:'start'});
  const initial=await wait(s=>held(s,'Y',0)&&held(s,'Z',0));
  for(const n of ['Y','Z'])assert(initial.gates[n].available&&!initial.gates[n].blocked,'INITIAL_ALLOWED_GATE_REQUIRED');
  await control({command:{kind:'panel',panel:'quit'}});
  await control({kind:'native-check',label:'loaded-quit-panel-before-fault',available:true});
  await checkpoint('both-live-before-native-binding-loss');
  report.faultRequestedAt=Date.now();save();
  await rpc('Y',{kind:'validation-fault',fault:'panel-anchor-gap'});
  const lost=await wait(s=>paused(s)&&['Y','Z'].every(n=>!s.gates[n].available&&s.gates[n].blocked&&s.gates[n].epoch>initial.gates[n].epoch));
  await control({kind:'native-check',label:'old-panel-anchor-reproduces-real-native-loss',available:false});
  await checkpoint('native-binding-loss-reliably-pauses-both');
  await control({name:'Y',defer:'unavailable-continue',allowError:'NATIVE_INPUT_UNAVAILABLE',command:{kind:'execution-intent',intent:'continue',requestId:randomUUID()}});
  const refused=await wait(s=>s.deferred['unavailable-continue']?.finishedAt&&paused(s));
  assert.equal(refused.deferred['unavailable-continue'].error,'NATIVE_INPUT_UNAVAILABLE');
  report.restoreRequestedAt=Date.now();save();
  await rpc('Y',{kind:'validation-fault',fault:'panel-anchor-restore'});
  const restored=await wait(s=>paused(s)&&['Y','Z'].every(n=>s.gates[n].available&&s.gates[n].blocked&&s.gates[n].epoch>=lost.gates[n].epoch));
  await control({kind:'native-check',label:'same-panel-center-restores-real-native-capability',available:true});
  await control({command:{kind:'panel',panel:'none'}});
  await control({kind:'check',label:'native-restoration-does-not-continue',phases:{Y:'paused',Z:'paused'},intents:{Y:'automatic',Z:'automatic'},effects:{Y:[],Z:[]}});
  assert.equal(read().models.length,2,'RESTORATION_MUST_NOT_START_MODEL');
  await checkpoint('native-restored-both-await-explicit-continue');
  await new Promise(r=>setTimeout(r,150));
  const capture=await control({command:{kind:'capture'}});fs.writeFileSync(root+'/native-restored.png',Buffer.from(capture,'base64'),{mode:0o600});report.capture='native-restored.png';save();
  await control({kind:'release',names:['Y','Z'],holdNext:0});
  await rpc('Y',{kind:'execution-intent',intent:'continue'});
  await wait(s=>held(s,'Y',0));
  await control({kind:'release',names:['Y'],holdNext:1});
  await wait(s=>held(s,'Y',1)&&s.tasks.Y.execution.phase==='running'&&JSON.stringify(effects('Y'))==='[1]');
  await control({kind:'check',label:'explicit-continue-only-Y-advances-after-native-restoration',phases:{Y:'running',Z:'paused'},effects:{Y:[1],Z:[]}});
  await checkpoint('restored-native-capability-allows-explicit-Y-only');
  report.restoredGates=restored.gates;save();
  await finish();const r=read();for(const key of ['failure','controlFailure','fixtureFailure','traceFailure','cleanupFailure'])assert(!r[key],`ROUND_FAILED:${key}:${r[key]}`);assert(r.exitCode===0&&r.survivors.length===0,'NORMAL_EXIT_REQUIRED');report.finished=new Date().toISOString();save();console.log('NATIVE_CAPABILITY_PASSED');
}catch(error){report.failure=error.message;save();try{await finish();}catch(error){report.finishFailure=error.message;save();}console.error(error.message);process.exitCode=1;}finally{fs.unlinkSync(lock);}
