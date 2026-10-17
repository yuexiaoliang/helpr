// 只补 04 鼠标移动和真实提交等待下的输入次序；按键由桌面工具独立产生。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validationRoot} from './workspace-budget.mjs';
const round=process.argv[2]?.match(/^--round=([a-z0-9-]{1,40})$/)?.[1];
const timingOnly=process.argv[3]==='--only=timing';
assert(round && process.argv.length===(timingOnly?4:3),'ROUND_REQUIRED');
const root=path.join(validationRoot,round);
const read=()=>JSON.parse(fs.readFileSync(path.join(root,'result.json')));
assert(read().phase==='ready' && !read().finished,'LIVE_READY_ROUND_REQUIRED');
const report={started:new Date().toISOString(),scope:'movement-and-delayed-input-during-real-commit-wait',stages:[]};
const lock=path.join(root,'final-client.lock');fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const save=()=>fs.writeFileSync(path.join(root,'final-client.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function control(job){
  const id=randomUUID(),file=path.join(root,'command.json'),tmp=file+'.'+id;
  assert(!fs.existsSync(file),'COMMAND_PENDING');
  fs.writeFileSync(tmp,JSON.stringify({...job,id}),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);
  const end=Date.now()+(job.kind==='finish'?60000:20000);
  while(Date.now()<end){const file=path.join(root,'response.json');if(fs.existsSync(file)){const r=JSON.parse(fs.readFileSync(file));if(r.id===id){assert(r.ok,r.error);return r.value;}}await new Promise(r=>setTimeout(r,40));}
  throw Error('CONTROL_TIMEOUT');
}
const rpc=(name,command)=>control({name,command:command.kind==='execution-intent'?{requestId:randomUUID(),...command}:command});
async function wait(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const r=read();assert(!r.finished&&!r.failure&&!r.fixtureFailure&&!r.controlFailure,r.failure??r.fixtureFailure??r.controlFailure??'ROUND_FINISHED');if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('FINAL_WAIT_EXPIRED');}
async function finish(){const r=read();if(r.finished)return;if(r.failure||r.fixtureFailure||r.controlFailure){const end=Date.now()+60000;while(Date.now()<end&&!read().finished)await new Promise(r=>setTimeout(r,100));assert(read().finished,'FAILED_ROUND_DID_NOT_FINISH');}else await control({kind:'finish'});}
try{
  const ids=await control({kind:'pair',names:['Y','Z']});
  report.ids=ids;report.phase='focus-input-before-start';save();console.log('FOCUS_INPUT_BEFORE_START');
  await wait(()=>fs.existsSync(path.join(root,'input-focused.json')),120000);
  for(const name of ['Y','Z'])await rpc(name,{kind:'execution-intent',intent:'start'});
  let before;
  await wait(async()=>{before=await control({kind:'state'});return ['Y','Z'].every(name=>before.held.some(h=>h.name===name&&h.count===0&&!h.closed)&&before.gates[name].available&&!before.gates[name].blocked);});
  if(!timingOnly){
  const inputOffset=read().inputs.length;
  for(const [x,y] of [[100,140],[180,140],[260,140]])await rpc('Y',{kind:'validation-move',x,y});
  await wait(()=>read().inputs.slice(inputOffset).filter(r=>r.name==='Y'&&r.kind==='mousemove').length>=3);
  const after=await control({kind:'state'});
  for(const name of ['Y','Z']){
    assert.deepEqual(after.gates[name],before.gates[name],'MOVEMENT_CHANGED_GATE');
    assert.deepEqual(after.snapshot.tasks.find(t=>t.id===ids[name]).execution,before.snapshot.tasks.find(t=>t.id===ids[name]).execution,'MOVEMENT_CHANGED_EXECUTION');
  }
  assert.equal(read().effects.length,0,'MOVEMENT_SENT_EFFECT');
  const moves=JSON.parse(fs.readFileSync(path.join(root,'native-trace.json'))).rows.slice(before.traceLength);
  assert(moves.filter(r=>r.stage==='move-pass'&&r.owner==='web:'+ids.Y).length>=3,'NATIVE_MOVEMENT_REQUIRED');
  assert(!moves.some(r=>r.stage==='identified'||r.stage==='blocked'),'MOVEMENT_TRIGGERED_TAKEOVER');
  report.movement={before,after,inputs:read().inputs.slice(inputOffset),trace:moves};save();
  await control({kind:'checkpoint',label:'three-native-moves-without-takeover'});
  }
  for(const name of ['Y','Z'])await control({kind:'barrier',name,point:'input',action:'arm'});
  await control({kind:'barrier',name:'Y',point:'suspension',action:'arm'});
  await control({kind:'release',names:['Y','Z'],holdNext:1});
  await wait(async()=>{const s=await control({kind:'state'});return ['Y','Z'].every(name=>s.barriers.waits.some(w=>w.key==='input:'+ids[name]&&w.reached));});
  report.phase='ready-to-arm-storage';save();console.log('READY_TO_ARM_STORAGE');
  // 焦点已在开始前由桌面工具确认；两包到达后立即进入提交等待，不再插入桌面观察。
  await control({kind:'timing',name:'Y',other:'Z'});
  report.phase='waiting-for-key';save();console.log('STORAGE_PENDING_SEND_KEY');
  await wait(()=>Boolean(read().timing?.finishedAt),15000);
  const result=read(), timing=result.timing;
  assert(!timing.failure,'TIMING_FAILED');
  const trace=JSON.parse(fs.readFileSync(path.join(root,'native-trace.json'))).rows;
  const rows=trace.slice(timing.before.traceLength);
  const identified=rows.findIndex(r=>r.stage==='identified'&&r.owner==='web:'+ids.Y);
  assert(identified>=0,'NATIVE_KEY_IDENTIFICATION_REQUIRED');
  const serial=rows[identified].serial;
  const blocked=rows.findIndex(r=>r.stage==='blocked'&&r.serial===serial);
  const handoff=rows.findIndex(r=>r.stage==='handoff'&&r.serial===serial);
  const page=rows.findIndex(r=>r.stage==='web-before-input'&&r.serial===serial&&r.owner==='web:'+ids.Y);
  assert(identified<blocked&&blocked<handoff&&handoff<page,'NATIVE_TO_PAGE_CAUSAL_ORDER');
  assert(rows[blocked].epoch>timing.before.gates.Y.epoch&&rows[page].epoch===rows[blocked].epoch,'PAGE_RECEIVES_REVOKED_EPOCH');
  const receipt=result.inputs.find(r=>r.name==='Y'&&r.kind==='keydown'&&r.at>=timing.readyAt);
  assert(receipt&&receipt.traceLength>timing.before.traceLength+page&&receipt.gates.Y.blocked&&!receipt.gates.Z.blocked,'INDEPENDENT_WEB_RECEIPT_REQUIRED');
  const denied=rows.findIndex(r=>r.stage==='permit-denied'&&r.owner===ids.Y&&r.epoch===timing.before.gates.Y.epoch);
  assert(denied>page,'OLD_PACKET_MUST_BE_DENIED_AFTER_RECEIPT');
  assert.deepEqual(result.effects.map(r=>[r.name,r.count]),[['Z',1]],'ONLY_OTHER_TASK_ADVANCES');
  const task=timing.after.snapshot.tasks.find(t=>t.id===ids.Y);
  assert(task.execution.phase==='paused'&&task.execution.pauseReason==='takeover'&&task.execution.intent==='automatic'&&task.executionControl.stopSaved,'RELIABLE_TAKEOVER_REQUIRED');
  report.causality={serial,nativeTraceOffset:timing.before.traceLength,identified,blocked,handoff,page,denied,receipt,rows};
  report.phase='passed';report.finished=new Date().toISOString();save();
  await control({kind:'checkpoint',label:'delayed-notification-and-real-commit-wait-passed'});
  await finish();
  const done=read();for(const key of ['failure','fixtureFailure','controlFailure','cleanupFailure','traceFailure'])assert(!done[key],`${key}:${done[key]}`);
  assert(done.exitCode===0&&done.survivors.length===0,'NORMAL_EXIT_REQUIRED');
  console.log('FINAL_TWO_PASSED');
}catch(error){report.failure=error.message;save();try{await finish();}catch(error){report.finishFailure=error.message;save();}process.stderr.write(error.message+'\n');process.exitCode=1;}finally{fs.unlinkSync(lock);}
