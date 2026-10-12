// 仅核对保存的证据，不连接模型或网站。--check 同时验证文件清单未变。
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const base=path.dirname(fileURLToPath(import.meta.url));
const bytes=f=>readFile(path.join(base,f));
const load=async f=>JSON.parse(await bytes(f));
const hash=x=>createHash('sha256').update(Buffer.isBuffer(x)||typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const root='artifacts/drupal',meta=await load(root+'/meta.json');
const totalTokens=meta.calls.reduce((n,c)=>n+(c.usage?.total_tokens||0),0),phaseCounts={};
assert.ok(meta.calls.length<=meta.limits.calls&&totalTokens<=meta.limits.tokens);
for(const [phase,[limit,tokens]] of Object.entries(meta.limits.phases)){
  const calls=meta.calls.filter(c=>c.phase===phase);phaseCounts[phase]={calls:calls.length,tokens:calls.reduce((n,c)=>n+(c.usage?.total_tokens||0),0)};
  assert.ok(calls.length<=limit&&phaseCounts[phase].tokens<=tokens);
}
for(const c of meta.calls){assert.ok(Date.parse(c.startedAt)<meta.deadline);assert.equal(c.httpStatus,200);}
assert.equal(meta.learnRuns,3);assert.equal(meta.calibrationRuns,2);assert.ok(meta.evaluationStarted);
assert.equal(meta.protocolRevisions.length,2);assert.equal(meta.sources.length,3);
for(const source of meta.sources){
  assert.equal(hash(source.hashes),source.digest);
  for(const [file,digest] of Object.entries(source.hashes))assert.equal(hash(await bytes(`${root}/source/${source.version}/${file.replace(/^\.\.\//,'shared/')}`)),digest,file);
}
for(const [file,digest] of Object.entries(meta.sources.at(-1).hashes))assert.equal(hash(await bytes(file)),digest,file);
const provenance=await load('source-origin.json');
for(const [file,digest] of Object.entries(provenance.sha256))assert.equal(hash(await bytes(provenance.from+'/'+file)),digest,'historical source changed: '+file);
const candidate=await load(root+'/frozen-candidate.json');
assert.equal(candidate.seal,hash({steps:candidate.steps,resultRules:candidate.resultRules,template:candidate.template}));
assert.equal(candidate.steps.length,7);assert.equal(candidate.steps.find(s=>s.action.op==='select').after[0].kind,'selected-label');
const learned=await load(root+'/learn-3/results.json');assert.equal(learned.status,'learned-unvalidated');
assert.deepEqual(learned.reusedSource.steps,['s1','s2','s3','s4']);assert.equal(learned.reusedSource.stopBeforeFailure,'s5');
assert.equal((await load(root+'/learn/results.json')).error.code,'condition-unsatisfied');
assert.equal((await load(root+'/learn-2/results.json')).error.message,'upload-not-observed');
const calibration=await load(root+'/calibration/results.json');assert.equal(calibration.status,'uncertain');assert.ok(calibration.error.executed&&calibration.effectProbe.dispatchPrevented);
const position=await load(root+'/result-position-calibration.json');assert.ok(position.recoveredReadOnlyResult.independent.passed);
assert.equal(position.newSeal,candidate.seal);assert.deepEqual(candidate.steps.at(-1).action.target.name,{input:'title'});
assert.equal(hash(await bytes('calibrate-result-position.mjs')),position.sourceHash);
assert.equal(hash(await bytes(root+'/position-calibration/source.mjs')),position.sourceHash);
const outcomes={},operations={};
for(const name of ['learn','learn-2','learn-3','calibration','calibration-2','heldout','heldout-collision','changed-control']){
  const r=await load(`${root}/${name}/results.json`);outcomes[name]=r.status;
  const events=(await bytes(`${root}/${name}/events.jsonl`)).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  const allowed=events.filter(e=>e.type==='mutation-request'&&e.outcome==='allowed');
  const uploads=allowed.filter(e=>e.operation==='upload'),writes=allowed.filter(e=>e.operation!=='upload');
  operations[name]={uploadActions:events.filter(e=>e.type==='dispatch'&&e.action.op==='upload').length,uploads:uploads.length,writes:writes.length};
  assert.ok(uploads.length<=1&&writes.length<=1);
  // 早期协议的多余文件选择保留为失败证据，不能改写为从未发生。
  if(name==='learn-2')assert.equal(operations[name].uploadActions,2);else assert.ok(operations[name].uploadActions<=1);
  if(['calibration-2','heldout','heldout-collision'].includes(name)){
    assert.equal(r.status,'completed');assert.equal(r.modelCallsDuringBrowserReplay,0);assert.ok(r.result.runtimeEvidence.every(e=>e.ok));
  }
}
for(const name of ['learn-3','calibration','calibration-2','heldout','heldout-collision']){
  const f=await load(`${root}/${name}/fixture.json`),o=await load(`${root}/${name}/oracle.json`);
  assert.ok(o.passed&&o.anonymous);assert.equal(o.title,f.expected.title);assert.equal(o.body,f.expected.body);assert.equal(o.category,f.expected.category);
  assert.equal(o.downloadSha256,hash(await bytes(`${root}/${name}/oracle-download.xlsx`)));assert.equal(o.sourceSha256,hash(await readFile(f.expected.filePath)));assert.equal(o.downloadSha256,o.sourceSha256);
}
assert.ok((await load(root+'/calibration-2/results.json')).effectProbe.dispatchPrevented);
assert.equal(outcomes['changed-control'],'correctly-blocked');assert.equal(operations['changed-control'].uploads+operations['changed-control'].writes,0);
const generated=await load(root+'/heldout-generation.json');assert.equal(generated.candidateHash,hash(candidate));
assert.ok(generated.cases.every(c=>Date.parse(c.createdAt)>Date.parse(candidate.validatedAt)));
for(const name of ['heldout','heldout-collision']){const t=await load(`${root}/${name}/task.json`);assert.notEqual(t.inputs.attachment.sha256,candidate.template.inputs.attachment.sha256);}
for(const kind of ['draft','update','summarize']){const r=await load(`${root}/negative-${kind}/results.json`);assert.equal(r.status,'correctly-rejected');assert.equal(r.browserDispatched,false);}
assert.ok(meta.calls.filter(c=>c.phase==='evaluate').every(c=>c.label.startsWith('parse-')));
assert.ok((await load(root+'/protocol-negatives.json')).every(r=>r.status==='rejected'));
assert.equal((await load(root+'/sealed-tamper.json')).status,'correctly-rejected');
assert.ok((await load('artifacts/protocol-checks/results.json')).passed);
const audit=await load('artifacts/site-audit.json');
assert.equal(audit.nodes.length,6);assert.equal(audit.files.length,7);
assert.ok(audit.nodes.every(n=>n.published&&n.owner==='helpr_tester'&&n.type==='report'));
const names=new Set(audit.nodes.map(n=>n.title));assert.equal(names.size,6);
assert.ok(!names.has('第二后台对照 learn-2 drupal'));
for(const name of ['learn-3','calibration','calibration-2','heldout','heldout-collision']){
  const o=await load(`${root}/${name}/oracle.json`),n=audit.nodes.find(n=>n.url===o.resultUrl),f=audit.files.find(f=>f.id===n.fileId);
  assert.equal(n.title,o.title);assert.equal(n.body,`<p>${o.body}</p>`);assert.equal(n.section,o.category);assert.equal(f.sha256,o.sourceSha256);
}
const files={};
async function walk(relative=''){
  for(const entry of await readdir(path.join(base,relative),{withFileTypes:true})){
    if(['private','node_modules','.git'].includes(entry.name))continue;
    const file=path.join(relative,entry.name);
    if(entry.isDirectory())await walk(file);
    else if(!['evidence-index.json','verification.json'].includes(file))files[file]=hash(await bytes(file));
  }
}
await walk();
if(process.argv.includes('--check'))assert.deepEqual(files,await load('evidence-index.json'),'evidence files changed');
else {
  await writeFile(path.join(base,'evidence-index.json'),JSON.stringify(files,null,2)+'\n');
  await writeFile(path.join(base,'verification.json'),JSON.stringify({at:new Date().toISOString(),passed:true,calls:meta.calls.length,totalTokens,phaseCounts,outcomes,operations,verifiedFiles:Object.keys(files).length,knownHistoricalDeviation:'learn-2 made two file selections, with only one upload request; its failure is retained'},null,2)+'\n');
}
console.log(JSON.stringify({passed:true,calls:meta.calls.length,totalTokens,phaseCounts,outcomes,operations,verifiedFiles:Object.keys(files).length}));
