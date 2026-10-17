// 只补实际视图重建后继续与控制断管；通过验证器的受限公开命令操作。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validationRoot} from './workspace-budget.mjs';

const round = process.argv[2]?.match(/^--round=([a-z0-9-]{1,40})$/)?.[1];
assert(round && process.argv.length === 3, 'ROUND_REQUIRED');
const root = path.join(validationRoot,round);
const read = () => JSON.parse(fs.readFileSync(path.join(root,'result.json')));
assert(read().phase === 'ready' && !read().finished, 'LIVE_READY_ROUND_REQUIRED');
const lock = path.join(root,'lifecycle-client.lock');
fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const report = {started:new Date().toISOString(),stages:[]};
const save = () => fs.writeFileSync(path.join(root,'lifecycle-client.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
let ids;
async function control(command) {
  const id=randomUUID(), target=path.join(root,'command.json'), temporary=target+'.'+id;
  assert(!fs.existsSync(target),'COMMAND_PENDING');
  fs.writeFileSync(temporary,JSON.stringify({...command,id}),{flag:'wx',mode:0o600});fs.renameSync(temporary,target);
  const end=Date.now()+(command.kind==='finish'?60000:20000);
  while(Date.now()<end){
    const response=path.join(root,'response.json');
    if(fs.existsSync(response)){const r=JSON.parse(fs.readFileSync(response));if(r.id===id){assert(r.ok,r.error);return r.value;}}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('CONTROL_TIMEOUT');
}
const rpc = (name,command) => control({name,command:command.kind==='execution-intent'?{requestId:randomUUID(),...command}:command});
async function state(){const s=await control({kind:'state'});return{...s,tasks:Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,s.snapshot.tasks.find(t=>t.id===id)]))};}
async function wait(predicate){const end=Date.now()+15000;while(Date.now()<end){const s=await state();if(predicate(s))return s;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('LIFECYCLE_WAIT_EXPIRED');}
const execution = (s,name) => s.tasks[name].execution;
const held = (s,name,count) => s.held.some(h=>h.name===name&&h.count===count&&!h.closed);
const effects = name => read().effects.filter(row=>row.name===name).map(row=>row.count);
async function checkpoint(label){
  const s=await state();report.stages.push({label,at:Date.now(),tasks:Object.fromEntries(Object.entries(s.tasks).map(([name,t])=>[name,{execution:t.execution,control:t.executionControl}])),gates:s.gates,held:s.held,effects:read().effects.map(({name,count,at})=>({name,count,at}))});save();
  await control({kind:'checkpoint',label});console.log(label);
}
async function finish(){
  const r=read();
  if(r.finished)return;
  if(r.controlFailure||r.fixtureFailure||r.failure){
    const end=Date.now()+60000;while(Date.now()<end&&!read().finished)await new Promise(resolve=>setTimeout(resolve,100));
    assert(read().finished,'FAILED_ROUND_DID_NOT_FINISH');
  }else await control({kind:'finish'});
}
try{
  ids=await control({kind:'pair',names:['Y','Z']});
  for(const name of ['Y','Z'])await rpc(name,{kind:'execution-intent',intent:'start'});
  const initial=await wait(s=>held(s,'Y',0)&&held(s,'Z',0));
  report.originalGeneration=initial.tasks.Y.messages.find(m=>m.call)?.call.source.generation;
  const before=await rpc('Y',{kind:'observe'});
  // 真实销毁／重开是未通过的“重建后继续”所需前置，不重做人工输入案例。
  await rpc('Y',{kind:'validation-fault',fault:'destroy-view'});
  await wait(s=>execution(s,'Y').phase==='paused'&&execution(s,'Y').pauseReason==='page-change');
  await rpc('Y',{kind:'reload'});
  const after=await rpc('Y',{kind:'observe'});
  assert(before.frameTree.frame.id!==after.frameTree.frame.id,'REBUILT_TARGET_REQUIRED');
  report.viewTargets={before:before.frameTree.frame.id,after:after.frameTree.frame.id};save();
  await control({kind:'check',label:'rebuilt-view-before-explicit-continue',phases:{Y:'paused'},reasons:{Y:'page-change'},effects:{Y:[],Z:[]}});
  await checkpoint('rebuilt-view-before-explicit-continue');
  await rpc('Y',{kind:'execution-intent',intent:'continue'});
  await wait(s=>held(s,'Y',0));
  await control({kind:'release',names:['Y'],holdNext:1});
  const advanced=await wait(s=>held(s,'Y',1)&&execution(s,'Y').phase==='running'&&JSON.stringify(effects('Y'))==='[1]');
  const action=execution(advanced,'Y').actions.at(-1);
  assert(action.source.generation>report.originalGeneration,'NEW_PAGE_OBSERVATION_REQUIRED');
  report.rebuiltAction={binding:action.binding,source:action.source,status:action.status};save();
  await control({kind:'check',label:'rebuilt-view-continue-actually-advances',phases:{Y:'running',Z:'checking'},effects:{Y:[1],Z:[]}});
  await control({kind:'release',names:['Z'],holdNext:1});
  const active=await wait(s=>held(s,'Y',1)&&held(s,'Z',1)&&execution(s,'Y').phase==='running'&&execution(s,'Z').phase==='running'&&JSON.stringify(effects('Z'))==='[1]');
  for(const name of ['Y','Z'])assert(active.gates[name].available&&!active.gates[name].blocked,'LIVE_ALLOWED_GATE_REQUIRED');
  await checkpoint('both-live-before-control-disconnect');
  await rpc('Y',{kind:'validation-fault',fault:'disconnect'});
  const stopped=await wait(s=>['Y','Z'].every(n=>execution(s,n).phase==='paused'&&execution(s,n).pauseReason==='page-change'&&!s.gates[n].available&&s.gates[n].blocked));
  assert(['Y','Z'].every(n=>execution(stopped,n).intent==='automatic'),'DISCONNECT_MUST_PRESERVE_INTENT');
  await control({kind:'check',label:'disconnect-revokes-both-live-tasks',phases:{Y:'paused',Z:'paused'},reasons:{Y:'page-change',Z:'page-change'},intents:{Y:'automatic',Z:'automatic'},effects:{Y:[1],Z:[1]}});
  await checkpoint('both-paused-after-control-disconnect');
  await control({kind:'release',names:['Y','Z']});
  await control({name:'Y',defer:'disconnected-continue',allowError:'CONTROL_DISCONNECTED',command:{kind:'execution-intent',intent:'continue',requestId:randomUUID()}});
  const refused=await wait(s=>s.deferred['disconnected-continue']?.finishedAt);
  assert.equal(refused.deferred['disconnected-continue'].error,'CONTROL_DISCONNECTED');
  await control({kind:'check',label:'disconnected-continue-and-old-replies-cannot-advance',phases:{Y:'paused',Z:'paused'},effects:{Y:[1],Z:[1]}});
  report.disconnectedContinueRefused=true;save();
  // 独立停止可以可靠保存；不把它或退出当成自动恢复。
  await rpc('Y',{kind:'execution-intent',intent:'stop'});
  await control({kind:'check',label:'explicit-stop-after-disconnect-is-saved',phases:{Y:'stopped',Z:'paused'},intents:{Y:'stopped',Z:'automatic'},effects:{Y:[1],Z:[1]}});
  await checkpoint('disconnected-continue-refused-and-explicit-stop-saved');
  await finish();
  assert(read().exitCode===0&&read().survivors.length===0,'NORMAL_EXIT_REQUIRED');
  report.finished=new Date().toISOString();save();console.log('LIFECYCLE_PASSED');
}catch(error){
  report.failure=error.message;save();
  try{await finish();}catch(error){report.finishFailure=error.message;save();}
  process.stderr.write(error.message+'\n');process.exitCode=1;
}finally{fs.unlinkSync(lock);}
