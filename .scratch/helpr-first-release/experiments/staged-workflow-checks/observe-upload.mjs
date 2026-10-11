import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from '../autonomous-workflow-induction/fixtures.mjs';
import {session,save,hash,ensure} from './protocol.mjs';
import {openRun,locate,bind,capture} from '../constrained-workflow-induction/runtime.mjs';
const root=path.resolve('artifacts/staged'),s=await session(root,'probe');
const prior=JSON.parse(await readFile('../constrained-workflow-induction/artifacts/run/learn-4/results.json'));
const f=await fixture(root,'observation-probe'),task=await s.parse(f,prior.task);
ensure(!task.rejected,'probe-rejected');
const r=await openRun(task,f.directory,s.meta.deadline,{holdUpload:true});
const report={startedAt:new Date().toISOString(),scope:'observe-only using unchanged rejecting runtime',task,steps:[],requests:[]},jobs=[];
let selection,target;
try {
  for(const e of prior.trace){await r.perform(structuredClone(e.step));report.steps.push(e.step.id);}
  const step=structuredClone(prior.failures.find(f=>f.step?.action.op==='upload'&&f.error.executed).step);
  target=locate(r.page,bind(step.action.target,task.inputs));
  selection=await target.evaluateHandle(el=>{
    const state={events:0,selected:null,connected:null,url:null,pending:null};
    el.addEventListener('input',()=>{
      state.events++;state.connected=el.isConnected;state.url=el.ownerDocument.URL;
      state.pending=Promise.all([...el.files].map(async file=>({name:file.name,size:file.size,type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))}))).then(files=>{state.selected=files;return files;});
    },{capture:true,once:true});return state;
  });
  r.page.on('request',req=>{
    if(!req.headers()['content-type']?.startsWith('multipart/form-data'))return;
    jobs.push((async()=>{
      const data=req.postDataBuffer()?.toString()||'';
      const fileHeaders=[...data.matchAll(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/gi)].map(m=>({field:m[1],filename:m[2]}));
      const selected=await selection.evaluate(async state=>{await state.pending;return state;});
      report.requests.push({method:req.method(),origin:new URL(req.url()).origin,path:new URL(req.url()).pathname,
        requestFrame:req.frame().name()||'main',requestFrameUrl:req.frame().url(),fileHeaders,
        reportedBodyBytes:req.postDataBuffer()?.length,selection:{events:selected.events,connectedAtEvent:selected.connected,url:selected.url,
          files:selected.selected?.map(({bytes,...rest})=>({...rest,sha256:hash(Buffer.from(bytes))}))},
        inputStillConnected:await target.count()===1,observedAt:new Date().toISOString()});
    })());
  });
  try{await r.perform(step);}catch(e){report.expectedRejection={code:e.code||e.name,message:e.message,executed:e.executed};}
  await Promise.all(jobs);
  const file=Object.values(task.inputs).find(v=>v.type==='file');
  report.source={name:file.name,sha256:file.sha256,bytes:(await readFile(file.path)).length};
  report.selectionMatches=report.requests.some(q=>q.selection.files?.length===1&&q.selection.files[0].sha256===file.sha256&&q.selection.files[0].name===file.name);
  report.requestMetadataMatches=report.requests.some(q=>q.fileHeaders.filter(h=>h.filename).length===1&&q.fileHeaders.some(h=>h.filename===file.name));
  report.status=report.selectionMatches&&report.requestMetadataMatches?'observation-supported':'observation-insufficient';
}catch(e){report.status='probe-failed';report.error={code:e.code||e.name,message:e.message,detail:e.detail};}
finally{await selection?.dispose();report.endedAt=new Date().toISOString();await r.close();await save(f.directory+'/results.json',report);await s.persist();console.log(JSON.stringify(report,null,2));}
