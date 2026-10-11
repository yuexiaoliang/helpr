import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,ensure} from './protocol.mjs';
import {openRun} from './runtime.mjs';
const root=path.resolve('artifacts/staged'),s=await session(root,'probe');
const prior=JSON.parse(await readFile(root+'/upload-probe-candidate.json'));
const f=await fixture(root,'permit-invalidations'),task=await s.parse(f,prior.task);ensure(!task.rejected,'probe-rejected');
const report={startedAt:new Date().toISOString(),task,runs:[],modelCallsDuringBrowserExecution:0};
const goal=task.goal;
for(const mode of ['task-change','completed-permit-reuse']) {
  const directory=f.directory+'/'+mode;await mkdir(directory,{recursive:true});const out={mode,status:'running'};report.runs.push(out);let permit;
  const r=await openRun(task,directory,s.meta.deadline,{holdUpload:true,onUploadHeld:async p=>{
    permit=p.permit;out.receipt=p.permit.receipt;
    if(mode==='task-change'){task.goal+=' [fixture mutation]';await p.emit({type:'fixture-task-changed'});}
  }});
  try {
    for(const entry of prior.trace)await r.perform(structuredClone(entry.step));
    if(mode==='completed-permit-reuse'){
      let stale;try{await permit.verify();}catch(e){stale=e.code||e.name;}
      ensure(stale==='upload-permit-stale','completed-permit-remained-valid');out.refusal=stale;out.status='correctly-blocked';
    }else throw Object.assign(new Error('changed-task-allowed'),{code:'changed-task-allowed'});
  }catch(e){out.error={code:e.code||e.name,message:e.message,detail:e.detail};out.status=mode==='task-change'&&e.code==='upload-request-blocked'?'correctly-blocked':'failed';}
  finally {task.goal=goal;await r.close();out.requests=r.events.filter(e=>e.type==='mutation-request');await save(directory+'/results.json',out);console.log(JSON.stringify({mode,status:out.status,error:out.error,refusal:out.refusal}));}
}
report.endedAt=new Date().toISOString();await save(f.directory+'/results.json',report);await s.persist();
