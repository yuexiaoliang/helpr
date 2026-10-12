import fs from 'node:fs';import path from 'node:path';import {fork,spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {setTimeout as delay} from 'node:timers/promises';
import {here,load,save,ensure,reserve,sources,hash,assertFrozen,log,candidateFiles} from './common.mjs';import {openProxy} from './proxy.mjs';
const [mode,taskId='L',stopAt='',intent]=process.argv.slice(2);
if(mode==='freeze'){ensure(!fs.existsSync(path.join(here,'freeze.json')),'already-frozen');const dependencies=Object.fromEntries(['../staged-workflow-checks/runtime.mjs','../staged-workflow-checks/protocol.mjs','../staged-workflow-checks/upload-permit.mjs','../workflow-reliability/executor.mjs','../workflow-reliability/contract.mjs','../runtime-flow-replay/engine.mjs','../autonomous-workflow-induction/runtime.mjs','../model-api/client.mjs','../visible-page-control/node_modules/playwright/package.json','../visible-page-control/node_modules/electron/package.json'].map(p=>[p,hash(fs.readFileSync(path.join(here,p)))]));save(path.join(here,'freeze.json'),{at:new Date().toISOString(),sources:sources(),dependencies,rulesHash:hash(load(path.join(here,'rules.json')))});console.log('Frozen source and learned rules.');process.exit(0);}
if(mode==='inspect'){
 const db=new DatabaseSync(path.join(here,'artifacts/state.sqlite'),{readOnly:true});const rows=db.prepare('SELECT id,record FROM tasks').all().map(x=>{const r=JSON.parse(x.record);return {id:x.id,phase:r.phase,intent:r.intent,editorUrl:r.editorUrl,artifacts:r.artifacts.length,lastOutcome:r.lastOutcome?.decision};});db.close();console.log(JSON.stringify({rows,ledger:load(path.join(here,'ledger.json')).counts}));process.exit(0);
}
if(mode==='intent'){
 const db=new DatabaseSync(path.join(here,'artifacts/state.sqlite'));const r=JSON.parse(db.prepare('SELECT record FROM tasks WHERE id=?').get(taskId).record);ensure(['running','stopped','takeover','waiting','unknown-input'].includes(stopAt),'intent-value');r.intent=stopAt;r.controlGeneration++;r.revision++;db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(r),taskId);db.close();fs.appendFileSync(path.join(here,'artifacts/intent-fixtures.jsonl'),JSON.stringify({at:Date.now(),taskId,intent:stopAt,source:'explicit-test-fixture-not-human'})+'\n');console.log('Intent fixture recorded.');process.exit(0);
}
if(mode==='init'){
 fs.mkdirSync(path.join(here,'artifacts/init'),{recursive:true});const r=spawnSync(process.execPath,[path.join(here,'controller.mjs'),path.join(here,'artifacts/init'),'init'],{encoding:'utf8'});console.log(r.stdout);if(r.status)console.error(r.stderr);process.exit(r.status||0);
}
if(!['learn','diagnostic'].includes(mode))assertFrozen();
if(['learn','prepare'].includes(mode))reserve('preparation',{taskId,mode});
if(['recover','resume','intents'].includes(mode)){const calls=mode==='intents'?5:1;for(let i=0;i<calls;i++)reserve('recovery',{taskId,mode});}
const n=reserve('starts',{taskId,mode,stopAt}),out=path.join(here,'artifacts',String(n).padStart(2,'0')+'-'+taskId+'-'+mode);fs.mkdirSync(out,{recursive:true});save(path.join(out,'sources.json'),sources());
fs.mkdirSync(path.join(out,'source'),{recursive:true});for(const f of candidateFiles)fs.copyFileSync(path.join(here,f),path.join(out,'source',f));
for(const f of ['run.mjs','proxy.mjs','diagnostic.mjs','diagnostic-worker.mjs','diagnostic-controller.mjs'])fs.copyFileSync(path.join(here,f),path.join(out,'source',f));
const task=load(path.join(here,'tasks.json')).find(t=>t.id===taskId);ensure(task,'task-not-found');let child,hostPid,workerPid,killed=false;
const kill=reason=>{if(killed)return;killed=true;log(out,{kind:'fixture-SIGKILL-owner',reason,pid:child.pid});child.kill('SIGKILL');};
const proxy=await openProxy({origin:task.origin,out,readonly:['recover','guards','negative','intents','diagnostic'].includes(mode),loseReceipt:stopAt==='response-lost',onHeld:()=>kill('website-accepted-receipt-withheld')});
child=fork(path.join(here,mode==='diagnostic'?'diagnostic-controller.mjs':'controller.mjs'),[out,taskId,proxy.url],{stdio:['ignore','pipe','pipe','ipc']});child.stdout.pipe(fs.createWriteStream(path.join(out,'controller.stdout.log')));child.stderr.pipe(fs.createWriteStream(path.join(out,'controller.stderr.log')));
let result,failed;
await new Promise(resolve=>{
  const timer=setTimeout(()=>{failed={message:'session-timeout'};kill('session-timeout');},8*60000);
  child.on('message',m=>{
    if(m.ready){hostPid=m.hostPid;workerPid=m.workerPid;save(path.join(out,'processes.json'),m);let probeIdentityUrl;if(mode==='guards'){const db=new DatabaseSync(path.join(here,'artifacts/state.sqlite'),{readOnly:true});probeIdentityUrl=db.prepare('SELECT record FROM tasks WHERE id!=?').all(taskId).map(x=>JSON.parse(x.record)).find(r=>r.editorUrl)?.editorUrl;db.close();}child.send({job:{mode,stopAt,...(probeIdentityUrl?{probeIdentityUrl}: {})}});}
    if(m.checkpoint){save(path.join(out,'interruption.json'),{phase:m.checkpoint,source:'explicit-fault-fixture'});kill(m.checkpoint);}
    if(m.result){result=m.result;save(path.join(out,'result.json'),result);child.send({inspect:true});child.send({close:true});}
    if(m.failure){failed=m.failure;save(path.join(out,'failure-report.json'),failed);child.send({inspect:true});child.send({close:true});}
  });child.on('exit',(code,signal)=>{clearTimeout(timer);save(path.join(out,'exit.json'),{code,signal});resolve();});
});
await delay(1500);const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const remaining=[hostPid,workerPid].filter(p=>p&&alive(p));for(const pid of remaining){log(out,{kind:'fixture-cleanup',pid});try{process.kill(pid,'SIGTERM');}catch{}}
await proxy.close();await delay(500);save(path.join(out,'cleanup.json'),{initiallyRemaining:remaining,remaining:[hostPid,workerPid].filter(p=>p&&alive(p))});
console.log(JSON.stringify({out,result,failure:failed,killed,counts:load(path.join(here,'ledger.json')).counts}));if(failed)process.exitCode=1;
