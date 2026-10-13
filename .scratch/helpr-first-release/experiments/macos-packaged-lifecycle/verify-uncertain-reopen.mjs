// Real owner death after the local site accepts an action. Run after the human checks.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {harness,root,wait} from './harness.mjs';
const {log,result,call,until}=harness('uncertain-result-reopen');
const processRows=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:Number(m[1]),parent:Number(m[2]),command:m[3]}));
function countFault(reason){const file=path.join(root,'budget.json'),v=JSON.parse(fs.readFileSync(file));assert(v.faults<12,'fault budget exhausted');v.faults++;fs.writeFileSync(file,JSON.stringify(v,null,2)+'\n');log({kind:'fault-budget-consumed',reason,total:v.faults});}
try{
 const initial=await until(s=>s.ready&&!s.maintenance&&s.tasks.every(t=>t.phase==='verified')&&s.tasks[1].intent==='completed');
 if(initial.tasks[0].intent!=='stopped')await result({kind:'stop',task:'A'});
 const pids=JSON.parse(fs.readFileSync(path.join(initial.out,'pids.json'))),siteFile=path.join(initial.work,'website-events.jsonl');let siteOffset=fs.statSync(siteFile).size;
 await result({kind:'delegate',task:'B',steps:3});
 const end=Date.now()+6000;let accepted;
 while(Date.now()<end&&!accepted){const all=fs.readFileSync(siteFile);for(const line of all.subarray(siteOffset).toString().split('\n').filter(Boolean)){const e=JSON.parse(line);if(e.kind==='accepted'&&e.task==='B')accepted=e;}siteOffset=all.length;if(!accepted)await wait(10);}
 assert(accepted,'website did not accept the bounded action');
 const dispatch=await result({kind:'snapshot'});assert.equal(dispatch.tasks[1].phase,'dispatched','missed the crash window; do not kill at another point');
 const processes=processRows(),owned=new Map(),ownedIds=new Set([pids.controller,pids.host]);let changed=true;while(changed){changed=false;for(const p of processes)if(ownedIds.has(p.parent)&&!ownedIds.has(p.pid)){ownedIds.add(p.pid);changed=true;}}
 for(const p of processes)if(ownedIds.has(p.pid))owned.set(p.pid,p.command);
 assert(owned.get(pids.controller)?.includes('/installed/helpr Lifecycle Lab.app/Contents/MacOS/'));
 countFault('SIGKILL owner after website accepted B');log({kind:'before-owner-kill',accepted,tasks:dispatch.tasks,processes:processes.filter(p=>ownedIds.has(p.pid))});process.kill(pids.controller,'SIGKILL');
 await wait(3500);let alive=processRows().filter(p=>owned.get(p.pid)===p.command);
 const automaticCleanup=alive.length===0;log({check:'owner-death-cleans-owned-processes',pass:automaticCleanup,survivors:alive});
 if(alive.length){
  countFault('cleanup of exact owned survivors after owner-death assertion');
  for(const p of alive)try{process.kill(p.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  await wait(1500);alive=processRows().filter(p=>owned.get(p.pid)===p.command);
  if(alive.length){log({kind:'owned-cleanup-needs-force',processes:alive});for(const p of alive)try{process.kill(p.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}await wait(500);}
  assert(!processRows().some(p=>owned.get(p.pid)===p.command),'owned process cleanup failed');
 }
 const websiteFile=path.join(initial.work,'website.json'),afterCrashSite=fs.readFileSync(websiteFile,'utf8');
 const archive=path.join(root,'artifacts','run-'+path.basename(initial.out));assert(!fs.existsSync(archive));fs.mkdirSync(archive);for(const name of fs.readdirSync(initial.out))if(/\.(json|jsonl|log)$/.test(name))fs.copyFileSync(path.join(initial.out,name),path.join(archive,name));
 execFileSync(process.execPath,[path.join(root,'start.mjs'),'build-6'],{stdio:'pipe'});
 const reopened=await until(s=>s.ready);assert.equal(reopened.tasks[0].intent,'stopped');assert.equal(reopened.tasks[1].phase,'uncertain');
 await wait(2000);assert.equal(fs.readFileSync(websiteFile,'utf8'),afterCrashSite);
 assert(!(await call({kind:'continue',task:'B'})).ok);assert(!(await call({kind:'prepare-update',mode:'idle',to:'0.0.3'})).ok);
 await wait(1200);assert.equal(fs.readFileSync(websiteFile,'utf8'),afterCrashSite);
 log({check:'uncertain-result-survives-reopen-and-blocks-replay-and-update',pass:true,tasks:reopened.tasks,website:JSON.parse(afterCrashSite)});
 if(!automaticCleanup)process.exitCode=1;
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
