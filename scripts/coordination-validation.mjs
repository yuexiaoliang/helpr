import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function verifyCoordination({ client, website, evidence, command, waitFor, check, launch, remainingOwned }) {
  const detail = evidence.coordination = { cases: [], realModelCalls: 0, remoteWrites: 0 };
  let active = client;
  const state = () => active.request({ kind: 'snapshot' });
  const get = async id => (await state()).tasks.find(t => t.id === id);
  const configure = async () => {
    const s = await state();
    await active.request(command('model-save', { protocol: 'chat-completions', expectedVersion: s.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  };
  const add = async (item, value) => {
    const target = website.base + '/edit?item=' + item;
    const id = (await active.request(command('create', { goal: `更新 ${target} 为“${value}”` }))).taskId;
    await waitFor(async () => (await get(id)).phase === 'manual', 15000);
    let last;
    await waitFor(async () => {
      const dom = await active.request({ kind: 'observe', taskId: id, method: 'DOMSnapshot.captureSnapshot' });
      const next = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      const ready = last === next; last = next; return ready;
    }, 10000);
    return id;
  };
  const start = id => active.request(command('execution-intent', { taskId: id, intent: 'start' }));
  const stop = id => active.request(command('execution-intent', { taskId: id, intent: 'stop' }));
  const checkLogin = async id => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await get(id), q = t.execution?.question;
      assert.equal(q?.type, 'login', 'LOGIN_ENTRY_REQUIRED');
      try {
        return await active.request({ kind: 'participation-decision', taskId: id, questionId: q.id, operation: 'login-check' });
      } catch (error) {
        // 旧版本被明确拒绝才允许模拟一次重新点击；不重发未知结果或其它失败。
        if (error.message !== 'RECORD_VERSION_CONFLICT' || attempt !== 0) throw error;
        const latest = await get(id);
        assert.equal(latest.execution?.question?.id, q.id);
        assert.notEqual(latest.executionControl?.stopSaved, false);
        (detail.loginRetries ??= []).push({ taskId: id, questionId: q.id, rejectedVersion: t.execution.version, currentVersion: latest.execution.version, error: error.message });
      }
    }
  };
  const done = id => waitFor(async () => {
    const e = (await get(id)).execution;
    if (e?.phase === 'complete') return e;
    if (e && ['paused', 'unknown', 'failed'].includes(e.phase)) throw Error(e.summary);
    return false;
  }, 30000);
  const read = item => fetch(website.base + '/record?item=' + item, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  await configure();
  const a = await add('A', '第一项内容'), b = await add('B', '第二项内容');
  website.control({ holdWrites: true });
  await start(a); await start(b);
  await waitFor(() => website.receipts.filter(r => r.kind === 'write-start').length === 2, 30000);
  const overlapping = await state();
  website.control({ holdWrites: false });
  const first = await done(a), second = await done(b);
  check('两个不同稳定目标实际重叠写入，各自记录同一账号和独立目标', () => {
    assert(overlapping.tasks.filter(t => [a, b].includes(t.id)).every(t => ['checking', 'running'].includes(t.execution.phase)));
    const events = website.receipts.filter(r => ['write-start', 'write-end'].includes(r.kind));
    assert.deepEqual(events.slice(0, 2).map(r => r.kind), ['write-start', 'write-start']);
    assert.notEqual(first.resourceClaims[0].targetUrl, second.resourceClaims[0].targetUrl);
    assert.equal(first.coordination.account.name, '账号 alice');
    assert.equal(second.coordination.account.name, '账号 alice');
  });
  assert.equal((await read('A')).value, '第一项内容'); assert.equal((await read('B')).value, '第二项内容');
  detail.cases.push({ name: 'independent-targets', taskIds: [a, b], overlapping, first, second });

  const c = await add('C', '保留前项内容'), d = await add('C', '后项内容');
  website.control({ holdWrites: true });
  await start(c);
  await waitFor(() => website.receipts.some(r => r.kind === 'write-start' && r.item === 'C'), 20000);
  await start(d);
  await waitFor(async () => (await get(d)).execution?.coordination?.waitFor === c, 20000);
  const waiting = await state();
  website.control({ holdWrites: false });
  await done(c);
  const question = await waitFor(async () => (await get(d)).execution?.question, 20000);
  const prior = await read('C');
  check('同一目标不重叠，等待者重新读取后询问取舍，未覆盖前项结果', () => {
    assert.equal(prior.value, '保留前项内容'); assert.equal(prior.revision, 1);
    assert.equal(website.receipts.filter(r => r.kind === 'write-start' && r.item === 'C').length, 1);
    assert(question.text.includes('另一项任务已修改'));
  });
  await active.request({ kind: 'participation-reply', taskId: d, questionId: question.id, text: '明确替换为本项委托的后项内容。' });
  const final = await done(d);
  assert.deepEqual(await read('C'), { value: '后项内容', revision: 2 });
  detail.cases.push({ name: 'same-target', taskIds: [c, d], waiting, question, beforeChoice: prior, final });

  website.control({ planningWait: true });
  const l1 = await add('D', '保持停止'), l2 = await add('E', '恢复后的内容');
  await start(l1); await start(l2);
  await waitFor(async () => (await state()).tasks.filter(t => [l1, l2].includes(t.id)).every(t => t.execution?.coordination?.account?.name === '账号 alice'), 20000);
  website.control({ account: null });
  await waitFor(async () => {
    const tasks = (await state()).tasks.filter(t => [l1, l2].includes(t.id));
    return tasks.every(t => t.execution?.coordination?.status === 'login') && tasks.filter(t => t.execution.question?.type === 'login').length === 1;
  }, 20000);
  await stop(l1);
  await waitFor(async () => {
    const t = await get(l2); return t.execution?.question?.type === 'login' && t.execution.question;
  }, 10000);
  const expired = await state();
  website.control({ account: 'bob', planningWait: false });
  await waitFor(() => website.receipts.filter(r => r.kind === 'environment').at(-1)?.account === 'bob');
  // 网站轮询先观察新会话；不给产品写入关系或目标答案。
  await waitFor(async () => {
    const dom = await active.request({ kind: 'observe', taskId: l2, method: 'Accessibility.getFullAXTree' });
    return JSON.stringify(dom).includes('账号 bob');
  }, 10000);
  await checkLogin(l2);
  const changed = await waitFor(async () => {
    const e = (await get(l2)).execution;
    return e?.coordination?.status === 'account-changed' && e;
  }, 20000);
  check('同一登录障碍只有一个入口；切换账号不会执行原任务，已停止任务保持停止', () => {
    assert.equal(expired.tasks.filter(t => t.execution?.question?.type === 'login').length, 1);
    assert.equal(changed.coordination.account.name, '账号 alice');
    assert.equal(website.receipts.filter(r => r.kind === 'write-start' && ['D', 'E'].includes(r.item)).length, 0);
  });
  website.control({ account: 'alice' });
  await waitFor(async () => JSON.stringify(await active.request({ kind: 'observe', taskId: l2, method: 'Accessibility.getFullAXTree' })).includes('账号 alice'), 10000);
  const retry = (await get(l2)).execution.question;
  assert(retry, 'LOGIN_ENTRY_RETAINED_AFTER_ACCOUNT_MISMATCH');
  await checkLogin(l2);
  const restored = await done(l2);
  assert.equal((await get(l1)).execution.intent, 'stopped');
  assert.equal((await read('D')).revision, 0);
  assert.equal((await read('E')).value, '恢复后的内容');
  detail.cases.push({ name: 'shared-login', taskIds: [l1, l2], expired, changed, restored });

  await active.quit();
  assert.equal(remainingOwned().length, 0, 'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
  active = await launch(); await configure();
  assert.equal((await get(l1)).execution.intent, 'stopped');
  const cold = await add('F', '冷开后的内容'); await start(cold);
  const coldResult = await done(cold);
  assert.equal((await read('F')).revision, 1);
  check('正常退出并清空旧进程后，冷开重新取得当前会话和目标，原停止保持', () => {
    assert.notEqual(coldResult.coordination.session.epoch.split(':')[0], restored.coordination.session.epoch.split(':')[0]);
    assert(website.receipts.filter(r => r.kind === 'write-start').every(r => r.account === 'alice'));
  });
  detail.cases.push({ name: 'cold', taskId: cold, result: coldResult });
  detail.modelCalls = website.receipts.filter(r => r.kind === 'planning').length;
  detail.writes = website.receipts.filter(r => r.kind === 'write-start').length;
  await active.quit();
}
