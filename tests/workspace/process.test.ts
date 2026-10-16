import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessClient } from '../../app/shared/rpc';
import { snapshotSchema } from '../../app/shared/contracts';

const folders: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  children.forEach((child) => child.kill());
  folders.forEach((folder) => {
    chmodSync(folder, 0o700);
    rmSync(folder, { recursive: true, force: true });
  });
  children.length = folders.length = 0;
});
async function open(folder: string) {
  const child = fork(
    'dist/main/records.cjs',
    [folder, path.resolve('app/records/migrations')],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  children.push(child);
  const client = new ProcessClient({
    send: (message) => {
      child.send(message as object);
    },
    listen: (listener) => child.on('message', listener),
    onExit: (listener) => child.once('exit', listener),
  });
  await new Promise<void>((resolve, reject) => {
    child.on('message', (input) => {
      if ((input as { ready?: boolean }).ready) resolve();
    });
    child.once('exit', () => reject(new Error('RECORDS_EXITED')));
  });
  return {
    client,
    close: async () => {
      await client.request({ kind: 'close' });
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    },
  };
}
function folder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'helpr-process-'));
  folders.push(dir);
  return dir;
}
test('丢失创建回执后重开另一进程重试，仍只有原任务且不同内容被拒绝', async () => {
  const dir = folder();
  let records = await open(dir);
  const command = {
    kind: 'create',
    requestId: 'one-delegation',
    goal: '查看 https://example.com/report',
  };
  const first = (await records.client.request(command)) as { taskId: string };
  await records.close();
  records = await open(dir);
  const retry = (await records.client.request(command)) as { taskId: string };
  expect(retry.taskId).toBe(first.taskId);
  await expect(
    records.client.request({ ...command, goal: '另一项工作' }),
  ).rejects.toThrow('REQUEST_CONTENT_CONFLICT');
  expect(
    snapshotSchema.parse(await records.client.request({ kind: 'snapshot' }))
      .tasks,
  ).toHaveLength(1);
  await records.close();
});
test('危险地址、旧版本与实际保存失败均保留已有资料，恢复保存后可重试', async () => {
  const dir = folder();
  const records = await open(dir);
  const first = (await records.client.request({
    kind: 'create',
    requestId: 'a',
    goal: '查看 https://example.com/report',
  })) as { taskId: string };
  await records.client.request({
    kind: 'draft',
    requestId: 'draft',
    taskId: first.taskId,
    text: '先前已保存的草稿',
  });
  await expect(
    records.client.request({
      kind: 'navigate',
      requestId: 'unsafe',
      taskId: first.taskId,
      url: 'file:///etc/passwd',
    }),
  ).rejects.toThrow('INVALID_REQUEST');
  await expect(
    records.client.request({
      kind: 'draft',
      requestId: 'old',
      taskId: first.taskId,
      expectedVersion: 1,
      text: '旧回复',
    }),
  ).rejects.toThrow('RECORD_VERSION_CONFLICT');
  chmodSync(dir, 0o500);
  const change = {
    kind: 'draft',
    requestId: 'failed',
    taskId: first.taskId,
    text: '准备重试的草稿',
  };
  await expect(records.client.request(change)).rejects.toThrow();
  expect(
    snapshotSchema.parse(await records.client.request({ kind: 'snapshot' }))
      .tasks[0]?.draft,
  ).toBe('先前已保存的草稿');
  chmodSync(dir, 0o700);
  await records.client.request(change);
  expect(
    snapshotSchema.parse(await records.client.request({ kind: 'snapshot' }))
      .tasks[0]?.draft,
  ).toBe('准备重试的草稿');
  await records.close();
});

test('执行停止与请求身份跨记录进程保留，旧派发不能在重开后消费', async () => {
  const dir = folder();
  let records = await open(dir);
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'create',
    goal: '核对 https://example.com/list',
  })) as { taskId: string };
  await records.client.request({
    kind: 'page',
    requestId: 'ready',
    taskId,
    url: 'https://example.com/list',
    phase: 'manual',
  });
  const execution = (command: unknown) =>
    records.client.request({ kind: 'execution', command });
  await execution({
    kind: 'intent',
    requestId: 'start',
    taskId,
    intent: 'start',
  });
  await execution({ kind: 'claim', taskId, runId: 'old' });
  await execution({
    kind: 'reserve',
    taskId,
    runId: 'old',
    id: 'action',
    summary: '核对第一项',
    action: { kind: 'click', target: { role: 'button', name: '核对第一项' } },
    source: {
      url: 'https://example.com/list',
      title: '清单',
      text: '核对第一项',
      fingerprint: 'one',
      generation: 1,
      observedAt: 1,
      truncated: false,
    },
    binding: { targetId: 'page-a', generation: 1 },
  });
  const stop = {
    kind: 'intent',
    requestId: 'stop',
    taskId,
    intent: 'stop',
    expectedVersion: 2,
  };
  await execution(stop);
  await records.close();
  records = await open(dir);
  expect(await execution(stop)).toMatchObject({ created: false });
  await expect(execution({ ...stop, intent: 'continue' })).rejects.toThrow(
    'REQUEST_CONTENT_CONFLICT',
  );
  expect(
    await execution({ kind: 'dispatch', taskId, runId: 'old', id: 'action' }),
  ).toMatchObject({ permitted: false });
  const state = snapshotSchema.parse(
    await records.client.request({ kind: 'snapshot' }),
  );
  expect(state.tasks[0]?.execution).toMatchObject({
    intent: 'stopped',
    phase: 'stopped',
    actions: [{ status: 'cancelled' }],
  });
  await expect(
    execution({
      kind: 'intent',
      requestId: 'stale',
      taskId,
      intent: 'continue',
      expectedVersion: 2,
    }),
  ).rejects.toThrow('RECORD_VERSION_CONFLICT');
  await records.close();
});
