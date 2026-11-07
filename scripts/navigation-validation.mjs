import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function verifyNavigation({ client, website, evidence, command, waitFor, check, launch, remainingOwned }) {
  const detail = evidence.navigation = { realModelCalls: 0, remoteWrites: 0, automaticContinuation: false, readiness: [] };
  const state = await client.request({ kind: 'snapshot' });
  await client.request(command('model-save', { protocol: 'chat-completions', expectedVersion: state.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  const taskId = detail.taskId = (await client.request(command('create', { goal: '在 ' + website.base + '/navigation-start 新建一个条目并核对。' }))).taskId;
  const get = async active => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === taskId);
  await waitFor(async () => (await get(client))?.phase === 'manual', 15000);
  let last, attempts = 0;
  await waitFor(async () => {
    assert(++attempts <= 8, 'NAVIGATION_READINESS_LIMIT');
    const dom = await client.request({ kind: 'observe', taskId, method: 'DOMSnapshot.captureSnapshot' });
    const fingerprint = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
    detail.readiness.push(fingerprint);
    const stable = last === fingerprint; last = fingerprint; return stable;
  }, 15000);
  await client.request(command('execution-intent', { taskId, intent: 'start' }));
  const paused = detail.paused = await waitFor(async () => {
    const task = await get(client), e = task.execution;
    return e?.pauseReason === 'page-change' && e.actions[0]?.navigation && task.url.endsWith('/navigation-result/1') && task.executionControl?.stopSaved && task;
  }, 50000);
  check('实际POST与303导航仅产生一个条目，记录首个导航且保持暂停和未知', () => {
    const e = paused.execution, a = e.actions[0];
    assert.equal(e.actions.length, 1);
    assert.equal(a.status, 'unknown');
    assert.equal(a.navigation.association, 'during-action');
    assert.equal(a.navigation.url, website.base + '/navigation-create');
    assert.equal(a.navigation.sourceGeneration, a.binding.generation);
    assert.equal(a.navigation.targetId, a.binding.targetId);
    assert.equal(a.navigation.mainFrame, true);
    assert.equal(a.navigation.sameDocument, false);
    assert.equal(website.receipts.filter(r => r.kind === 'navigation-created').length, 1);
    assert.equal(website.receipts.filter(r => r.kind === 'navigation-planning').length, 1);
    assert.equal(e.result, undefined);
  });
  await client.quit();
  assert.deepEqual(remainingOwned(), [], 'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
  const reopened = await launch();
  const cold = detail.cold = await waitFor(async () => {
    const task = await get(reopened);
    return task.phase === 'manual' && task;
  }, 15000);
  check('正常退出和冷开保留导航事实，未代答继续、未重建条目', () => {
    assert.deepEqual(cold.execution.actions[0].navigation, paused.execution.actions[0].navigation);
    assert.equal(cold.execution.pauseReason, 'page-change');
    assert.equal(cold.execution.actions[0].status, 'unknown');
    assert.equal(website.receipts.filter(r => r.kind === 'navigation-created').length, 1);
    assert.equal(website.receipts.filter(r => r.kind === 'navigation-planning').length, 1);
  });
  await reopened.quit();
}
