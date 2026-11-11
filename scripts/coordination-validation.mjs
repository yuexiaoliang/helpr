import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { spend } from './workspace-budget.mjs';

export async function verifyCoordination({ client, website, data, evidence, command, waitFor, check, launch, remainingOwned, capacity = false, lateIntent = false }) {
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
  if (lateIntent) {
    const point = 'records-after';
    const control = (action) => active.request({ kind: 'validation-barrier', control: { action, point, taskId: a } });
    await stop(a);
    website.control({ holdWrites: true });
    await start(b);
    await waitFor(() => website.receipts.some(r => r.kind === 'write-start' && r.item === 'B'), 20000);
    await control('arm');
    spend('faults');
    const continuing = active.request(command('execution-intent', { taskId: a, intent: 'continue' }));
    void continuing.catch(() => {});
    const blockedReply = await waitFor(async () => {
      const status = await active.request({ kind: 'validation-barrier', control: { action: 'status' } });
      return status.waits.some(w => w.key === point + ':' + a && w.reached) && status;
    }, 5000);
    const db = new DatabaseSync(path.join(data, 'workspace.sqlite'), { readOnly: true });
    let saved;
    try {
      saved = JSON.parse(db.prepare('SELECT body FROM task_executions WHERE task_id = ?').get(a).body);
    } finally {
      db.close();
    }
    check('记录已接受旧继续，控制者回执仍在等待且网站未收到 A 的操作', () => {
      assert.equal(saved.intent, 'automatic');
      assert(!website.receipts.some(r => r.kind === 'write-start' && r.item === 'A'));
    });
    await stop(a);
    await control('release');
    await continuing;
    website.control({ holdWrites: false });
    await done(b);
    const final = await state();
    const results = await Promise.all(['A', 'B'].map(read));
    check('较新停止胜过迟到继续回执，A 零写入，B 一次成功', () => {
      const stopped = final.tasks.find(t => t.id === a).execution;
      assert.equal(stopped.intent, 'stopped');
      assert(stopped.version > saved.version);
      assert.deepEqual(results, [{ value: '', revision: 0 }, { value: '第二项内容', revision: 1 }]);
      assert.equal(website.receipts.filter(r => r.kind === 'write-start').length, 1);
    });
    evidence.lateIntent = { taskIds: [a, b], blockedReply, saved, final, results };
    await active.quit();
    return;
  }
  const queuedId = capacity ? await add('C', '第三项内容') : null;
  if (capacity) website.control({ participationItem: 'C' });
  website.control({ holdWrites: true });
  await start(a); await start(b);
  await waitFor(() => website.receipts.filter(r => r.kind === 'write-start').length === 2, 30000);
  const overlapping = await state();
  if (queuedId) {
    const report = evidence.capacity = { taskIds: [a, b, queuedId], overlapping };
    await start(queuedId);
    report.queued = await waitFor(async () => {
      const task = await get(queuedId);
      return task.execution?.phase === 'queued' && task;
    }, 15000);
    check('两项网站写入尚未返回，第三项排队且未调用模型或写入', () => {
      assert.equal(website.receipts.filter(r => r.kind === 'write-start').length, 2);
      assert.equal(website.receipts.filter(r => r.kind === 'write-end').length, 0);
      assert(!website.receipts.some(r => r.kind === 'planning' && r.item === 'C'));
    });
    await active.request({ kind: 'hide' });
    assert.equal((await active.request({ kind: 'inspect' })).window.visible, false);
    await stop(a);
    const question = await waitFor(async () => (await get(queuedId)).execution?.question, 15000);
    assert.equal(question.type, undefined);
    assert.equal((await get(a)).execution.intent, 'stopped');
    assert.equal((await get(b)).execution.intent, 'automatic');
    website.control({ holdWrites: false });
    await done(b);
    report.whileWaiting = await state();
    report.hidden = await active.request({ kind: 'inspect' });
    check('窗口收起时 A 停止，B 完成，C 保留参与请求', () => {
      assert.equal(report.whileWaiting.tasks.find(t => t.id === queuedId).execution.question.id, question.id);
      assert.equal(report.whileWaiting.tasks.find(t => t.id === a).execution.intent, 'stopped');
      assert.equal(report.hidden.window.visible, false);
    });
    await active.request({ kind: 'participation-reply', taskId: queuedId, questionId: question.id, text: '确认更新本项记录。' });
    await done(queuedId);
    report.final = await state();
    report.website = await Promise.all(['A', 'B', 'C'].map(read));
    check('各目标写入一次，迟到效果保留而 A 仍停止，隐藏窗口中的回复只影响 C', () => {
      assert.deepEqual(report.website, ['第一项内容', '第二项内容', '第三项内容'].map(value => ({ value, revision: 1 })));
      assert.equal(report.final.tasks.find(t => t.id === a).execution.phase, 'stopped');
      assert.equal(report.final.tasks.find(t => t.id === b).execution.phase, 'complete');
      assert.equal(report.final.tasks.find(t => t.id === queuedId).execution.phase, 'complete');
      assert.equal(website.receipts.filter(r => r.kind === 'write-start').length, 3);
    });
    await active.quit();
    return;
  }
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
