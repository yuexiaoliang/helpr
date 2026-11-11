import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spend } from './workspace-budget.mjs';

export async function verifyRecordFaults({
  client,
  completed,
  taskIds,
  website,
  data,
  evidence,
  command,
  waitFor,
  check,
  launch,
  remainingOwned,
}) {
  const report = (evidence.recordFaults = {});
  const [stoppedId, blockedId] = taskIds;
  const point = 'publication-reserved';
  const barrier = (action, taskId) =>
    client.request({ kind: 'validation-barrier', control: { action, point, taskId } });
  const get = async (current, id) =>
    (await current.request({ kind: 'snapshot' })).tasks.find(t => t.id === id);
  const published = () => website.receipts.filter(r => r.kind === 'published');
  const gateNames = fs.readdirSync(data).filter(name => /^\.input-gate-[0-9a-f-]+$/.test(name));
  assert.equal(gateNames.length, 1, 'ONE_NATIVE_GATE_REQUIRED');
  const gate = createRequire(import.meta.url)(path.join(evidence.app, 'Contents/Resources/input-bridge.node'));
  gate.open(path.join(data, gateNames[0]), false);
  const denied = (id, original) => {
    const current = gate.state(id);
    let sent = 0;
    assert(original.available && !original.blocked);
    assert(current.blocked && current.epoch > original.epoch);
    assert.throws(() => gate.permit(id, original.epoch, () => { sent++; }), /INPUT_QUALIFICATION_REVOKED/);
    assert.equal(sent, 0);
    return { original, current, sent };
  };
  for (const taskId of taskIds) {
    await barrier('arm', taskId);
    const task = await get(client, taskId);
    await client.request({
      kind: 'participation-decision',
      taskId,
      questionId: task.execution.question.id,
      operation: 'approve',
    });
  }
  report.reserved = await waitFor(async () => {
    const { waits } = await client.request({ kind: 'validation-barrier', control: { action: 'status' } });
    return taskIds.every(id => waits.some(w => w.key === point + ':' + id && w.reached)) && waits;
  }, 20000);
  const oldStop = gate.state(stoppedId);
  const oldBlocked = gate.state(blockedId);
  assert.equal(published().length, 1);
  report.reader = { events: [] };
  spend('faults');
  const reader = spawn('/usr/bin/python3', ['scripts/takeover-storage-reader.py', path.join(data, 'workspace.sqlite')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  report.reader.pid = reader.pid;
  const readerExited = once(reader, 'exit');
  void readerExited.catch(() => {});
  reader.stdin.on('error', error => { report.reader.stdinError = error.code; });
  reader.stderr.on('data', chunk => { report.reader.error = (report.reader.error ?? '') + chunk; });
  createInterface({ input: reader.stdout }).on('line', line => {
    report.reader.events.push(JSON.parse(line));
  });
  const stage = name => waitFor(() => report.reader.events.find(e => e.stage === name), 3500);
  let stop;
  try {
    await stage('reader-held');
    stop = client.request(command('execution-intent', { taskId: stoppedId, intent: 'stop' }));
    void stop.catch(() => {});
    const waiting = await stage('writer-waiting');
    const task = await get(client, stoppedId);
    check('SQLite 写入实际等待期间停止先撤销原生资格，旧回调零派发', () => {
      assert(waiting.independentReaderBusy);
      assert.equal(task.execution.intent, 'automatic');
      assert.equal(task.executionControl.blocked, true);
      assert.equal(task.executionControl.stopSaved, false);
      report.immediateStop = { control: task.executionControl, denial: denied(stoppedId, oldStop) };
    });
    await barrier('release', stoppedId);
    assert.equal(published().length, 1);
  } finally {
    reader.stdin.end('release\n');
    report.reader.exit = await readerExited;
  }
  assert.deepEqual(report.reader.exit, [0, null]);
  assert(!report.reader.events.some(e => e.stage === 'expired'));
  await stop;
  assert.equal((await get(client, stoppedId)).execution.intent, 'stopped');

  const draft = command('draft', { taskId: completed, text: '保存故障恢复后的原请求' });
  const permissions = fs.statSync(data).mode & 0o777;
  spend('faults');
  fs.chmodSync(data, 0o500);
  try {
    await assert.rejects(client.request(draft), /STORAGE_UNAVAILABLE/);
    const blocked = await waitFor(async () => {
      const task = await get(client, blockedId);
      return task.executionControl?.blocked && task;
    }, 5000);
    check('关键保存失败阻断另一项在途发布，保留原资料、确认和已停止任务', () => {
      assert.equal(blocked.execution.publicationChecks?.length ?? 0, 0);
      assert(blocked.execution.publication.approvalId);
      assert.equal(blocked.execution.actions.at(-1).dispatchState, 'not-dispatched');
      assert.equal(published().length, 1);
      report.storageFailure = { code: 'STORAGE_UNAVAILABLE', denial: denied(blockedId, oldBlocked) };
    });
    await barrier('release', blockedId);
  } finally {
    fs.chmodSync(data, permissions);
  }
  await assert.rejects(client.request(draft), /STORAGE_UNAVAILABLE/);
  await client.request({ kind: 'storage-recheck' });
  await client.request(draft);
  report.beforeCold = await client.request({ kind: 'snapshot' });
  check('恢复可写后需明确检查，原保存请求可继续，旧发布未恢复派发', () => {
    const task = report.beforeCold.tasks.find(t => t.id === completed);
    assert.equal(task.draft, draft.text);
    assert.equal(task.execution.phase, 'complete');
    assert.equal(task.execution.publicationChecks[0].status, 'verified');
    assert.equal(report.beforeCold.tasks.find(t => t.id === blockedId).execution.pauseReason, 'record-unavailable');
    assert.equal(published().length, 1);
  });
  await client.quit();
  assert.deepEqual(remainingOwned(), []);
  const reopened = await launch();
  report.afterCold = await reopened.request({ kind: 'snapshot' });
  check('冷开后原发布、较新停止及记录故障暂停仍可核对', () => {
    assert.equal(report.afterCold.tasks.find(t => t.id === stoppedId).execution.intent, 'stopped');
    assert.equal(report.afterCold.tasks.find(t => t.id === blockedId).execution.pauseReason, 'record-unavailable');
    assert.equal(report.afterCold.tasks.find(t => t.id === completed).draft, draft.text);
    assert.equal(published().length, 1);
  });
  await reopened.quit();
}
