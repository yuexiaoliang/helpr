import { fork,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,mkdir,copyFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createLab,deferred,until } from './lab.mjs';
import { modelSession } from './model.mjs';
import { openRun, readStatus, atomicJSON } from './control.mjs';
import { planExperiment } from './plan.mjs';
import { historicalRegistration } from './registration.mjs';
import { collectScreenshots } from './capture.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const argumentsList=process.argv.slice(2),flags=argumentsList.filter(a=>a.startsWith('--'));
if(flags.some(f=>!['--plan','--status'].includes(f))||flags.length>1||argumentsList.filter(a=>!a.startsWith('--')).length>1)throw new Error('usage: node run.mjs [output-directory] [--plan|--status]');
const root=path.resolve(argumentsList.find(a=>!a.startsWith('--'))||directory+'/artifacts/'+new Date().toISOString().replace(/[:.]/g,'-'));
const names=['parallel-exploration','stop-waiting-click','stop-typing','queued-dispatch','queued-retry','late-old-generation','cancel-model-request','page-error','foreign-page'];
const registration=await historicalRegistration(directory),ledgerPath=directory+'/private/experiment-state.json';
if(flags.includes('--status')){
  const status=await readStatus(ledgerPath,registration);
  console.log(JSON.stringify({...status,results:status.results.map(({evidence,...r})=>r)},null,2));process.exit(0);
}
let selection;
try{selection=JSON.parse(await readFile(root+'/PLAN.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const hostFilter=process.env.HOST_FILTER||selection?.host,caseFilter=process.env.CASE_FILTER?.split(',')||selection?.cases;
if(hostFilter&&!['electron-cdp','chromium-cdp'].includes(hostFilter))throw new Error('unknown-host');
if(caseFilter&&(!Array.isArray(caseFilter)||caseFilter.some(n=>!names.includes(n))))throw new Error('unknown-case');
const selectedKinds=['electron-cdp','chromium-cdp'].filter(k=>!hostFilter||k===hostFilter);
const cases=selectedKinds.flatMap(k=>names.filter(n=>!caseFilter||caseFilter.includes(n)).map(n=>k+':'+n));
const config=JSON.parse(await readFile(directory+'/../model-api/config.example.json','utf8'));
const plan=await planExperiment({directory,ledgerPath,registration,config,cases});
if(flags.includes('--plan')){console.log(JSON.stringify({root,...plan},null,2));process.exit(0);}
if(!plan.remaining.length){console.log(JSON.stringify({root,completed:plan.completed,remaining:[]}));process.exit(0);}
if(!plan.budget.callsRemaining||!plan.budget.tokensRemaining||!plan.budget.timeRemainingMs){
  console.error(JSON.stringify({error:'experiment-budget-exhausted',budget:plan.budget,notRun:plan.remaining}));process.exit(1);
}
const casesFor=kind=>names.filter(n=>plan.remaining.includes(kind+':'+n));
const attempt=(await readdir(root+'/attempts').catch(error=>{if(error.code==='ENOENT')return [];throw error;})).length+1,out=root+'/attempts/'+String(attempt).padStart(2,'0');
const control=await openRun({ledgerPath,registration,fingerprint:plan.fingerprint,output:out});
let openHost,pageIdentity,lab,model;
const hashes={...plan.fingerprint.sourceHashes,'capture.mjs':plan.fingerprint.captureHash};
try{
  ({openHost,pageIdentity}=await import('./host.mjs'));
  await mkdir(out+'/source',{recursive:true});
  for(const file of Object.keys(hashes)){
    const target=out+'/source/'+file.replace(/^\.\.\//,'shared/');await mkdir(path.dirname(target),{recursive:true});await copyFile(directory+'/'+file,target);
  }
  lab=await createLab(out);model=await modelSession(out,lab.log,{run:control,config});
}catch(error){await lab?.close().catch(()=>{});await control.close();throw error;}
const results=[],resources=[];
const metadata={startedAt:new Date().toISOString(),attempt,pid:process.pid,sourceHashes:hashes,node:process.version,platform:os.platform(),arch:os.arch(),release:os.release(),playwright:'1.64.0',electron:'44.7.0',base:lab.base,scope:'real model + visible browser + local synthetic website; automatic fault injection, no human input'};
const save=async()=>{await lab.flush();await atomicJSON(out+'/results.json',{metadata,results,resources});};
const capture=p=>p.then(value=>({ok:true,value}),e=>({ok:false,name:e.name,error:e.message}));
async function sample(){try{const {stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=,rss=,pcpu=,comm=']);const all=stdout.trim().split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);return m&&{pid:+m[1],ppid:+m[2],rssKiB:+m[3],cpu:+m[4],command:m[5]};}).filter(Boolean);const ids=new Set([process.pid]);for(let i=0;i<8;i++)for(const p of all)if(ids.has(p.ppid))ids.add(p.pid);const group=all.filter(p=>ids.has(p.pid));resources.push({at:Date.now(),rssKiB:group.reduce((s,p)=>s+p.rssKiB,0),processes:group});}catch{}}
const sampler=setInterval(()=>sample(),1500);sampler.unref();
function rpcClient(endpoint){
  const child=fork(directory+'/worker.mjs',[],{stdio:['ignore','pipe','pipe','ipc']});let seq=0;const pending=new Map();
  child.stdout.on('data',b=>lab.log({kind:'worker-stdout',text:String(b)}));child.stderr.on('data',b=>lab.log({kind:'worker-stderr',text:String(b)}));
  child.on('message',m=>{if(m.event){lab.log(m.event);return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);if(m.error)p.reject(Object.assign(new Error(m.error.message),{name:m.error.name}));else p.resolve(m.result);});
  child.on('exit',code=>{for(const p of pending.values())p.reject(new Error('worker-exit:'+code));pending.clear();});
  const call=(method,args={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.send({id,method,...args});});
  return {call,ready:call('connect',{endpoint}),async close(){await call('close');child.disconnect();await new Promise(r=>{child.once('exit',r);setTimeout(()=>{child.kill();r();},2000).unref();});}};
}
async function newTask(rpc,scope,label,rootId,goal,inputs={},previous){
  const lease=await rpc.call('bind',{task:scope+'/'+label,execution:randomUUID(),rootId});
  return {lease,goal,inputs,active:true,abort:new AbortController(),history:[],previous};
}
async function ask(rpc,task,options){const pages=await rpc.call('observe',{lease:task.lease});return model.propose(task,pages,options);}
async function action(rpc,task,proposal,options={}){assert(task.active,'parent-execution-stopped');const result=await rpc.call('action',{lease:task.lease,action:proposal,...options});assert(task.active,'parent-discarded-result');task.history.push(proposal);return result;}
async function loop(rpc,task){for(let i=0;i<8;i++){const p=await ask(rpc,task);const r=await action(rpc,task,p);if(r.finished)return r;}throw new Error('model-step-budget');}
async function stop(rpc,task){task.active=false;lab.log({kind:'stop-request',...task.lease});task.abort.abort();const start=performance.now();await rpc.call('stop',{lease:task.lease});return performance.now()-start;}
let host,rpc;
try{
  for(const kind of selectedKinds){
    if(!casesFor(kind).length)continue;
    if(!(await readStatus(ledgerPath)).budget.callsRemaining||!(await readStatus(ledgerPath)).budget.timeRemainingMs){metadata.notRun=selectedKinds.flatMap(k=>casesFor(k).map(n=>k+':'+n));metadata.budgetExhausted=true;break;}
    host=await openHost(kind,lab.base,out);metadata[kind]={versions:host.versions,mappings:await host.mappings()};
    assert(metadata[kind].mappings.every(m=>Number.isInteger(m.tabId??m.webContentsId)),'native-target-mapping');
    rpc=rpcClient(host.endpoint);metadata[kind].worker=await rpc.ready;
    for(const name of casesFor(kind)){
      if(!(await readStatus(ledgerPath)).budget.callsRemaining||!(await readStatus(ledgerPath)).budget.timeRemainingMs){metadata.notRun=casesFor(kind).filter(n=>!results.some(r=>r.host===kind&&r.name===n));metadata.budgetExhausted=true;break;}
      const scope=kind+':'+name,caseDir=out+'/'+scope.replaceAll(':','-');await mkdir(caseDir,{recursive:true});
      const started=Date.now(),evidence={},cleanup=[];let a,b,bResult,pendingA,bPromise,stopMs,switching=true;
      lab.log({kind:'case-start',scope});
      const outcome=await control.runCase({key:scope,execute:async()=>{
        assert((await readStatus(ledgerPath)).budget.timeRemainingMs>0,'time-budget');
        for(const p of host.control.contexts().flatMap(c=>c.pages()))if(!host.pages.includes(p)&&!p.url().startsWith('data:')&&!p.url().startsWith('chrome-extension:'))await p.close();
        const configs=['A','B'].map(task=>({scope,task,token:randomUUID(),disabled:task==='A'&&['stop-waiting-click','queued-retry'].includes(name)}));
        for(const [i,p]of host.pages.entries()){
          await p.goto(lab.base+'/simple');await p.evaluate(cfg=>{sessionStorage.clear();sessionStorage.setItem('lab',JSON.stringify(cfg));},configs[i]);
          await p.goto(lab.base+(name==='parallel-exploration'?'/start':'/simple'));
        }
        const ids=await Promise.all(host.pages.map(pageIdentity));assert.equal(host.pages[0].url(),host.pages[1].url());assert.notEqual(ids[0].targetId,ids[1].targetId);evidence.initialTargets=ids;
        const basic='点击“执行一次”且只执行一次，等页面显示操作已完成后结束，并在回复里说明本页任务字母。';
        a=await newTask(rpc,scope,'A',ids[0].targetId,basic);
        b=await newTask(rpc,scope,'B',ids[1].targetId,basic);
        const switchLoop=(async()=>{let n=0;while(switching){await host.show(n++%2?'A':'B');lab.log({kind:'view-switched',scope,to:n%2?'B':'A'});await delay(600);}})();
        evidence.switchLoop=capture(switchLoop);
        if(name==='parallel-exploration'){
          for(const [label,t]of [['A',a],['B',b]]){t.inputs={title:'标题-'+label+'-'+configs[label==='A'?0:1].token.slice(0,8),detail:'说明-'+label+'-'+configs[label==='A'?0:1].token.slice(-8)};t.goal='创建一条记录，记录标题使用 title，补充说明使用 detail，保存成功后结束并回复这两项内容。';lab.hold(scope,label,'/record');}
          const both=await Promise.allSettled([loop(rpc,a),loop(rpc,b)]);assert(both.every(r=>r.status==='fulfilled'),JSON.stringify(both));
          evidence.replies=both.map(r=>r.value.reply);
          const committed=lab.records.filter(r=>r.scope===scope);assert.equal(committed.length,2);
          for(const [label,t]of [['A',a],['B',b]]){const r=committed.find(r=>r.task===label);assert.equal(r.title,t.inputs.title);assert.equal(r.detail,t.inputs.detail);const reply=evidence.replies[label==='A'?0:1];assert(reply.includes(t.inputs.title)&&reply.includes(t.inputs.detail));}
          evidence.overlap=lab.events.filter(e=>e.scope===scope&&e.kind==='server-accepted'&&e.active.length===2);assert(evidence.overlap.length>0,'no-server-overlap');
          evidence.popups=lab.events.filter(e=>e.kind==='popup-bound'&&[a.lease.task,b.lease.task].includes(e.task));assert.equal(evidence.popups.length,2);
          const popupPages=host.control.contexts().flatMap(c=>c.pages()).filter(p=>p.url().includes('/result'));
          evidence.finalTargets=await Promise.all(popupPages.map(pageIdentity));evidence.popupMappings=await host.mappings(evidence.finalTargets);assert(evidence.popupMappings.every(m=>Number.isInteger(m.tabId??m.webContentsId)));
          for(const p of evidence.popups)assert(evidence.finalTargets.some(t=>t.targetId===p.pageId&&t.openerId===p.openerId),'navigation-lost-target');
        }else{
          const bGate=lab.hold(scope,'B','/count');bPromise=capture(loop(rpc,b));
          const one=()=>ask(rpc,a,{operations:['click']});
          if(name==='cancel-model-request'){
            const pages=await rpc.call('observe',{lease:a.lease});pendingA=capture(model.propose(a,pages,{operations:['click']}));
            await until(()=>lab.events.some(e=>e.kind==='model-start'&&e.task===a.lease.task));await delay(80);stopMs=await stop(rpc,a);bGate.resolve();
            evidence.a=await pendingA;assert(!evidence.a.ok&&evidence.a.error==='client-aborted','model-not-cancelled');
          }else if(name==='late-old-generation'){
            const gate=deferred(),received=deferred();cleanup.push(()=>gate.resolve());let oldProposal;
            pendingA=capture(ask(rpc,a,{operations:['click'],cancel:false,afterAnswer:async p=>{oldProposal=p;received.resolve();await gate.promise;}}));
            await Promise.race([received.promise,pendingA.then(r=>{if(!r.ok)throw new Error(r.error);})]);const old=a;stopMs=await stop(rpc,a);bGate.resolve();
            a=await newTask(rpc,scope,'A',ids[0].targetId,basic,{},old.lease);const fresh=await loop(rpc,a);evidence.newReply=fresh.reply;
            gate.resolve();evidence.parentLate=await pendingA;assert(!evidence.parentLate.ok&&evidence.parentLate.error==='parent-rejected-late-reply');
            evidence.workerLate=await capture(rpc.call('action',{lease:old.lease,action:oldProposal}));assert(!evidence.workerLate.ok&&evidence.workerLate.error==='stale-execution');
            evidence.oldLease=old.lease;evidence.newLease=a.lease;assert.equal(a.lease.generation,old.lease.generation+1);
          }else if(name==='stop-typing'){
            a.inputs={text:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'};a.goal='在“逐字输入”中逐字输入 text，使用 type 原语。';const p=await ask(rpc,a,{operations:['type']});
            pendingA=capture(action(rpc,a,p,{typeDelay:70}));await until(()=>lab.events.some(e=>e.scope===scope&&e.task==='A'&&e.kind==='page-input'&&e.value.length>=3));
            stopMs=await stop(rpc,a);evidence.a=await pendingA;bGate.resolve();evidence.atSettlement=await host.pages[0].locator('#typing').inputValue();assert(evidence.atSettlement.length>=3&&evidence.atSettlement.length<a.inputs.text.length);
          }else{
            const proposal=await one();evidence.proposal=proposal;
            if(name==='foreign-page'){
              evidence.a=await capture(rpc.call('action',{lease:a.lease,action:{...proposal,pageId:ids[1].targetId}}));assert(!evidence.a.ok&&evidence.a.error==='foreign-page');bGate.resolve();
            }else if(name==='page-error'){
              await host.pages[0].locator('#late').evaluate(el=>el.remove());evidence.a=await capture(action(rpc,a,proposal,{timeout:500}));assert(!evidence.a.ok&&evidence.a.name==='TimeoutError');bGate.resolve();
            }else{
              const options=name==='queued-dispatch'?{queueGate:scope}:name==='queued-retry'?{retryGate:scope,timeout:180}:{};
              pendingA=capture(action(rpc,a,proposal,options));
              const waiting=name==='queued-dispatch'?'dispatch-queued':name==='queued-retry'?'retry-queued':'primitive-start';
              await until(()=>lab.events.some(e=>e.kind===waiting&&e.task===a.lease.task&&(waiting!=='primitive-start'||e.operation==='click')));
              stopMs=await stop(rpc,a);
              if(['stop-waiting-click','queued-retry'].includes(name))await host.pages[0].evaluate(()=>window.lab.enable());
              if(name.startsWith('queued-'))await rpc.call('release',{gate:scope});bGate.resolve();evidence.a=await pendingA;assert(!evidence.a.ok,'old-action-not-rejected');
            }
          }
          bResult=await bPromise;assert(bResult.ok,JSON.stringify(bResult));evidence.bReply=bResult.value.reply;assert.match(evidence.bReply,/B/);
          const records=lab.records.filter(r=>r.scope===scope);assert.equal(records.filter(r=>r.task==='B').length,1,'B-result-count');assert.equal(records.filter(r=>r.task==='A').length,name==='late-old-generation'?1:0,'unexpected-A-write');
          if(name==='stop-typing'){await delay(250);evidence.afterB=await host.pages[0].locator('#typing').inputValue();assert.equal(evidence.afterB,evidence.atSettlement);}
          evidence.stopAcknowledgedMs=stopMs;
        }
        switching=false;await evidence.switchLoop;delete evidence.switchLoop;
        const leases=[a.lease,b.lease];evidence.observations=await Promise.all(leases.map(lease=>capture(rpc.call('observe',{lease}))));
        evidence.serverResults=lab.records.filter(r=>r.scope===scope);
        const scopeEvents=lab.events.filter(e=>e.scope===scope||e.task?.startsWith(scope+'/')||e.lease?.task?.startsWith(scope+'/'));
        for(const e of scopeEvents.filter(e=>e.kind==='stop')){
          assert(!scopeEvents.some(l=>l.kind==='primitive-start'&&l.task===e.task&&l.generation===e.generation&&l.seq>e.seq),'dispatch-after-stop');
        }
        evidence.viewSwitches=scopeEvents.filter(e=>e.kind==='view-switched').length;
        return evidence;
      },capture:()=>collectScreenshots(host,name,caseDir),cleanup:async()=>{
        switching=false;for(const f of cleanup)f();lab.releaseAll();await rpc.call('release',{gate:scope});
        for(const t of [a,b])if(t?.active)await stop(rpc,t);
        await Promise.allSettled([pendingA,bPromise].filter(Boolean));
      }});
      results.push({host:kind,name,status:outcome.status,started,ended:Date.now(),error:outcome.error,
        evidence:{...outcome.evidence,screenshots:outcome.capture.evidence},capture:outcome.capture,cleanup:outcome.cleanup});
      console.log(outcome.status.toUpperCase()+' '+scope);await save();
      if(outcome.cleanup?.status==='failed')throw new Error('case-cleanup-failed:'+outcome.cleanup.error);
    }
    await rpc.close();rpc=undefined;await host.close();host=undefined;
  }
}catch(e){metadata.fatal=e.message;console.error(e);process.exitCode=1;}
finally{
  clearInterval(sampler);lab.releaseAll();
  try{await rpc?.close().catch(()=>{});await host?.close().catch(()=>{});metadata.endedAt=new Date().toISOString();await sample();await save();}
  finally{try{await lab.close();}finally{await control.close();}}
  console.log(JSON.stringify({root,out,cases:results.length,failures:results.filter(r=>r.status!=='passed').map(r=>r.host+':'+r.name),budget:(await readStatus(ledgerPath)).budget}));
  if(results.some(r=>r.status!=='passed'))process.exitCode=1;
}
