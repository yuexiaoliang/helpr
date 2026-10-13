// Exercise the same owner Interface used by the experiment. No database mutation by the verifier.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {harness,data,wait} from './harness.mjs';
const {log,result,call,until}=harness('old-backup-recovery');
try{
 const initial=await until(s=>s.ready&&!s.maintenance&&s.tasks.every(t=>t.intent==='completed'));
 const backups=fs.readdirSync(path.join(data,'backups')).map(name=>{const destination=path.join(data,'backups',name);return {destination,...JSON.parse(fs.readFileSync(path.join(destination,'manifest.json')))};}).sort((a,b)=>a.at-b.at);
 const old=backups[0];assert(old.tasks.every(t=>t.counter===12));
 await result({kind:'delegate',task:'A',steps:12});await result({kind:'delegate',task:'B',steps:2});
 await until(s=>s.tasks[0].counter>initial.tasks[0].counter&&s.tasks[0].phase==='verified');
 await result({kind:'stop',task:'A'});const before=await until(s=>s.tasks[0].phase==='verified'&&s.tasks[1].intent==='completed');
 const websiteFile=path.join(before.work,'website.json'),websiteBefore=fs.readFileSync(websiteFile,'utf8');
 const restored=await result({kind:'restore',destination:old.destination});assert(restored.paused&&restored.preservedNewerIntent);assert.equal(restored.tasks[0].intent,'stopped');assert(restored.tasks.every(t=>t.counter===12));
 await wait(1300);assert.equal(fs.readFileSync(websiteFile,'utf8'),websiteBefore);assert((await result({kind:'snapshot'})).maintenance);
 assert(!(await call({kind:'continue',task:'A'})).ok);log({check:'old-backup-does-not-undo-website-or-new-stop',pass:true});
 const reviewed=await result({kind:'review-restored',resume:[]});assert.equal(reviewed.tasks[0].intent,'stopped');assert.deepEqual(reviewed.tasks.map(t=>t.counter),before.tasks.map(t=>t.counter));assert(!(await result({kind:'snapshot'})).maintenance);
 await wait(1300);assert.equal(fs.readFileSync(websiteFile,'utf8'),websiteBefore);log({check:'restore-observes-current-website-and-requires-selected-resume',pass:true,tasks:reviewed.tasks});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
