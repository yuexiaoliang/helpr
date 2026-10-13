import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {harness,root} from './harness.mjs';
const {log,result,until}=harness('reopen-checks');
try{
 const prior=fs.readFileSync(path.join(root,'artifacts/baseline-checks-2.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.command?.kind==='snapshot'&&r.result?.tasks[1].intent==='waiting')[0].result;
 const now=await until(s=>s.ready);assert.deepEqual(now.tasks.map(r=>[r.intent,r.counter]),prior.tasks.map(r=>[r.intent,r.counter]));log({check:'stop-and-wait-survive-cold-start',pass:true});
 const key=await result({kind:'credential'}),cookie=await result({kind:'cookie'});assert(key.ok&&!key.created&&!key.plaintextOnDisk);assert(cookie.ok&&!cookie.created);log({check:'protected-key-and-cookie-survive-reopen',pass:true});
 for(const task of ['A','B'])await result({kind:'continue',task});
 const completed=await until(s=>s.tasks.every(t=>t.intent==='completed'));assert(completed.tasks.every(t=>t.counter===28));log({check:'explicit-continue-checks-before-finishing',pass:true});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
