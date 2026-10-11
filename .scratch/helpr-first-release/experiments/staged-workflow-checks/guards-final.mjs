// 最终执行协议上的同一错误首次提议反例；夹具目录独立。
// 对真实上传与真实发布控件的受控反例；不提供产品网站规则。
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,ensure,hash} from './protocol.mjs';
import {openRun,capture} from './runtime.mjs';
const root=path.resolve('artifacts/staged'),s=await session(root,'probe');
const prior=JSON.parse(await readFile(root+'/upload-probe-candidate.json'));
const earlier=JSON.parse(await readFile('../constrained-workflow-induction/artifacts/run/learn-2/results.json'));
const f=await fixture(root,'guard-probes-final'),task=await s.parse(f,prior.task);ensure(!task.rejected,'guard-task-rejected');
const report={startedAt:new Date().toISOString(),task,runs:[],modelCallsDuringBrowserExecution:0};
const material=Object.values(task.inputs).find(v=>v.type==='file'),bytes=await readFile(material.path);
for(const mode of ['wrong-initial-effect']) {
  const directory=f.directory+'/'+mode;await mkdir(directory,{recursive:true});
  const out={mode,status:'running',trace:[]};report.runs.push(out);
  const r=await openRun(task,directory,s.meta.deadline,{holdUpload:true,onUploadHeld:async ({page,permit,emit})=>{
    if(mode==='material-change') {await writeFile(material.path,Buffer.concat([bytes,Buffer.from('changed')]));await emit({type:'fixture-material-changed'});}
    if(mode==='document-change') {await page.evaluate(()=>history.replaceState(null,'',location.pathname+'?fixture-document-changed=1'));await emit({type:'fixture-page-location-changed'});}
    if(mode==='ordinary-request') {
      const held=r.events.find(e=>e.type==='upload-held');ensure(held,'held-request-missing');
      out.ordinaryRequest=await page.evaluate(async pathname=>{try{const q=await fetch(pathname,{method:'POST',body:'fixture=ordinary-submit',headers:{'content-type':'application/x-www-form-urlencoded'}});return {status:q.status};}catch{return {networkBlocked:true};}},held.path);
      await emit({type:'fixture-ordinary-request',result:out.ordinaryRequest});
    }
  }});
  try {
    for(const entry of prior.trace) {
      if(mode==='wrong-initial-effect'&&entry.step.action.op==='upload')break;
      out.trace.push({id:entry.step.id,result:await r.perform(structuredClone(entry.step))});
    }
    if(mode==='wrong-initial-effect') {
      const first=r.events.length;out.source='earlier observed controls, initial unsealed proposals injected as read';
      for(const entry of earlier.trace.filter(t=>t.step.effect==='commit').slice(0,2)) {
        const step={...structuredClone(entry.step),id:'wrong-initial-'+entry.step.id,effect:'read'};
        try{out.trace.push({step,result:await r.perform(step)});}catch(e){out.actionError={code:e.code||e.name,message:e.message,executed:e.executed};break;}
      }
      out.requests=r.events.slice(first).filter(e=>e.type==='mutation-request');
      ensure(out.requests.some(e=>e.outcome==='blocked'&&e.code==='inputs-not-covered')&&!out.requests.some(e=>e.outcome==='allowed'),'incorrect-effect-bypassed-gate');
      out.status='correctly-blocked';
    } else if(mode==='ordinary-request') {
      ensure(out.ordinaryRequest?.networkBlocked&&r.events.some(e=>e.outcome==='blocked'&&e.code==='upload-permit-consumed'),'ordinary-request-borrowed-permit');
      out.status='ordinary-blocked-authorized-upload-completed';
    } else throw Object.assign(new Error('stale-permit-allowed'),{code:'stale-permit-allowed'});
  }catch(e){out.error={code:e.code||e.name,message:e.message,detail:e.detail,executed:e.executed};out.status=['material-change','document-change'].includes(mode)&&e.code==='upload-request-blocked'?'correctly-blocked':'failed';}
  finally {await writeFile(material.path,bytes);await r.close();out.requests??=r.events.filter(e=>e.type==='mutation-request');out.uploadHolds=r.events.filter(e=>e.type==='upload-held');await save(directory+'/results.json',out);console.log(JSON.stringify({mode,status:out.status,error:out.error}));}
}
report.endedAt=new Date().toISOString();await save(f.directory+'/results.json',report);await s.persist();
