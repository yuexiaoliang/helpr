// 对已冻结的第三版实验协议做诊断，不修改其执行权限或动作规则。
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,hash,ensure,validate,parseSchema,actionSchema} from './protocol.mjs';
import {openRun,capture,actionFrom,bind} from './runtime.mjs';

const root=path.resolve('artifacts/run'),s=await session(root,'calibrate');
const prior=JSON.parse(await readFile(root+'/learn-4/results.json'));
const earlier=JSON.parse(await readFile(root+'/learn-2/results.json'));
const f=await fixture(root,'diagnostic-calibration'),task=await s.parse(f,prior.task);ensure(!task.rejected,'diagnostic-task-rejected');
const report={startedAt:new Date().toISOString(),scope:'partial-prefix-calibration-and-guard-diagnostics',task,trace:[],requests:[],sourceHashes:{},status:'running'};
for(const file of ['protocol.mjs','runtime.mjs','diagnose.mjs'])report.sourceHashes[file]=hash(await readFile(file));
const r=await openRun(task,f.directory,s.meta.deadline,{holdUpload:true});
let probe='prefix';
r.page.on('request',req=>{
  if(['GET','HEAD','OPTIONS'].includes(req.method()))return;
  const body=req.postDataBuffer(),selected=Object.values(task.inputs).find(v=>v.type==='file');
  // 不保存请求正文、凭据、认证请求头或 nonce；仅保存传输形态与已授权样本是否可见。
  report.requests.push({probe,method:req.method(),path:new URL(req.url()).pathname,
    contentType:req.headers()['content-type'],reportedContentLength:req.headers()['content-length'],bodyAvailable:body!==null,
    bodyBytes:body?.length,bodySha256:body&&hash(body),sourceSha256:selected.sha256,
    jsonTopLevelKeys:(()=>{try{const p=JSON.parse(body?.toString());return p&&typeof p==='object'?Object.keys(p):null;}catch{return null;}})()});
});
try {
  for(const entry of prior.trace) {
    const step=structuredClone(entry.step),result=await r.perform(step);report.trace.push({id:step.id,op:step.action.op,result});
  }
  report.partialPrefix={passed:true,newTaskId:task.id,steps:report.trace.length,fullWorkflow:false};
  probe='upload-shape';
  const upload=structuredClone(prior.failures.find(f=>f.step?.action.op==='upload'&&f.error.executed).step);
  try {await r.perform(upload);report.uploadOutcome='unexpectedly-passed';}
  catch(e){report.uploadOutcome={code:e.code||e.name,message:e.message,executed:e.executed};}
  const source=await readFile(Object.values(task.inputs).find(v=>v.type==='file').path);
  report.sourceFileBytes=source.length;
  report.uploadRequests=report.requests.filter(q=>q.probe==='upload-shape');
  await save(f.directory+'/upload-observation.json',await capture(r.page));
  probe='wrong-effect';
  const actions=earlier.trace.filter(t=>t.step.effect==='commit').slice(0,2).map(t=>t.step);
  report.wrongEffect={source:'earlier actual commit proposals; initial dispatch classification intentionally read; no candidate seal involved',steps:[]};
  for(const original of actions) {
    const proposal={...structuredClone(original),id:'wrong-effect-'+original.id,effect:'read'};
    try{report.wrongEffect.steps.push({proposal,result:await r.perform(proposal)});}
    catch(e){report.wrongEffect.steps.push({proposal,error:{code:e.code||e.name,message:e.message.slice(0,500),executed:e.executed}});break;}
  }
  report.wrongEffect.blockedRequests=r.events.filter(e=>e.type==='mutation-request'&&e.effectProposal==='read'&&e.operation==='click');
  report.wrongEffect.passed=report.wrongEffect.blockedRequests.some(e=>e.outcome==='blocked'&&e.code==='inputs-not-covered')&&!report.wrongEffect.blockedRequests.some(e=>e.outcome==='allowed');
  report.finalObservation=await capture(r.page);
  report.protocolNegatives=[];
  const parse=JSON.parse(await readFile(root+'/model/22-parse-learn-4-accepted.json'));
  for(const [name,value] of [['wrapper',{proposal:parse}],['extra-field',{...parse,authorization:'changed'}],['wrong-type',{...parse,compatible:'true'}]]) {
    try{validate(value,parseSchema);report.protocolNegatives.push({name,passed:false});}
    catch(e){report.protocolNegatives.push({name,passed:true,code:e.code});}
  }
  report.status='diagnostic-completed';
} catch(e) {report.status='diagnostic-failed';report.error={code:e.code||e.name,message:e.message,detail:e.detail};}
finally {
  report.endedAt=new Date().toISOString();report.modelCallsDuringBrowserExecution=0;
  await r.page.screenshot({path:f.directory+'/page.png',fullPage:true}).catch(()=>{});await r.close();await save(f.directory+'/results.json',report);await s.persist();
  console.log(JSON.stringify({status:report.status,prefix:report.partialPrefix,upload:report.uploadOutcome,requests:report.uploadRequests,wrongEffect:report.wrongEffect?.passed,error:report.error},null,2));
}
