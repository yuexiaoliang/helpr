import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { richPublicationCases } from './rich-text-publication-fixture.mjs';
import { richTextReadiness } from './rich-text-lines-validation.mjs';
export async function verifyRichTextPublication({ client, website, data, evidence, command, waitFor, check, launch, remainingOwned, mode }) {
  const detail = evidence.richTextPublication = { profile: data, mode, cases: [], realModelCalls: 0, remoteWrites: 0, confirmations: 'scripted-public-entry' };
  const state = await client.request({ kind: 'snapshot' });
  await client.request(command('model-save', { protocol: 'chat-completions', expectedVersion: state.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  for (const item of richPublicationItems(mode)) {
    const spec = richPublicationCases[item], entry = website.base + '/rt-edit?item=' + item, content = spec.heading + '\n\n' + spec.body;
    const bytes = Buffer.from([0, 255, item.charCodeAt(0), 128, 13, 10]), file = path.join(data, item + '-素材.bin'); fs.writeFileSync(file, bytes);
    const taskId = (await client.request(command('create', { goal: `使用“${file}”在 ${entry} 发布“${content}”到“通知”` }))).taskId;
    const sample = { item, taskId, entry, file, sha256: createHash('sha256').update(bytes).digest('hex'), readiness: [] }; detail.cases.push(sample);
    const get = async (active = client) => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === taskId);
    const capture = async () => {
      const tree = await client.request({ kind: 'observe', taskId, method: 'Page.getFrameTree' });
      return { tree, dom: await client.request({ kind: 'observe', taskId, method: 'DOMSnapshot.captureSnapshot' }), ax: await client.request({ kind: 'observe', taskId, method: 'Accessibility.getFullAXTree', ...(spec.frame === 'main' ? {} : { frameId: tree.frameTree.childFrames[0].frame.id }) }) };
    };
    await waitFor(async () => (await get())?.phase === 'manual', 15000);
    await waitFor(richTextReadiness(client, taskId, sample), 15000);
    await client.request(command('execution-intent', { taskId, intent: 'start' }));
    sample.review = await waitFor(async () => { const e = (await get())?.execution; sample.last = e; return publicationReview(e); }, 50000);
    sample.before = await capture();
    check(item + ' 预览完整字段与当前真实节点，确认前零填写零发布', () => {
      assert.equal(sample.review.publication.content, content); assert.equal(sample.review.publication.approvalId, null);
      assert.equal(sample.review.publication.richTextReview.controls[0].name, ''); assert.equal(sample.review.publication.richTextReview.controls[0].role, 'generic');
      assert.equal(sample.review.publication.fields[1].frameUrl, spec.frame === 'main' ? entry : spec.frame);
      assert.equal(website.receipts.filter(r => r.item === item && ['rt-published', 'rt-input'].includes(r.kind)).length, 0);
      assert.equal(sample.review.actions.filter(a => a.action.kind === 'fill').length, 0);
    });
    if (mode.endsWith('replace')) {
      assert.equal((await fetch(website.base + '/rt-arm?item=' + item, { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 200);
      await waitFor(async () => website.receipts.some(r => r.kind === 'rt-changed' && r.item === item), 5000);
      if (item === 'P') { await waitFor(async () => website.receipts.filter(r => r.kind === 'rt-page' && r.item === item).length === 2, 10000); const ready = { readiness: [] }; await waitFor(richTextReadiness(client, taskId, ready), 15000); sample.replacementReadiness = ready; }
      sample.changed = await capture();
    }
    sample.approveAt = Date.now();
    try { sample.approval = await client.request({ kind: 'participation-decision', taskId, questionId: sample.review.question.id, operation: 'approve' }); }
    catch (error) { sample.approvalError = error.message; if (!mode.endsWith('replace')) throw error; }
    sample.result = await waitFor(async () => { const t = await get(); sample.last = t.execution; if (!mode.endsWith('replace') && t.execution?.phase === 'paused') throw Error('PUBLICATION_INTERRUPTED:' + t.execution.summary); return (mode.endsWith('replace') ? ['paused', 'unknown'].includes(t.execution?.phase) : t.execution?.phase === 'complete') && t; }, 50000);
    sample.after = await capture();
    const e = sample.result.execution;
    if (mode.endsWith('replace')) check(item + ' 旧预览节点或页面失效后不填写不发布', () => { assert.equal(e.actions.filter(a => a.action.kind === 'fill').length, 0); assert.equal(website.receipts.filter(r => r.item === item && ['rt-input', 'rt-published'].includes(r.kind)).length, 0); assert.equal(e.publicationChecks?.length ?? 0, 0); });
    else {
      const download = Buffer.from(await (await fetch(e.publication.attachment.url, { signal: AbortSignal.timeout(5000) })).arrayBuffer()); sample.downloadHex = download.toString('hex');
      sample.publicHtml = await fetch(e.publicationChecks[0].proposal.url, { signal: AbortSignal.timeout(5000) }).then(r => r.text());
      check(item + ' 网站单次发布、完整字段、字节和不可复用历史', () => {
        assert.deepEqual(download, bytes); assert.equal(e.publicationChecks.length, 1); assert.equal(e.publicationChecks[0].download.sha256, sample.sha256);
        assert.deepEqual(e.actions.at(-1).fieldResults.map(c => c.textValue), [spec.heading, spec.body]);
        assert.equal(e.actions.filter(a => a.action.kind === 'fill').length, 2); assert.equal(e.actions.at(-1).effect, 'publication');
        assert.equal(e.materialProcessing[0].status, 'complete'); assert(e.workflowDecisions.some(d => d.status === 'unusable')); assert(e.learnedWorkflows.every(w => !w.replay));
        const publications = website.receipts.filter(r => r.kind === 'rt-published' && r.item === item); assert.equal(publications.length, 1); assert.equal(publications[0].body, spec.body); assert.equal(publications[0].heading, spec.heading); assert.equal(publications[0].destination, '通知');
        const inputs = website.receipts.filter(r => r.kind === 'rt-input' && r.item === item); assert.equal(inputs.length, spec.body.split('\n').length * 2 - 1); assert.equal(inputs.at(-1).value, spec.body);
      });
    }
  }
  const counts = () => Object.fromEntries(['rt-planning', 'rt-input', 'rt-upload', 'rt-draft', 'rt-published'].map(kind => [kind, website.receipts.filter(r => r.kind === kind).length]));
  detail.beforeCold = counts(); await client.quit(); assert.deepEqual(remainingOwned(), []); const cold = await launch();
  for (const sample of detail.cases) {
    sample.cold = await waitFor(async () => { const t = (await cold.request({ kind: 'snapshot' })).tasks.find(t => t.id === sample.taskId); return t?.phase === 'manual' && t; }, 15000);
    check(sample.item + ' 冷开保存预览和发布事实，不重发', () => { for (const key of ['actions', 'publication', 'publicationChecks', 'materialProcessing', 'workflowDecisions']) assert.deepEqual(sample.cold.execution[key], sample.result.execution[key]); assert.equal(sample.cold.execution.phase, sample.result.execution.phase); });
  }
  detail.afterCold = counts(); assert.deepEqual(detail.afterCold, detail.beforeCold); await cold.quit();
}

export function publicationReview(e) {
  if (e?.question?.type === 'review') return e;
  if (e?.phase === 'paused') throw Error('REVIEW_INTERRUPTED:' + e.summary);
  return false;
}

export function richPublicationItems(mode) {
  return { main: ['A'], inline: ['B', 'C'], 'node-replace': ['N'], 'page-replace': ['P'] }[mode];
}
