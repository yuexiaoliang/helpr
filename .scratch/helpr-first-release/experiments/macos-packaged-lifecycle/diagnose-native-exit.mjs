// One original-build reproduction; collect native stacks before cleaning survivors.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {harness,root,data,wait} from './harness.mjs';
const exec=promisify(execFile),budgetFile=path.join(root,'budget.json');
const budget=()=>JSON.parse(fs.readFileSync(budgetFile));
assert.equal(budget().nativeExitDiagnosis?.status,'active');
assert.equal(budget().faults,14);
const {log,call,result,until}=harness('native-exit-diagnosis');
const app=path.join(root,'installed/helpr Lifecycle Lab.app'),raw=path.join(root,'private/native-exit');
assert(!fs.existsSync(raw));fs.mkdirSync(raw,{recursive:true,mode:0o700});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const processes=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,lstart=,state=,args='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:Number(m[1]),parent:Number(m[2]),born:m[3],state:m[4],command:m[5]}));
const same=(a,b)=>a.pid===b.pid&&a.born===b.born&&a.command===b.command;
const remaining=owned=>processes().filter(p=>owned.some(o=>same(o,p)));
function consume(reason){const b=budget();assert(b.faults<16);b.faults++;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');log({kind:'fault-budget-consumed',total:b.faults,reason});}
function collectOwned(pids){
  const all=processes(),ids=new Set([pids.controller,pids.host]);
  for(const pid of ids)assert(all.find(p=>p.pid===pid)?.command.startsWith(app+'/Contents/MacOS/'));
  let added=true;while(added){added=false;for(const p of all)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);added=true;}}
  const owned=all.filter(p=>ids.has(p.pid));assert(owned.every(p=>p.command.startsWith(app+'/Contents/')));return owned;
}
async function sample(target,label){
  if(!remaining([target]).length){log({kind:'sample-skipped-process-exited',label,pid:target.pid});return;}
  const file=path.join(raw,label+'.txt'),startedAt=Date.now();
  try{const r=await exec('/usr/bin/sample',[String(target.pid),'2','10','-mayDie','-file',file],{timeout:12000,maxBuffer:100000});log({kind:'native-sample',label,pid:target.pid,startedAt,finishedAt:Date.now(),ok:true,file:path.relative(root,file),stdout:r.stdout,stderr:r.stderr});}
  catch(error){log({kind:'native-sample',label,pid:target.pid,startedAt,finishedAt:Date.now(),ok:false,error:error.message,stderr:error.stderr});}
}
async function clean(owned){
  let alive=remaining(owned);if(!alive.length)return;consume('exact-owned native-diagnosis cleanup');log({kind:'cleanup-start',processes:alive});
  for(const p of alive)try{process.kill(p.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  await wait(2000);alive=remaining(owned);
  if(alive.length){log({kind:'cleanup-force',processes:alive});for(const p of alive)try{process.kill(p.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}await wait(500);}
  assert.equal(remaining(owned).length,0,'owned survivors could not be cleaned');
}
let state,owned=[],killedAt;
try{
  assert(Date.now()<budget().deadline);assert(!processes().some(p=>p.command.startsWith(app+'/Contents/')));
  const launch=JSON.parse(fs.readFileSync(path.join(data,'launch-budget.json')));assert.equal(launch.starts,16);assert.equal(launch.limit,17);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'artifacts/build-8/manifest.json')));
  for(const [name,sha] of Object.entries(manifest.sources))assert.equal(hash(path.join(app,'Contents/Resources/app',name)),sha);
  const work=path.join(data,'cases/packaged-baseline'),files=['website.json','website-events.jsonl'],websiteHashes=Object.fromEntries(files.map(n=>[n,hash(path.join(work,n))]));
  execFileSync(process.execPath,[path.join(root,'start.mjs'),'build-8'],{stdio:'pipe',timeout:30000});
  state=await until(s=>s.ready,90000);
  assert(state.packaged);assert(state.tasks.every(t=>t.phase==='uncertain'));assert.equal(state.tasks[1].intent,'waiting');assert.equal(state.tasks[0].counter,109);assert.equal(state.tasks[1].counter,150);
  const pids=JSON.parse(fs.readFileSync(path.join(state.out,'pids.json')));owned=collectOwned(pids);
  log({kind:'original-build-ready',tasks:state.tasks,processes:owned,websiteHashes});
  consume('one controller interruption to capture actual native exit stacks');
  killedAt=Date.now();process.kill(pids.controller,'SIGKILL');
  const observe=async ms=>{await wait(Math.max(0,killedAt+ms-Date.now()));const alive=remaining(owned);log({kind:'exit-observation',millisecondsAfterKill:Date.now()-killedAt,processes:alive});return alive;};
  await observe(300);
  let alive=await observe(3500),host=alive.find(p=>p.pid===pids.host);
  if(host)await sample(host,'host-after-3s');
  alive=await observe(15000);host=alive.find(p=>p.pid===pids.host);
  const renderer=alive.find(p=>p.command.includes('--type=renderer'));
  await Promise.allSettled([...(host?[sample(host,'host-after-15s')]:[]),...(renderer?[sample(renderer,'renderer-after-15s')]:[])]);
  alive=await observe(30000);
  log({check:'owned-processes-gone-without-cleanup-by-30-seconds',pass:alive.length===0});
  await clean(owned);owned=[];
  for(const name of files)assert.equal(hash(path.join(work,name)),websiteHashes[name]);
  log({check:'independent-website-unchanged-through-native-diagnosis',pass:true,websiteHashes});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
finally{
  const all=processes().filter(p=>p.command.startsWith(app+'/Contents/'));
  if(all.length){if(!killedAt){try{await result({kind:'quit'});await wait(2000);}catch(error){log({kind:'quit-request-failed',error:error.message});}}await clean(all);}
  const out=state?.out??path.join(data,'runs','17'),archive=path.join(root,'artifacts/run-17');
  if(fs.existsSync(out)){assert(!fs.existsSync(archive));fs.mkdirSync(archive);for(const name of fs.readdirSync(out))if(/\.(json|jsonl|log)$/.test(name))fs.copyFileSync(path.join(out,name),path.join(archive,name));}
  const b=budget();b.nativeExitDiagnosis.status=process.exitCode?'diagnosis-error-and-stopped':'captured-and-stopped';b.nativeExitDiagnosis.finishedAt=new Date().toISOString();b.nativeExitDiagnosis.evidence='artifacts/native-exit-diagnosis.jsonl';b.automaticStoppedAt=b.nativeExitDiagnosis.finishedAt;b.automaticRemainingMsAtStop=Math.max(0,b.deadline-Date.now());fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');
  log({kind:'diagnosis-stopped',status:b.nativeExitDiagnosis.status,remainingInstalledProcesses:processes().filter(p=>p.command.startsWith(app+'/Contents/'))});
}
