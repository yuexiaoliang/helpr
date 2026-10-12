// 用既有封闭动作组装校准结果位置，只核对已提交产出，不重新发布。
import {readFile,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {session,save,ensure,hash,object,choice,string} from './protocol.mjs';
import {chromium,compact,actionFrom,openRun} from './runtime.mjs';
import {oracle} from './fixtures.mjs';
const root=path.resolve('artifacts/drupal'),s=await session(root,'calibrate');
const load=async f=>JSON.parse(await readFile(f));
const candidate=await load(root+'/candidate.json'),calibration=await load(root+'/calibration/results.json');
const task=await load(root+'/calibration/task.json'),f=await load(root+'/calibration/fixture.json'),obs=calibration.lastObservation;
ensure(calibration.status==='uncertain'&&calibration.error?.executed,'calibration-evidence-required');
ensure(!candidate.positionCalibration,'position-calibration-already-applied');
const nodes=obs.nodes.filter(n=>n.tag==='a'&&n.href),keys=Object.entries(task.inputs).filter(([,v])=>v.type==='string').map(([k])=>k);
const p=await s.ask('calibrate-result-position','已提交后的结果位置未通过：旧 finish 使用了训练样本名称。仅从本次实际页面选择本次公开结果的链接，不改变任务、结果条件或权限。若链接名称等于动态输入，必须通过 nameInput 绑定对应输入；否则选择能在换输入后保持稳定的实际链接，nameInput 留空。未知位置不得猜测。',
  {task:{goal:task.goal,inputs:task.inputs},oldFinish:candidate.steps.at(-1),failure:calibration.error,page:compact({...obs,nodes})},
  object({target:choice(nodes.map(n=>n.id)),nameInput:choice(['',...keys]),reason:string}));
const selected=nodes.find(n=>n.id===p.target),url=new URL(selected.href,obs.url).href;
ensure(new URL(url).origin===task.origin,'result-origin');
if(keys.some(k=>task.inputs[k].value===selected.name))ensure(p.nameInput,'dynamic-result-name-needs-binding');
const oldFinish=candidate.steps.at(-1),previous=candidate.steps.at(-2);
ensure(oldFinish.action.op==='finish'&&hash(previous.after)===hash(oldFinish.before),'not-derived-next-step-condition');
const replacement=actionFrom({op:'finish',target:p.target,valueInput:'',literal:'',checked:false,nameInput:p.nameInput,effect:oldFinish.effect,reason:p.reason},obs,task);replacement.id=oldFinish.id;
const r=await openRun(task,root+'/position-calibration',s.meta.deadline);let runtimeEvidence,independent;
try {runtimeEvidence=await r.publicResult(url,candidate.resultRules);independent=await oracle(r.browser,url,f);}
finally {await r.close();}
const record={at:new Date().toISOString(),method:'bounded model position proposal + existing nameInput binding and action assembler',sourceHash:hash(await readFile('calibrate-result-position.mjs')),oldSeal:candidate.seal,proposal:p,oldFinish,replacement,observations:['calibration/results.json'],recoveredReadOnlyResult:{url,runtimeEvidence,independent}};
await copyFile('calibrate-result-position.mjs',root+'/position-calibration/source.mjs');
await copyFile(root+'/candidate.json',root+'/candidate-before-position-calibration.json');
candidate.steps[candidate.steps.length-1]=replacement;previous.after=structuredClone(replacement.before);
candidate.positionCalibration={file:'result-position-calibration.json',at:record.at};candidate.seal=hash({steps:candidate.steps,resultRules:candidate.resultRules,template:candidate.template});record.newSeal=candidate.seal;
await save(root+'/result-position-calibration.json',record);await save(root+'/candidate.json',candidate);await s.persist();
console.log(JSON.stringify({status:'model-position-calibrated',target:replacement.action.target,recoveredResult:independent.passed,newSeal:candidate.seal}));
