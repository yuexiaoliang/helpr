import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,ensure,hash,positionSchema} from './protocol.mjs';
import {openRun,capture,compact,artifactRule} from './runtime.mjs';
const root=path.resolve('artifacts/staged'),s=await session(root,'probe');
const source='../constrained-workflow-induction/artifacts/run/learn-4/results.json';
const prior=JSON.parse(await readFile(source)),mode=process.argv[2]||'learn';
const learning=mode.startsWith('learn');
const learned=learning?null:JSON.parse(await readFile(root+'/upload-probe-candidate.json'));
const f=await fixture(root,'upload-probe-'+mode),task=await s.parse(f,prior.task);
ensure(!task.rejected,'probe-rejected');
const out={name:f.envelope.id,task,trace:[],status:'running',source:{file:source,hash:hash(prior),steps:prior.trace.map(e=>e.step.id)}};
const r=await openRun(task,f.directory,s.meta.deadline,{holdUpload:true});
try {
  for(const entry of prior.trace){const step=structuredClone(entry.step);out.trace.push({step,result:await r.perform(step)});}
  const step=structuredClone(learned?.trace.at(-1).step||prior.failures.find(f=>f.step?.action.op==='upload'&&f.error.executed).step);
  const result=await r.perform(step);
  if(learning) {
    const obs=await capture(r.page),nodes=obs.nodes.filter(n=>n.tag==='a'&&n.href);
    await save(f.directory+'/uploaded-observation.json',obs);
    const key=step.action.value.input,p=await s.ask('probe-artifact','选择本次上传文件的实际可读链接，以便读取原始字节并比较授权素材哈希；不能用可编辑文件名代替完成证据。仅返回真实链接编号。',
      {input:key,file:task.inputs[key],page:compact({...obs,nodes})},positionSchema(nodes));
    step.after=[artifactRule(nodes.find(n=>n.id===p.target),task,key)];
    out.completionEvidence=await r.checks(step.after);r.remember(step.after[0]);
  } else {
    ensure(result.negative?.passed===false,'pending-state-falsely-complete');
    out.completionEvidence=await r.checks(step.after);
  }
  out.trace.push({step,result});out.status='upload-completed';
  if(learning)await save(root+'/upload-probe-candidate.json',out);
}catch(e){out.status='failed';out.error={code:e.code||e.name,message:e.message,detail:e.detail,executed:e.executed};out.lastObservation=await capture(r.page).catch(()=>null);}
finally{await r.close();out.modelCallsDuringBrowserReplay=learning?1:0;out.endedAt=new Date().toISOString();await save(f.directory+'/results.json',out);await s.persist();console.log(JSON.stringify({name:out.name,status:out.status,error:out.error,completion:out.completionEvidence,upload:out.trace.at(-1)?.result}));}
