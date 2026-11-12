import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export async function verifyLinkNavigation({ client, website, evidence, command, waitFor, check, launch, remainingOwned }) {
  const detail = evidence.linkNavigation = { realModelCalls: 0, remoteWrites: 0, readiness: [] };
  const state = await client.request({ kind: 'snapshot' });
  await client.request(command('model-save', { protocol: 'chat-completions', expectedVersion: state.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  const taskId = detail.taskId = (await client.request(command('create', { goal: '打开 ' + website.base + '/link-start 中的条目并核对内容。' }))).taskId;
  const get = async active => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === taskId);
  await waitFor(async () => (await get(client))?.phase === 'manual', 15000);
  let last, attempts = 0;
  await waitFor(async () => {
    assert(++attempts <= 8, 'LINK_READINESS_LIMIT');
    const dom = await client.request({ kind: 'observe', taskId, method: 'DOMSnapshot.captureSnapshot' });
    const fingerprint = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
    detail.readiness.push(fingerprint);
    const stable = last === fingerprint; last = fingerprint; return stable;
  }, 15000);
  await client.request(command('execution-intent', { taskId, intent: 'start' }));
  const completed = detail.completed = await waitFor(async () => {
    const task = await get(client);
    detail.latest = task;
    return task.execution?.phase === 'complete' && task;
  }, 50000);
  check('链接导航即时撤权后只读核对新页，持久确认并自主续行，没有代答继续', () => {
    const e = completed.execution, a = e.actions[0];
    assert.equal(e.actions.length, 1); assert.equal(a.status, 'confirmed');
    assert.equal(a.navigation.association, 'during-action');
    assert.equal(a.navigation.url, website.base + '/link-item/42');
    assert.equal(a.navigationResolution.proof.reason, 'anchorClick');
    assert.deepEqual(a.action.target.within, { role: 'main', name: '', exact: true });
    assert.equal(website.receipts.filter(r => r.kind === 'link-wrong-region').length, 0);
    assert.equal(a.navigationResolution.pausedInputEpoch, a.navigation.inputEpoch + 2);
    assert.equal(a.resultSource.generation, a.binding.generation + 1);
    assert.equal(a.resultSource.url, a.navigation.url);
    assert.equal(e.pauseReason, undefined);
    assert.equal(website.receipts.filter(r => r.kind === 'link-arrival').length, 1);
    assert.equal(website.receipts.filter(r => r.kind === 'link-planning').length, 2);
  });
  const redirectedTaskId = detail.redirectedTaskId = (await client.request(command('create', { goal: '打开 ' + website.base + '/link-redirect-start 中的条目并核对内容。' }))).taskId;
  const getRedirected = async active => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === redirectedTaskId);
  await waitFor(async () => (await getRedirected(client))?.phase === 'manual', 15000);
  let redirectLast, redirectAttempts = 0;
  await waitFor(async () => {
    assert(++redirectAttempts <= 8, 'LINK_REDIRECT_READINESS_LIMIT');
    const dom = await client.request({ kind: 'observe', taskId: redirectedTaskId, method: 'DOMSnapshot.captureSnapshot' });
    const fingerprint = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
    const stable = redirectLast === fingerprint; redirectLast = fingerprint; return stable;
  }, 15000);
  await client.request(command('execution-intent', { taskId: redirectedTaskId, intent: 'start' }));
  await waitFor(async () => {
    const task = await getRedirected(client);
    return task.execution?.pauseReason === 'page-change' && task.phase === 'manual' && task.url.endsWith('/link-roundtrip') && task.execution.actions[0]?.navigation && task;
  }, 50000);
  // 越过产品6秒只读恢复上限再判定，避免在恢复前抓到暂态paused而假通过。
  await new Promise(resolve => setTimeout(resolve, 6500));
  const redirected = detail.redirected = await getRedirected(client);
  check('连续重定向回原href仍保持未知与暂停，不借最终URL相同自动放行', () => {
    assert.equal(redirected.execution.pauseReason, 'page-change');
    const a = redirected.execution.actions[0];
    assert.deepEqual(a.action.target.within, { role: 'navigation', name: '侧栏', exact: true });
    assert.equal(website.receipts.filter(r => r.kind === 'link-wrong-region').length, 0);
    assert.equal(a.navigation.url, website.base + '/link-roundtrip');
    assert.equal(a.status, 'unknown'); assert.equal(a.navigationResolution, undefined);
    assert.equal(website.receipts.filter(r => r.kind === 'link-redirect').length, 2);
    assert.equal(website.receipts.filter(r => r.kind === 'link-redirect-arrival').length, 1);
    assert.equal(website.receipts.filter(r => r.kind === 'link-planning').length, 3);
  });
  await client.quit();
  assert.deepEqual(remainingOwned(), [], 'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
  const reopened = await launch();
  const cold = detail.cold = await waitFor(async () => {
    const task = await get(reopened); return task.phase === 'manual' && task;
  }, 15000);
  check('冷开保留新页检查点与完成结果，没有重复动作或规划', () => {
    assert.deepEqual(cold.execution.actions, completed.execution.actions);
    assert.equal(cold.execution.phase, 'complete');
    assert.equal(website.receipts.filter(r => r.kind === 'link-planning').length, 3);
  });
  const coldRedirected = detail.coldRedirected = await getRedirected(reopened);
  assert.equal(coldRedirected.execution.pauseReason, 'page-change');
  assert.equal(coldRedirected.execution.actions[0].status, 'unknown');
  assert.equal(coldRedirected.execution.actions[0].navigationResolution, undefined);
  await reopened.quit();
}
