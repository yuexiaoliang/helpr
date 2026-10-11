// 独立复查保存的事实；不打开浏览器或调用模型。
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=path.dirname(fileURLToPath(import.meta.url)),read=async f=>JSON.parse(await readFile(f,'utf8'));
const studies=['artifacts/2026-10-11T03-38-56-107Z','artifacts/chromium-missing-cases'];
const cases=['parallel-exploration','stop-waiting-click','stop-typing','queued-dispatch','queued-retry','late-old-generation','cancel-model-request','page-error','foreign-page'];
const historicalProtocol={
  "worker.mjs": "8cd966213ba05077f8439466b70487a1fa6bb7d3976b43d2370d3986c5b0dc04",
  "model.mjs": "331b96149ee0bd6bbe8dae81800163270e9d091c5d9a2b8fba3460322e9c11d8",
  "lab.mjs": "c11ad62ebb7d2556c1ae22d325793675ecb210251df0a1916fcbc2b6fc08d79e",
  "electron.cjs": "73c9ac59fa2aec11cb400bf27ebce735c344b9b6bb891b4af301d9fd95091dae"
};
const attempts=[],budgets=[],byCase=new Map(),failures=[];let primitiveCount=0,observations=0,modelInputs=0;
const inputs=new Map(),allCalls=[];
for(const study of studies){
  const meta=await read(base+'/'+study+'/model-meta.json');
  const usage=meta.calls.reduce((s,c)=>s+(c.usage?.total_tokens||0),0);
  assert(meta.calls.length<=meta.limits.calls);assert(usage<=meta.limits.tokens);assert(meta.calls.every(c=>Date.parse(c.startedAt)<meta.deadline));
  const models=await readdir(base+'/'+study+'/model');
  for(const f of models.filter(f=>f.endsWith('-input.json'))){
    const input=await read(base+'/'+study+'/model/'+f);const user=JSON.parse(input.messages.find(m=>m.role==='user').content);
    assert.deepEqual(input.schema.properties.pageId.enum,user.pages.map(p=>p.pageId));
    inputs.set(study+'/'+f,{...input,user});modelInputs++;
  }
  allCalls.push(...meta.calls.map(c=>({...c,study})));
  budgets.push({study,startedAt:meta.startedAt,lastRequestEndedAt:meta.calls.map(c=>c.endedAt).filter(Boolean).sort().at(-1),limits:meta.limits,calls:meta.calls.length,knownTokens:usage,missingUsage:meta.calls.filter(c=>!c.usage).map(c=>c.label),errors:meta.calls.filter(c=>c.error).map(c=>({label:c.label,error:c.error}))});
  for(const folder of (await readdir(base+'/'+study+'/attempts')).sort()){
    const dir=study+'/attempts/'+folder,data=await read(base+'/'+dir+'/results.json');
    const events=(await readFile(base+'/'+dir+'/events.jsonl','utf8')).trim().split('\n').map(l=>JSON.parse(l));
    const owners=new Map(),stopped=new Set();
    for(const e of events){
      if(e.kind==='execution-bound')owners.set(e.execution,new Set([e.pageId]));
      if(e.kind==='popup-bound'){assert(owners.get(e.execution)?.has(e.openerId));owners.get(e.execution).add(e.pageId);}
      if(e.kind==='stop')stopped.add(e.execution+':'+e.generation);
      if(e.kind==='primitive-start'){
        assert(owners.get(e.execution)?.has(e.pageId),'primitive targets another execution page');
        assert(!stopped.has(e.execution+':'+e.generation),'primitive after execution stop');primitiveCount++;
      }
      if(e.kind==='observation'){assert(e.pages.every(p=>owners.get(e.execution)?.has(p.pageId)));observations++;}
    }
    for(const input of inputs.values()){
      const owned=owners.get(input.lease.execution);if(!owned)continue;
      assert(input.user.pages.every(p=>owned.has(p.pageId)),'model saw another execution page');
    }
    for(const file of ['worker.mjs','model.mjs','lab.mjs','electron.cjs']){
      const expected=historicalProtocol[file];
      assert.equal(expected,data.metadata.sourceHashes[file],'historical protocol hash changed');
      assert.equal(expected,createHash('sha256').update(await readFile(base+'/'+dir+'/source/'+file)).digest('hex'));
    }
    const attempt={dir,metadata:data.metadata,results:data.results,events,resources:data.resources};attempts.push(attempt);
    for(const r of data.results){
      if(r.status==='passed')byCase.set(r.host+':'+r.name,{...r,dir,attempt});
      else failures.push({dir,host:r.host,name:r.name,error:r.error});
    }
  }
}
const selected=[];
for(const host of ['electron-cdp','chromium-cdp'])for(const name of cases){
  const r=byCase.get(host+':'+name);assert(r,'missing verified case '+host+':'+name);
  const e=r.evidence,scope=host+':'+name,events=r.attempt.events;
  assert.equal(e.initialTargets[0].url,e.initialTargets[1].url);assert.notEqual(e.initialTargets[0].targetId,e.initialTargets[1].targetId);
  assert(e.viewSwitches>=1);
  const controls=events.filter(x=>x.task?.startsWith(scope+'/'));
  const stop=controls.find(x=>x.kind==='stop'&&x.task===scope+'/A');
  const committed=events.filter(x=>x.kind==='server-committed'&&x.record.scope===scope).map(x=>({seq:x.seq,...x.record}));
  assert.equal(committed.filter(x=>x.task==='B').length,1);
  assert.equal(committed.filter(x=>x.task==='A').length,['parallel-exploration','late-old-generation'].includes(name)?1:0);
  if(Number.isFinite(e.stopAcknowledgedMs)){assert(stop);assert(committed.find(x=>x.task==='B').seq>stop.seq,'B did not complete after A stopped');}
  if(['page-error','foreign-page'].includes(name)){
    const rejection=events.find(x=>x.kind==='rpc-error'&&x.lease?.task===scope+'/A'&&x.method==='action');
    assert(rejection&&committed.find(x=>x.task==='B').seq>rejection.seq,'B did not complete after A error');
  }
  const facts={sameUrl:true,viewSwitches:e.viewSwitches,records:committed.map(({seq,id,route,task,title,detail})=>({seq,id,route,task,title,detail})),stopAcknowledgedMs:e.stopAcknowledgedMs};
  if(name==='parallel-exploration'){
    assert.equal(e.popups.length,2);assert(e.popupMappings.every(x=>Number.isInteger(x.tabId??x.webContentsId)));
    for(const p of e.popups)assert(e.finalTargets.some(t=>t.targetId===p.pageId&&t.openerId===p.openerId));
    const accepted=events.filter(x=>x.kind==='server-accepted'&&x.scope===scope&&x.active.length===2);assert(accepted.length>0);
    const executionIds=controls.filter(x=>x.kind==='execution-bound').map(x=>x.execution);
    const requests=[...inputs.values()].filter(i=>executionIds.includes(i.lease.execution));
    for(const task of ['A','B']){
      const input=requests.find(i=>i.lease.task===scope+'/'+task),record=committed.find(x=>x.task===task);
      assert.equal(record.title,input.user.inputs.title);assert.equal(record.detail,input.user.inputs.detail);
      const reply=e.replies[task==='A'?0:1];assert(reply.includes(record.title)&&reply.includes(record.detail));
    }
    const callIds=controls.filter(x=>x.kind==='model-start').map(x=>x.call);
    const calls=allCalls.filter(c=>c.study===r.dir.split('/attempts/')[0]&&callIds.includes(Number(c.label.split(':')[0])));
    const overlap=[];
    for(const a of calls.filter(c=>c.label.endsWith('/A')))for(const b of calls.filter(c=>c.label.endsWith('/B'))){
      const ms=Math.min(Date.parse(a.endedAt),Date.parse(b.endedAt))-Math.max(Date.parse(a.startedAt),Date.parse(b.startedAt));if(ms>0)overlap.push({a:a.label,b:b.label,ms});
    }
    assert(overlap.length>0,'models never overlapped');facts.modelOverlap=overlap;facts.serverOverlap=accepted.map(x=>({seq:x.seq,active:x.active}));facts.popups=e.popups;facts.replies=e.replies;
  }
  if(name==='stop-typing'){assert.equal(e.atSettlement,e.afterB);assert(e.afterB.length>0&&e.afterB.length<52);facts.remainingText=e.afterB;}
  if(name==='late-old-generation'){assert(!e.parentLate.ok&&!e.workerLate.ok);assert.equal(e.newLease.generation,e.oldLease.generation+1);facts.parentLate=e.parentLate;facts.workerLate=e.workerLate;}
  if(name==='foreign-page')assert.equal(e.a.error,'foreign-page');
  if(name==='page-error')assert.equal(e.a.name,'TimeoutError');
  if(name==='cancel-model-request')assert.equal(e.a.error,'client-aborted');
  facts.events=controls.filter(x=>['stop','stop-ack','dispatch-queued','retry-queued','rejected-identity','rejected-stale-work','rejected-page-owner'].includes(x.kind)).map(({seq,kind,task,generation,operation})=>({seq,kind,task,generation,operation}));
  selected.push({host,name,status:r.status,source:r.dir+'/results.json',events:r.dir+'/events.jsonl',facts});
}
const resources=attempts.flatMap(a=>a.resources.map(r=>({...r,dir:a.dir})));
const peak=resources.reduce((a,b)=>b.rssKiB>a.rssKiB?b:a);
const screenshotCount=(await Promise.all(attempts.map(async a=>{let n=0;for(const item of await readdir(base+'/'+a.dir,{withFileTypes:true}))if(item.isDirectory()&&item.name!=='profiles'&&item.name!=='source')n+=(await readdir(base+'/'+a.dir+'/'+item.name)).filter(f=>f.endsWith('.png')).length;return n;}))).reduce((a,b)=>a+b,0);
const plans=[];
for(const study of studies){const before=await readFile(base+'/'+study+'/model-meta.json');const {stdout}=await promisify(execFile)(process.execPath,[base+'/run.mjs',base+'/'+study,'--plan']);const after=await readFile(base+'/'+study+'/model-meta.json');assert(before.equals(after),'plan mutated model records');plans.push(JSON.parse(stdout));}
assert.equal(plans[0].remaining.length,18);assert.equal(plans[1].remaining.length,5);
for(const plan of plans){assert.equal(plan.budget.calls,113);assert.equal(plan.budget.callsRemaining,0);assert.equal(plan.completed.length,0);}
const output={verifiedAt:new Date().toISOString(),uniqueCases:selected.length,passed:selected.length,primitiveCount,observations,modelInputs,screenshotCount,budgets,totalCalls:budgets.reduce((s,b)=>s+b.calls,0),knownTokens:budgets.reduce((s,b)=>s+b.knownTokens,0),missingUsageCalls:budgets.reduce((s,b)=>s+b.missingUsage.length,0),failures,resources:{samples:resources.length,peakRssMiB:peak.rssKiB/1024,peakAt:peak.at,peakAttempt:peak.dir,interpretation:'1.5-second samples of runner process tree RSS; sums shared pages and includes driver/host/worker/renderers, not a product or steady-state memory estimate'},checks:{pageOwnership:true,stoppedGenerationFenced:true,modelPageIsolation:true,realModelOverlapBothHosts:true,realServerOverlapBothHosts:true,independentBResults:true,sameExecutionProtocolAcrossStudies:true,resumePlanReadOnly:true,historicalResultsNotReusedByCurrentDriver:true},selected};
if(!process.argv.includes('--check'))await writeFile(base+'/evidence-index.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({uniqueCases:output.uniqueCases,passed:output.passed,primitiveCount,observations,modelInputs,screenshotCount,totalCalls:output.totalCalls,knownTokens:output.knownTokens,missingUsageCalls:output.missingUsageCalls,peakRssMiB:output.resources.peakRssMiB,checks:output.checks},null,2));
