// Read-only evidence verification. Does not launch Electron or make network requests.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.join(here,'artifacts'),sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),lines=p=>fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const index=read(path.join(here,'evidence-index.json'));const runs=fs.readdirSync(root).filter(n=>/^run-\d+$/.test(n));assert(runs.length<=8);assert.deepEqual(runs.sort(),index.runs.map(r=>r.name).sort());
// Browser profiles are local runtime data, not portable experiment evidence.
// Retain their original hashes in the historical index without requiring or reading them.
const portableFiles=Object.keys(index.files).filter(file=>!file.split('/').includes('profile'));
let bytes=0,files=0;function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isSymbolicLink()||ent.isDirectory()&&ent.name==='profile')continue;if(ent.isDirectory())walk(p);else{bytes+=fs.statSync(p).size;files++;const relative=path.relative(here,p);assert.equal(sha(fs.readFileSync(p)),index.files[relative],relative);}}}walk(root);assert.equal(files,portableFiles.length);assert(bytes<419430400);
for(const name of runs){const dir=path.join(root,name),manifest=read(path.join(dir,'manifest.json')),checks=read(path.join(dir,'checks.json')),control=lines(path.join(dir,'control-events.jsonl')),website=lines(path.join(dir,'website-events.jsonl'));
  assert(checks.length<=100);assert(control.filter(e=>e.kind==='command').length<=20000);assert(website.filter(e=>e.kind==='request').length<=1000);
  for(const [file,hash] of Object.entries(manifest.sources))assert.equal(sha(fs.readFileSync(path.join(dir,'source',file))),hash);
  for(const k of ['modelCalls','remoteUploads','remotePublications'])assert.equal(manifest[k],0);
  const summary=path.join(dir,'summary.json');if(fs.existsSync(summary)){const s=read(summary);assert(s.elapsedMs<=240000);assert.equal(s.checks,checks.length);assert.equal(s.passed,checks.filter(c=>c.passed).length);assert.equal(s.requests,website.filter(e=>e.kind==='request').length);}
  else assert.equal(name,'run-2','Only the documented unhandled-rejection run lacks a summary');
}
const chosen=path.join(root,index.selected),manifest=read(path.join(chosen,'manifest.json')),checks=read(path.join(chosen,'checks.json')),control=lines(path.join(chosen,'control-events.jsonl')),website=lines(path.join(chosen,'website-events.jsonl')),host=lines(path.join(chosen,'host-events.jsonl'));
assert.equal(checks.length,43);assert(checks.every(c=>c.passed));assert(!fs.existsSync(path.join(chosen,'fatal.json')));assert(!fs.existsSync(path.join(chosen,'timeout.json')));
for(const [file,hash] of Object.entries(manifest.sources))assert.equal(sha(fs.readFileSync(path.join(here,file))),hash,`current source differs: ${file}`);
for(const [file,data] of Object.entries(manifest.dependencies))assert.equal(sha(fs.readFileSync(path.join(here,'../visible-page-control/node_modules',file))),data.sha256,`dependency differs: ${file}`);
assert.equal(manifest.dependencies['playwright/package.json'].version,'1.64.0');assert.equal(read(path.join(chosen,'environment.json')).versions.electron,'44.7.0');
const accepted=website.filter(e=>e.kind==='accepted'),completed=website.filter(e=>e.kind==='completed');assert.deepEqual(accepted.map(e=>e.id).sort(),['lateA','overlapA','overlapB']);assert.deepEqual(completed.map(e=>e.id).sort(),['lateA','overlapA','overlapB']);
for(const id of ['overlapA','overlapB'])assert(website.findIndex(e=>e.kind==='accepted'&&e.id===id)<website.findIndex(e=>e.kind==='completed'));
const stop=control.find(e=>e.kind==='revoked'&&e.task==='A');assert(stop);assert(accepted.find(e=>e.id==='lateA').time<=stop.time);assert(completed.find(e=>e.id==='lateA').time>=stop.time);
assert(control.some(e=>e.kind==='reply'&&e.client==='pwB'&&e.method==='Input.dispatchMouseEvent'&&!e.error&&e.time>=stop.time));
assert(control.some(e=>e.kind==='denied'&&e.client==='rawA'&&e.reason==='QUALIFICATION_REVOKED'&&e.time>=stop.time));
assert(control.some(e=>e.kind==='child-attached'&&e.type==='iframe'&&e.task==='A'));
for(const reason of ['QUALIFICATION_INVALID','QUALIFICATION_EXPIRED','TARGET_NOT_OWNED','SESSION_NOT_OWNED','FRAME_NOT_OWNED','ROOT_CAPABILITY_DENIED','FILE_NOT_SELECTED'])assert(control.some(e=>e.kind==='denied'&&e.reason===reason),reason);
for(const kind of ['popup-denied','navigation-denied','download-denied','permission-request-denied','before-quit','will-quit','process-exit'])assert(host.some(e=>e.kind===kind),kind);
assert.equal(fs.readFileSync(path.join(chosen,'death-processes.txt'),'utf8').trim(),'');assert(fs.readFileSync(path.join(chosen,'listeners.txt'),'utf8').startsWith('No TCP listeners'));
const audit=checks.find(c=>c.name==='credentials-not-in-shareable-evidence').value;assert.equal(audit.matches.length,0);assert(audit.checked>0);assert.equal(audit.credentialsIssued,8);
console.log(JSON.stringify({selected:index.selected,passed:checks.length,runs:runs.length,totalScenarioInstances:index.runs.reduce((n,r)=>n+r.checks,0),totalLocalRequests:index.runs.reduce((n,r)=>n+r.requests,0),evidenceFiles:files,evidenceBytes:bytes,modelCalls:0,remoteUploads:0,remotePublications:0},null,2));
