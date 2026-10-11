// 模型校准已有 finish 位置：使用既有 positionSchema/actionFrom，不改变执行协议。
import {readFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,oracle} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,ensure,hash,positionSchema} from './protocol.mjs';
import {chromium,compact,actionFrom} from './runtime.mjs';
import {checkAll} from '../workflow-reliability/executor.mjs';
const root=path.resolve('artifacts/staged'),s=await session(root,'calibrate');
const load=async f=>JSON.parse(await readFile(f));
const candidate=await load(root+'/candidate.json'),training=await load(root+'/learn-3/results.json'),trainingObservation=await load(root+'/learn-3/observation-3.json');
const calibration=await load(root+'/calibration/results.json'),task=await load(root+'/calibration/task.json');
const obs=calibration.lastObservation;
ensure(training.result?.independent?.verified&&calibration.status==='uncertain','calibration-evidence-required');
const matched=trainingObservation.nodes.filter(n=>n.tag==='a'&&n.href===training.result.url);
const nodes=obs.nodes.filter(n=>n.tag==='a'&&n.href&&matched.some(t=>hash(t.target)===hash(n.target)));
ensure(nodes.length,'no-stable-observed-result-link');
const p=await s.ask('calibrate-result-position','原 finish 名称包含旧任务标题，换文字后无法定位。以下候选均是训练时指向已独立核验结果、且在本次实际页面具有相同定位属性的链接。请选择本次公开结果的真实链接。只选择位置，不改任务、结果条件或执行权限。',
  {task:{goal:task.goal,inputs:task.inputs},failure:calibration.error,page:compact({...obs,nodes})},positionSchema(nodes));
const selected=nodes.find(n=>n.id===p.target);ensure(new URL(selected.href).origin===task.origin,'result-origin');
const f=await fixture(root,'calibration'),browser=await chromium.launch({headless:true});let runtimeEvidence,independent;
try {
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
  await page.goto(selected.href,{waitUntil:'domcontentloaded',timeout:60000});
  runtimeEvidence=await checkAll(page,candidate.resultRules,task,f.directory,()=>{s.guard();ensure(new URL(page.url()).origin===task.origin,'result-origin');},15000);
  independent=await oracle(browser,selected.href,f);
}finally{await browser.close();}
const oldFinish=candidate.steps.at(-1),previous=candidate.steps.at(-2);
ensure(oldFinish.action.op==='finish'&&hash(previous.after)===hash(oldFinish.before),'not-derived-next-step-condition');
const replacement=actionFrom({op:'finish',target:p.target,valueInput:'',literal:'',checked:false,nameInput:'',effect:oldFinish.effect,reason:p.reason},obs,task);
replacement.id=oldFinish.id;
const record={at:new Date().toISOString(),method:'existing bounded position proposal and action assembler',oldSeal:candidate.seal,proposal:p,oldFinish,replacement,
  observations:['learn-3/observation-3.json','calibration/results.json'],recoveredReadOnlyResult:{url:selected.href,runtimeEvidence,independent}};
await copyFile(root+'/candidate.json',root+'/candidate-before-position-calibration.json');
candidate.steps[candidate.steps.length-1]=replacement;previous.after=structuredClone(replacement.before);
candidate.positionCalibration={file:'result-position-calibration.json',at:record.at};
candidate.seal=hash({steps:candidate.steps,resultRules:candidate.resultRules,template:candidate.template});record.newSeal=candidate.seal;
await save(root+'/result-position-calibration.json',record);await save(root+'/candidate.json',candidate);await s.persist();
console.log(JSON.stringify({status:'model-position-calibrated',target:replacement.action.target,recoveredResult:independent.verified,newSeal:candidate.seal}));
