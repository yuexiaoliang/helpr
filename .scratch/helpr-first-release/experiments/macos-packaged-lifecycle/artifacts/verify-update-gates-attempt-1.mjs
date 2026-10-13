import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {harness,root,data} from './harness.mjs';
const {log,call,result,until}=harness('update-gate-checks');
try{
 await until(s=>s.ready&&s.tasks.every(t=>t.intent==='completed'));
 assert(!(await call({kind:'prepare-update',mode:'idle',to:'0.0.2'})).ok);log({check:'idle-updates-default-off',pass:true});
 await result({kind:'idle-mode',enabled:true});
 await result({kind:'schedule',due:Date.now()+20000});assert(!(await call({kind:'prepare-update',mode:'idle',to:'0.0.2'})).ok);await result({kind:'schedule',due:null});log({check:'near-schedule-blocks-update',pass:true});
 for(const task of ['A','B'])await result({kind:'delegate',task,steps:2});await result({kind:'wait',task:'A'});
 assert(!(await call({kind:'prepare-update',mode:'manual',to:'0.0.2'})).ok);log({check:'waiting-is-not-idle',pass:true});
 await result({kind:'continue',task:'A'});await until(s=>s.tasks.every(t=>t.intent==='completed'));
 const budgetFile=path.join(root,'budget.json'),b=JSON.parse(fs.readFileSync(budgetFile));assert((b.faults||0)<12);b.faults=(b.faults||0)+1;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');
 const blocker=path.join(data,'backup-write-blocker');fs.writeFileSync(blocker,'Owned fault fixture; a file cannot contain the requested backup directory.');
 const rejected=await call({kind:'prepare-update',mode:'manual',to:'0.0.2',backupDestination:path.join(blocker,'backup')});assert(!rejected.ok);assert((await result({kind:'snapshot'})).maintenance);assert(!(await call({kind:'schedule',due:Date.now()})).ok);log({check:'backup-failure-keeps-dispatch-closed',pass:true});
 await result({kind:'release-maintenance'});
 const race=await Promise.all([call({kind:'prepare-update',mode:'idle',to:'0.0.2'}),call({kind:'schedule',due:Date.now()})]);assert.equal(race.filter(r=>r.ok).length,1);assert(race[0].ok&&!race[1].ok);log({check:'update-preparation-and-schedule-cannot-both-win',pass:true});
 const backup=race[0].result.backup;const names=fs.readdirSync(backup);assert(!names.some(n=>/profile|encrypted|cookie/i.test(n)));log({check:'backup-business-files-only',pass:true,backup,names});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
