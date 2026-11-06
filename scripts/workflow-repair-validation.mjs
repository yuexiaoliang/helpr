import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyWorkflowRepair({client, website, data, evidence, command, waitFor, check, launch, remainingOwned}) {
  evidence.repair = {cases: [], cold: null, realModelCalls: 0, remoteWrites: 0};
  let active = client;
  const configure = async () => {
    const state = await active.request({kind:'snapshot'});
    await active.request(command('model-save', {protocol:'chat-completions', expectedVersion:state.modelSettings?.version ?? 0, endpoint:website.base+'/v1', model:'fixture', apiKey:'local-fixture-not-a-secret'}));
  };
  const get = async id => (await active.request({kind:'snapshot'})).tasks.find(t => t.id === id);
  const phase = (id, desired) => waitFor(async () => {
    const e = (await get(id)).execution;
    if (desired === 'review' ? e?.question?.type === 'review' : e?.phase === desired) return e;
    if (e && ['paused','unknown','failed'].includes(e.phase)) throw Error(e.summary);
    return false;
  }, 60000);
  const create = async item => {
    const bytes = Buffer.from([item.charCodeAt(0), 0, 128, 255, 17]);
    const file = path.join(data, item+'-修复素材.bin'); fs.writeFileSync(file, bytes);
    const title = item+'本次独立全文', destination = item === 'C' ? '通知' : '公告';
    const target = website.base+'/edit?item='+item;
    const taskId = (await active.request(command('create', {goal:`使用“${file}”在 ${target} 发布“${title}”到“${destination}”`}))).taskId;
    await waitFor(async () => (await get(taskId))?.phase === 'manual');
    let fingerprint, attempts = 0; const readiness = [];
    await waitFor(async () => {
      if (++attempts > 8) throw Error('REPAIR_READINESS_LIMIT');
      let dom;
      try {dom = await active.request({kind:'observe', taskId, method:'DOMSnapshot.captureSnapshot'});}
      catch(error) {readiness.push({error:error.message}); if (['PAGE_NOT_AVAILABLE','OBSERVATION_NOT_AUTHORIZED','STALE_OBSERVATION'].includes(error.message)) return false; throw error;}
      const next = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      readiness.push({fingerprint:next}); const stable = fingerprint === next; fingerprint = next; return stable;
    }, 15000);
    return {item, taskId, target, title, destination, bytes, readiness};
  };
  const start = sample => active.request(command('execution-intent', {taskId:sample.taskId, intent:'start'}));
  const approve = (sample, review) => active.request({kind:'participation-decision', taskId:sample.taskId, questionId:review.question.id, operation:'approve'});
  const save = async (sample, review) => {
    const done = await phase(sample.taskId, 'complete');
    const downloaded = Buffer.from(await (await fetch(done.publication.attachment.url, {signal:AbortSignal.timeout(5000)})).arrayBuffer());
    const html = await (await fetch(done.publicationChecks.at(-1).proposal.url, {signal:AbortSignal.timeout(5000)})).text();
    const calls = (await get(sample.taskId)).messages.filter(m => m.call).map(m => m.call);
    const writes = website.receipts.filter(r => r.item === sample.item && ['upload','draft','published'].includes(r.kind));
    check(sample.item+' 独立下载、全文栏目和唯一网站结果', () => {
      assert.deepEqual(downloaded, sample.bytes);
      assert(html.includes(sample.title) && html.includes(sample.destination));
      assert.deepEqual(writes.map(w => w.kind), ['upload','draft','published']);
      assert.equal(done.publication.attachment.targetUrl, sample.target);
      assert.equal(done.materialProcessing[0].status, 'complete');
    });
    evidence.repair.cases.push({...sample, bytes:[...sample.bytes], review, done, calls, writes});
    return done;
  };
  await configure();
  const a = await create('A'); await start(a); const ar = await phase(a.taskId, 'review'); await approve(a, ar);
  const ad = await save(a, ar), parent = ad.learnedWorkflows[0];
  const b = await create('B'), c = await create('C');
  await start(b); await start(c);
  const [br, cr] = await Promise.all([phase(b.taskId, 'review'), phase(c.taskId, 'review')]);
  check('双真实页面从同一父版本修复，草稿写入实际重叠且确认独立', () => {
    assert.equal(br.workflowUses[0].workflow.version, parent.version);
    assert.equal(cr.workflowUses[0].workflow.version, parent.version);
    assert.equal(br.workflowRepairs.length, 1); assert.equal(cr.workflowRepairs.length, 1);
    assert.equal(br.publication.approvalId, null); assert.equal(cr.publication.approvalId, null);
    const starts = website.receipts.filter(r => r.kind === 'draft-start');
    const ends = website.receipts.filter(r => ['B','C'].includes(r.item) && r.kind === 'draft');
    assert.equal(starts.length, 2); assert.equal(ends.length, 2);
    assert(Math.max(...starts.map(r => r.at)) <= Math.min(...ends.map(r => r.at)));
  });
  await approve(b, br); const bd = await save(b, br);
  await approve(c, cr); const cd = await save(c, cr);
  check('先完成版本采用，过期候选完整保留且不覆盖在途固定版', () => {
    assert.equal(bd.workflowDecisions[0].status, 'adopted');
    assert.equal(cd.workflowDecisions[0].status, 'conflict');
    assert.deepEqual(cd.workflowDecisions[0].observedHeads, [bd.learnedWorkflows[0].version]);
    assert.deepEqual(cd.workflowUses[0].workflow, parent);
    assert.equal(cd.learnedWorkflows.length, 1);
    assert.notDeepEqual(cd.learnedWorkflows[0].steps, bd.learnedWorkflows[0].steps);
  });
  await active.quit(); const remaining = remainingOwned(); assert.equal(remaining.length, 0);
  evidence.repair.cold = {remaining, checkedAt:Date.now()};
  active = await launch(); await configure();
  const d = await create('D'); await start(d); const dr = await phase(d.taskId, 'review'); await approve(d, dr);
  const dd = await save(d, dr);
  check('完整退出后采用修复版，新输入无需网页修复模型', () => {
    assert.deepEqual(dd.workflowUses[0].workflow, bd.learnedWorkflows[0]);
    assert.equal(dd.workflowRepairs, undefined);
    const calls = evidence.repair.cases.at(-1).calls;
    assert.equal(calls.length, 1); assert.equal(calls[0].usageKind, 'intent-and-inputs');
    assert(evidence.repair.cases.slice(1,3).every(sample => sample.calls.some(c => c.usageKind === 'workflow-repair')));
  });
  await active.quit();
}
