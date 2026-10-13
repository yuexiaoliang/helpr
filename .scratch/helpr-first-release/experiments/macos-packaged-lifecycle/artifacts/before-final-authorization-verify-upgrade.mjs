import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {harness,root,data,wait} from './harness.mjs';
const {log,result,call,until}=harness('upgrade-recovery-checks-2');
try{
 const current=await until(s=>s.ready);assert.equal(current.version,'0.0.2');assert(current.packaged&&current.maintenance);
 const file=path.join(data,'update-receipt.json'),receipt=JSON.parse(fs.readFileSync(file));assert.equal(receipt.phase,'installing');
 assert(!(await call({kind:'delegate',task:'A',steps:1})).ok);assert(!(await call({kind:'schedule',due:Date.now()})).ok);
 const packagePath=path.join(root,'installed/helpr Lifecycle Lab.app/Contents/MacOS/helpr Lifecycle Lab');const hash=()=>createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex'),before=hash();await wait(1200);assert.equal(hash(),before);assert.equal(JSON.parse(fs.readFileSync(file)).phase,'installing');log({check:'cached-package-does-not-install-or-resume-on-start',pass:true});
 const verified=await result({kind:'complete-update'});assert(verified.credential.ok&&!verified.credential.created);assert(verified.cookie.ok&&!verified.cookie.created);assert(verified.tasks.every(t=>t.intent==='completed'));assert(!(await result({kind:'snapshot'})).maintenance);log({check:'interrupted-update-reconciled-with-protected-state',pass:true,verified});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
