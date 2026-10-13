// Check the actual installed repair and retained records before new virtual work.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {harness,root,wait} from './harness.mjs';
const {log,result,call,until}=harness('repair-installed-state');
try{
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'artifacts/lifecycle-revalidation-baseline.json')));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'artifacts/build-7/manifest.json')));
  const payload=path.join(root,'installed/helpr Lifecycle Lab.app/Contents/Resources/app');
  for(const [file,sha] of Object.entries(manifest.sources))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(payload,file))).digest('hex'),sha,'installed source differs: '+file);
  const state=await until(s=>s.ready,30000);assert(state.packaged);assert(state.power&&!state.power.blocked);
  const intent=t=>({id:t.id,intent:t.intent,phase:t.phase,counter:t.counter,goal:t.goal});
  assert.deepEqual(state.tasks.map(intent),baseline.tasks.map(intent));
  assert.equal((await call({kind:'continue',task:'B'})).error,'unknown-result-still-blocks');
  assert.match((await call({kind:'prepare-update',mode:'idle',to:'0.0.3'})).error,/work-not-idle:/);
  await wait(1200);const website=JSON.parse(fs.readFileSync(path.join(state.work,'website.json')));assert.deepEqual(website,baseline.website);
  const view=await result({kind:'show'});assert(view.visible);
  log({pass:true,build:'build-7',sources:Object.keys(manifest.sources).length,tasks:state.tasks,website,power:state.power,scope:'controlled lab replacement, not a product update qualification test'});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
