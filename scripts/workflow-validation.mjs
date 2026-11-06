import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyWorkflow({ client, website, data, evidence, command, waitFor, check, launch, remainingOwned }) {
  const cases = [
    { item: 'A', title: '第一次附件日报', destination: '公告', bytes: Buffer.from([0, 1, 2, 128, 255]) },
    { item: 'B', title: '换输入后的新日报', destination: '通知', bytes: Buffer.from([1, 7, 9, 128, 12, 255]) },
    { item: 'C', title: '冷开后的第三份日报', destination: '公告', bytes: Buffer.from([255, 24, 99, 0, 8]) },
  ];
  evidence.workflow = { cases: [], cold: null, realModelCalls: 0, remoteWrites: 0 };
  const configure = async active => {
    const state = await active.request({ kind: 'snapshot' });
    await active.request(command('model-save', { protocol: 'chat-completions', expectedVersion: state.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  };
  await configure(client);
  let active = client, learned;
  for (const sample of cases) {
    if (sample.item === 'C') {
      const before = await active.request({ kind: 'snapshot' });
      await active.quit();
      const remaining = remainingOwned();
      assert.equal(remaining.length, 0, 'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
      evidence.workflow.cold = { before, remaining, checkedAt: Date.now() };
      active = await launch();
      await configure(active);
    }
    const file = path.join(data, sample.item + '-新素材.bin'); fs.writeFileSync(file, sample.bytes);
    const target = website.base + '/edit?item=' + sample.item;
    const taskId = (await active.request(command('create', { goal: `使用“${file}”在 ${target} 发布“${sample.title}”到“${sample.destination}”` }))).taskId;
    const get = async () => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === taskId);
    await waitFor(async () => (await get())?.phase === 'manual');
    // 有限只读稳定准备，保留每次观察错误；不改变产品资格判断。
    let fingerprint, attempts = 0;
    const readiness = [];
    await waitFor(async () => {
      if (++attempts > 8) throw Error('WORKFLOW_READINESS_LIMIT');
      let dom;
      try { dom = await active.request({ kind: 'observe', taskId, method: 'DOMSnapshot.captureSnapshot' }); }
      catch (error) { readiness.push({ error: error.message }); if (['PAGE_NOT_AVAILABLE', 'OBSERVATION_NOT_AUTHORIZED', 'STALE_OBSERVATION'].includes(error.message)) return false; throw error; }
      const next = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      readiness.push({ fingerprint: next, documents: dom.documents.length });
      const stable = fingerprint === next; fingerprint = next; return stable;
    }, 15000);
    await active.request(command('execution-intent', { taskId, intent: 'start' }));
    const readPhase = async phase => waitFor(async () => {
      const e = (await get()).execution;
      if (phase === 'review' ? e?.question?.type === 'review' : e?.phase === phase) return e;
      if (e && ['paused', 'unknown', 'failed'].includes(e.phase)) throw Error(e.summary);
      return false;
    }, 50000);
    const review = await readPhase('review');
    check(sample.item + ' 本次素材、目标和确认独立，批准前没有发布', () => {
      assert.equal(review.publication.content, sample.title);
      assert.equal(review.publication.destination, sample.destination);
      assert.equal(review.publication.attachment.targetUrl, target);
      assert.equal(review.publication.approvalId, null);
      assert.equal(website.receipts.filter(r => r.item === sample.item && r.kind === 'published').length, 0);
      if (learned) assert.deepEqual(review.workflowUses[0].workflow, learned);
    });
    await active.request({ kind: 'participation-decision', taskId, questionId: review.question.id, operation: 'approve' });
    const done = await readPhase('complete');
    const bytes = Buffer.from(await (await fetch(done.publication.attachment.url, { signal: AbortSignal.timeout(5000) })).arrayBuffer());
    const html = await (await fetch(done.publicationChecks[0].proposal.url, { signal: AbortSignal.timeout(5000) })).text();
    const sha256 = createHash('sha256').update(sample.bytes).digest('hex');
    const state = await active.request({ kind: 'snapshot' });
    const calls = state.tasks.find(t => t.id === taskId).messages.filter(m => m.call).map(m => m.call);
    const writes = website.receipts.filter(r => r.item === sample.item && ['upload', 'draft', 'published'].includes(r.kind));
    check(sample.item + ' 独立下载字节、全文栏目、唯一结果及分项模型记录', () => {
      assert.deepEqual(bytes, sample.bytes);
      assert(html.includes(sample.title) && html.includes(sample.destination));
      assert.equal(done.publicationChecks[0].download.sha256, sha256);
      assert.deepEqual(writes.map(r => r.kind), ['upload', 'draft', 'published']);
      assert.equal(done.materialProcessing[0].status, 'complete');
      if (learned) {
        assert.equal(done.workflowUses[0].workflow.version, learned.version);
        assert.equal(website.receipts.filter(r => r.item === sample.item && r.kind === 'planning').length, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].usageKind, 'intent-and-inputs');
        assert(done.actions.every(a => a.workflowStep));
      } else {
        learned = done.learnedWorkflows[0];
        assert(learned.replay, 'LEARNED_LINK_RULES_REQUIRED');
        assert(calls.every(c => c.usageKind === 'web-planning'));
      }
    });
    learned = done.learnedWorkflows[0];
    evidence.workflow.cases.push({ item: sample.item, taskId, sha256, review, done, calls, writes, readiness });
  }
  await active.quit();
}
