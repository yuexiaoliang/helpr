import {readFile,writeFile,access} from 'node:fs/promises';
const root='artifacts/run',load=file=>readFile(root+'/'+file,'utf8').then(JSON.parse);
const meta=await load('meta.json'),diagnostic=await load('diagnostic-calibration/results.json');
const runs=[];
for(const name of ['learn','learn-2','learn-3','learn-4']) {
  const r=await load(name+'/results.json');runs.push({name,status:r.status,completedSteps:r.trace.length,error:r.error,
    failures:r.failures.map(f=>({op:f.proposal?.op,code:f.error.code,executed:f.error.executed})),source:r.reusedSource,
    evidence:name+'/results.json'});
}
const events=(await readFile(root+'/diagnostic-calibration/events.jsonl','utf8')).trim().split('\n').map(JSON.parse);
const marker=events.findIndex(e=>e.type==='dispatch'&&e.step==='wrong-effect-s9');
const wrongEffectRequests=events.slice(marker).filter(e=>e.type==='mutation-request'&&e.effectProposal==='read'&&e.operation==='click');
const phases=Object.fromEntries(['learn','calibrate','evaluate'].map(p=>{const c=meta.calls.filter(c=>c.phase===p);return[p,{requests:c.length,tokens:c.reduce((n,r)=>n+(r.usage?.total_tokens||0),0)}];}));
const summary={outcome:'complete-workflow-not-established',limits:meta.limits,startedAt:meta.startedAt,
  stoppedAfter:diagnostic.endedAt,stopReason:'three-protocol-revisions-used; current upload-authorization assumption falsified; remaining model budget not repurposed',
  requests:meta.calls.length,tokens:meta.calls.reduce((n,c)=>n+(c.usage?.total_tokens||0),0),unknownUsageRequests:meta.calls.filter(c=>!c.usage).length,
  protocolRevisions:meta.protocolRevisions,formatRepairs:meta.revisions,phases,runs,
  partialCalibration:{...diagnostic.partialPrefix,modelCallsDuringBrowserExecution:0,evidence:'diagnostic-calibration/results.json'},
  uploadObservation:{sourceBytes:diagnostic.sourceFileBytes,multipart:diagnostic.uploadRequests.filter(q=>q.contentType?.startsWith('multipart/')),authorizedUploadCompleted:false},
  wrongEffect:{requests:wrongEffectRequests,passed:wrongEffectRequests.length>0&&wrongEffectRequests.every(r=>r.outcome==='blocked'),evidence:'diagnostic-calibration/events.jsonl'},
  schemaNegatives:diagnostic.protocolNegatives,
  notExecuted:['complete candidate validation','pending-versus-completed upload condition','successful public publication','independent download byte comparison','heldout materials and text','near-intent applicability negatives','full constant-collision case','changed-control case'],
};
for(const file of ['candidate.json','frozen-candidate.json']) {try{await access(root+'/'+file);summary[file]='exists';}catch{summary[file]='absent';}}
await writeFile(root+'/evidence-index.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({outcome:summary.outcome,requests:summary.requests,tokens:summary.tokens,phases,wrongEffect:summary.wrongEffect.passed,partial:summary.partialCalibration.passed},null,2));
