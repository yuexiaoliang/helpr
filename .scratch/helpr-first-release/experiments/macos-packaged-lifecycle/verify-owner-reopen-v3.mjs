// Real packaged owner-death check. Run only after OWNER-EXIT-REPAIR approval.
// Reuses the two existing uncertain tasks; never seeds or clears business state.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {harness,root,data,wait} from './harness.mjs';

const budgetFile=path.join(root,'budget.json');
const budget=()=>JSON.parse(fs.readFileSync(budgetFile));
const approved=budget().ownerExitRepair;
assert.equal(approved?.status,'active','owner-exit revalidation not approved and activated');
assert.equal(approved?.proposal,'OWNER-EXIT-REPAIR.md');
assert.equal(budget().builds,9);assert.equal(budget().installs,7);
assert.equal(budget().faults,15,'unexpected prior fault usage');
const {log,call,result,until}=harness('owner-reopen-v3');
const app=path.join(root,'installed/helpr Lifecycle Lab.app');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readRows=file=>fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const processRows=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,lstart=,args='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/)).filter(Boolean).map(m=>({pid:Number(m[1]),parent:Number(m[2]),born:m[3],command:m[4]}));
const same=(a,b)=>a.pid===b.pid&&a.born===b.born&&a.command===b.command;
const remaining=owned=>processRows().filter(p=>owned.some(o=>same(o,p)));
function guard(){assert(Date.now()<budget().deadline,'round deadline reached');assert.equal(budget().ownerExitRepair?.status,'active');}
function countFault(reason){guard();const b=budget();assert(b.faults<b.limits.faults,'fault budget exhausted');b.faults++;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');log({kind:'fault-budget-consumed',reason,total:b.faults});}
function ownTree(pids){
  const all=processRows(),ids=new Set([pids.controller,pids.host]);
  const owner=all.find(p=>p.pid===pids.controller),host=all.find(p=>p.pid===pids.host);
  assert(owner?.command.startsWith(app+'/Contents/MacOS/'));assert(host?.command.startsWith(app+'/Contents/MacOS/'));
  assert.equal(host.parent,pids.controller);assert(host.command.includes('--lab-owner-pid='+pids.controller));
  let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);changed=true;}}
  const owned=all.filter(p=>ids.has(p.pid));assert(owned.every(p=>p.command.startsWith(app+'/Contents/')));return owned;
}
async function waitGone(owned,ms=3500){const end=Date.now()+ms;do{const alive=remaining(owned);if(!alive.length)return [];await wait(100);}while(Date.now()<end);return remaining(owned);}
async function cleanFailure(owned){
  let alive=remaining(owned);if(!alive.length)return;
  // This reserves the final fault slot for cleanup, never for a second crash trial.
  const b=budget();assert(b.faults<b.limits.faults,'cleanup reservation missing');b.faults++;
  fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');log({kind:'fault-budget-consumed',reason:'exact owned survivor cleanup',total:b.faults,processes:alive});
  for(const p of alive)try{process.kill(p.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  alive=await waitGone(owned,1500);
  if(alive.length){log({kind:'owned-cleanup-needs-force',processes:alive});for(const p of alive)try{process.kill(p.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
  assert.equal((await waitGone(owned,1500)).length,0,'owned process cleanup failed');
}
function archive(out){const dest=path.join(root,'artifacts','run-'+path.basename(out));assert(!fs.existsSync(dest),'run already archived');fs.mkdirSync(dest);for(const name of fs.readdirSync(out))if(/\.(json|jsonl|log)$/.test(name))fs.copyFileSync(path.join(out,name),path.join(dest,name));}
function start(){guard();execFileSync(process.execPath,[path.join(root,'start.mjs'),'build-9'],{stdio:'pipe',timeout:30000});}

let current,owned=[];
try{
  assert(!processRows().some(p=>p.command.startsWith(app+'/Contents/')),'experiment already running');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'artifacts/build-9/manifest.json')));
  for(const [name,expected] of Object.entries(manifest.sources))assert.equal(hash(path.join(app,'Contents/Resources/app',name)),expected,'installed source '+name);
  const launches=JSON.parse(fs.readFileSync(path.join(data,'launch-budget.json')));
  assert.equal(launches.starts,17);assert.equal(launches.limit,19);
  start();current=await until(s=>s.ready,90000);guard();
  assert(current.packaged);assert(!current.maintenance);assert(current.tasks.every(t=>t.phase==='uncertain'));
  assert.equal(current.tasks[0].intent,'running');assert.equal(current.tasks[0].counter,109);
  assert.equal(current.tasks[1].intent,'waiting');assert.equal(current.tasks[1].counter,150);
  const originalTasks=current.tasks,work=current.work;
  const site=path.join(work,'website.json'),siteEvents=path.join(work,'website-events.jsonl');
  assert.equal(JSON.parse(fs.readFileSync(site)).A.text,'手动接管测试');
  const observed=readRows(path.join(current.out,'events.jsonl')).findLast(e=>e.kind==='reopened-and-verified'&&e.task==='A');
  assert.equal(observed?.observed?.text,'手动接管测试','Chinese text was not observed in the real page');
  const originalSite=hash(site),originalEvents=hash(siteEvents);
  const pids=JSON.parse(fs.readFileSync(path.join(current.out,'pids.json')));owned=ownTree(pids);
  log({kind:'before-owner-kill',tasks:originalTasks,processes:owned,source:manifest.sources['host.cjs']});
  countFault('SIGKILL controller of build-9 with original two uncertain tasks');
  const killedAt=Date.now();process.kill(pids.controller,'SIGKILL');
  const survivors=await waitGone(owned);
  const hostEvents=readRows(path.join(current.out,'host-events.jsonl'));
  log({check:'real-owner-death-cleans-all-owned-processes',pass:survivors.length===0,elapsedMs:Date.now()-killedAt,survivors,lifecycle:hostEvents.filter(e=>e.diagnostic)});
  if(survivors.length){
    const host=survivors.find(p=>p.pid===pids.host);
    if(host){
      const raw=path.join(root,'private/owner-exit-build-9');fs.mkdirSync(raw,{recursive:true,mode:0o700});
      try{execFileSync('/usr/bin/sample',[String(host.pid),'2','10','-mayDie','-file',path.join(raw,'host-after-failure.txt')],{timeout:12000,stdio:'pipe'});log({kind:'failure-stack-captured',pid:host.pid,rawIgnored:true});}
      catch(error){log({kind:'failure-stack-error',error:error.message});}
    }
    await cleanFailure(owned);archive(current.out);current=null;throw Error('owner cleanup failed; round stops without another launch');
  }
  assert(hostEvents.some(e=>e.kind==='host-will-quit'),'will-quit marker missing');
  assert(hostEvents.some(e=>e.kind==='host-quit-complete'),'quit event not observed');
  assert(!hostEvents.some(e=>e.kind==='host-close-resource-error'),'owned resource cleanup raised an error');
  assert(!hostEvents.some(e=>e.kind==='host-waiting-for-owner-save'&&(e.parentPid!==e.ownerPid||!e.connected)),'waited for absent owner');
  assert.equal(hash(site),originalSite);assert.equal(hash(siteEvents),originalEvents);
  archive(current.out);current=null;owned=[];

  start();current=await until(s=>s.ready,90000);guard();
  owned=ownTree(JSON.parse(fs.readFileSync(path.join(current.out,'pids.json'))));
  for(let i=0;i<2;i++)for(const key of ['id','intent','phase','counter','goal'])assert.equal(current.tasks[i][key],originalTasks[i][key],key+' not retained');
  const resume=await call({kind:'continue',task:'A'});assert(!resume.ok);assert.equal(resume.error,'unknown-result-still-blocks');
  const update=await call({kind:'prepare-update',mode:'idle',to:'0.0.3'});assert(!update.ok);
  await wait(1200);assert.equal(hash(site),originalSite);assert.equal(hash(siteEvents),originalEvents);
  log({check:'reopen-preserves-two-unknowns-and-waiting-without-repeat',pass:true,tasks:current.tasks,website:JSON.parse(fs.readFileSync(site))});
  // Include replacement workers created by the continue/reconcile request.
  owned=ownTree(JSON.parse(fs.readFileSync(path.join(current.out,'pids.json'))));
  await result({kind:'quit'});assert.equal((await waitGone(owned)).length,0,'normal quit left owned processes');
  assert(!processRows().some(p=>p.command.startsWith(app+'/Contents/')),'new owned processes remained after normal quit');
  const events=readRows(path.join(current.out,'events.jsonl')),host=readRows(path.join(current.out,'host-events.jsonl'));
  const dispatchClosed=events.find(e=>e.kind==='quit-dispatch-closed'),saved=events.find(e=>e.kind==='quit-records-saved'),requested=host.find(e=>e.kind==='host-close-requested'),done=host.find(e=>e.kind==='host-quit-complete');
  assert(dispatchClosed&&saved&&requested&&done);assert(dispatchClosed.at<=saved.at&&saved.at<=requested.at&&requested.at<=done.at);
  assert.equal(hash(site),originalSite);assert.equal(hash(siteEvents),originalEvents);
  log({check:'normal-quit-still-saves-before-closing-all-owned-processes',pass:true,tasks:saved.tasks,order:{dispatchClosed:dispatchClosed.at,saved:saved.at,requested:requested.at,done:done.at}});
  archive(current.out);current=null;owned=[];
  const destination=path.join(data,'owner-exit-build-9-final');assert(!fs.existsSync(destination));fs.mkdirSync(destination);
  for(const name of ['records.sqlite','website.json','website-events.jsonl','assets'])if(fs.existsSync(path.join(work,name)))fs.cpSync(path.join(work,name),path.join(destination,name),{recursive:true});
  log({check:'closed-business-snapshot-preserved',pass:true,destination,excludes:['profile','model-sample.encrypted']});
}catch(error){
  log({pass:false,error:error.stack});process.exitCode=1;
}finally{
  // Even startup failure must not strand this experiment. Do not touch unrelated apps.
  if(current||processRows().some(p=>p.command.startsWith(app+'/Contents/'))){
    const all=processRows().filter(p=>p.command.startsWith(app+'/Contents/'));
    if(all.length){try{await call({kind:'quit'});}catch(error){log({kind:'safe-close-request-failed',error:error.message});}
      if((await waitGone(all)).length)await cleanFailure(all);}
    if(current&&!fs.existsSync(path.join(root,'artifacts','run-'+path.basename(current.out))))archive(current.out);
  }
  const b=budget();b.ownerExitRepair.status=process.exitCode?'failed-and-stopped':'passed-and-stopped';b.ownerExitRepair.finishedAt=new Date().toISOString();b.ownerExitRepair.evidence='artifacts/owner-reopen-v3.jsonl';
  b.automaticStoppedAt=b.ownerExitRepair.finishedAt;b.automaticRemainingMsAtStop=Math.max(0,b.deadline-Date.now());
  fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');
  log({kind:'round-stopped',status:b.ownerExitRepair.status,remainingInstalledProcesses:processRows().filter(p=>p.command.startsWith(app+'/Contents/'))});
}
