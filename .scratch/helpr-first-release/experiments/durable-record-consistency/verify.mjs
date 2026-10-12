// 只读核对已保存证据；不重新运行实验、不启动进程或派发效果。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lines=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const runs=fs.readdirSync(path.join(root,'artifacts')).filter(n=>/^run-\d+$/.test(n)).sort();
assert(runs.length<=6);let cases=0,effects=0;const failures=[],probes=[];
for(const run of runs){
  const dir=path.join(root,'artifacts',run),manifest=read(path.join(dir,'manifest.json')),summary=read(path.join(dir,'summary.json')),results=read(path.join(dir,'results.json'));
  for(const [name,expected] of Object.entries(manifest.sources))assert.equal(hash(path.join(dir,'source',name)),expected,`${run} source ${name}`);
  assert.equal(results.length,summary.cases);assert(results.length<=60);assert(summary.effectRequests<=120);assert(summary.elapsedMs<=180000);
  assert.equal(summary.modelCalls+summary.remoteUploads+summary.remotePublications,0);
  assert.equal(summary.passed,results.every(r=>r.passed));
  let count=0;
  for(const [index,result] of results.entries()){
    const location=path.join(dir,`${String(index+1).padStart(2,'0')}-${result.name}`);
    const ledger=lines(path.join(location,'effects.jsonl'));
    const received=ledger.filter(e=>e.kind==='received'),completed=ledger.filter(e=>e.kind==='completed');
    assert.equal(received.length,result.effectRequests);count+=received.length;
    if(!result.passed)failures.push({run,case:result.name,error:result.error.message});
    const state=read(path.join(location,'state.json'));
    if(result.passed&&state){
      assert.deepEqual(state.integrity,[{integrity_check:'ok'}]);assert.deepEqual(state.foreignKeys,[]);
      // 容量缺口在 run-3 的失败场景中保留；其余已通过场景必须满足上限。
      assert(state.tasks.filter(t=>t.active_run).length<=2);
      for(const task of state.tasks.filter(t=>t.progress==='done')){
        const action=state.actions.find(a=>a.task===task.id);assert(action);assert.equal(action.stage,'verified');
        const receipt=state.receipts.find(r=>r.action===action.id);assert(receipt);
        const matches=completed.filter(e=>e.action===action.id&&e.task===task.id&&e.material===action.material&&e.version===action.content_version&&e.target===action.target);
        assert.equal(matches.length,1,`${run}/${result.name}: independent result`);
        assert.deepEqual(JSON.parse(receipt.evidence),matches[0]);
      }
    }
    const probe=path.join(location,'lock-probe.json');if(fs.existsSync(probe))probes.push(read(probe));
  }
  assert.equal(count,summary.effectRequests);cases+=results.length;effects+=count;
}
const final=path.join(root,'artifacts',runs.at(-1));
const manifest=read(path.join(final,'manifest.json')),summary=read(path.join(final,'summary.json'));
assert(summary.passed,'Final run did not pass');assert.equal(summary.cases,59);
for(const [name,expected] of Object.entries(manifest.sources))assert.equal(hash(path.join(root,name)),expected,`current ${name} differs from final frozen source`);
assert.equal(probes.filter(p=>p.waitMs===250).length,10);assert(probes.filter(p=>p.waitMs===250).every(p=>p.winners===1));
console.log(JSON.stringify({runs:runs.length,cases,effects,failures,finalCases:summary.cases,zeroWait:{rounds:probes.filter(p=>p.waitMs===0).length,noOwner:probes.filter(p=>p.waitMs===0&&p.winners===0).length},boundedWait:{rounds:10,noOwner:0},frozenSources:'verified',independentReceipts:'verified'},null,2));
