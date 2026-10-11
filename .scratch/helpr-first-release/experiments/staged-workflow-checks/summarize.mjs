import {readFile,readdir} from 'node:fs/promises';
import {save,hash} from './protocol.mjs';
const root='artifacts/staged',load=async f=>JSON.parse(await readFile(f));
const meta=await load(root+'/meta.json');
const phases=Object.fromEntries(Object.keys(meta.limits.phases).map(phase=>{
  const calls=meta.calls.filter(c=>c.phase===phase);return [phase,{calls:calls.length,tokens:calls.reduce((s,c)=>s+(c.usage?.total_tokens||0),0),inputUnderstandingCalls:calls.filter(c=>c.label.startsWith('parse-')).length}];
}));
const cases=[];
const modelInputs=[];
for(const name of await readdir(root+'/model'))if(name.endsWith('-input.json'))modelInputs.push({name,value:JSON.parse((await load(root+'/model/'+name)).messages[1].content)});
for(const entry of await readdir(root,{withFileTypes:true})) {
  if(!entry.isDirectory()||entry.name.startsWith('source'))continue;
  let result;try{result=await load(root+'/'+entry.name+'/results.json');}catch{continue;}
  const entries=result.runs||[result];
  for(const r of entries)cases.push({file:entry.name+(result.runs?'/'+r.mode:'')+'/results.json',name:r.name||r.mode||entry.name,status:r.status,error:r.error,
    browserModelCalls:r.name?.startsWith('upload-probe-')?modelInputs.filter(q=>q.name.includes('probe-artifact')&&q.value.file?.path.includes('/'+r.name+'/')).length:(r.modelCallsDuringBrowserReplay??r.modelCallsDuringBrowserExecution??result.modelCallsDuringBrowserExecution),
    steps:r.trace?.length,url:r.result?.url,independentlyVerified:r.result?.independent?.verified,fileHash:r.result?.independent?.sha256,
    exactBytesMatch:r.result?.independent?.exactBytesMatch,uploadPending:r.trace?.find(q=>q.step?.action.op==='upload'||q.op==='upload')?.result?.negative||r.trace?.find(q=>q.op==='upload')?.negative,
    effectProbe:r.effectProbe});
}
const optional=async name=>{try{return await load(root+'/'+name);}catch{return null;}};
const frozen=await optional('frozen-candidate.json'),candidate=await optional('candidate.json');
const index={generatedAt:new Date().toISOString(),startedAt:meta.startedAt,finishedAt:meta.finishedAt,elapsedMs:meta.elapsedMs,deadline:new Date(meta.deadline).toISOString(),limits:meta.limits,
  calls:meta.calls.length,tokens:meta.calls.reduce((s,c)=>s+(c.usage?.total_tokens||0),0),phases,formatRevisions:meta.revisions,protocolRevisions:meta.protocolRevisions,
  cases,candidate:candidate&&{steps:candidate.steps.length,seal:candidate.seal,createdAt:candidate.createdAt,source:candidate.source},
  frozen:frozen&&{hash:hash(frozen),validatedAt:frozen.validatedAt,source:frozen.validationEvidence},
  generation:await optional('heldout-generation.json'),positionCalibration:await optional('result-position-calibration.json'),sealedTamper:await optional('sealed-tamper.json'),protocolNegatives:await optional('protocol-negatives.json')};
await save('evidence-index.json',index);console.log(JSON.stringify(index,null,2));
