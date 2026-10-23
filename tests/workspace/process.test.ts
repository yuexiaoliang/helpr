import { afterEach, expect, test } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  readFileSync,
  mkdirSync,
  watch,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessClient } from '../../app/shared/rpc';
import { snapshotSchema } from '../../app/shared/contracts';
import { validationDirectory } from '../../app/desktop/startup';

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
async function open(
  folder: string,
  dropResponse?: (input: unknown) => boolean,
) {
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
    listen: (listener) =>
      child.on('message', (input) => {
        if (!dropResponse?.(input)) listener(input);
      }),
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
    crash: async () => {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
    },
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

test('原生接管暂停在独立记录进程重开后保留，旧开始请求不能恢复执行', async () => {
  const dir = folder();
  let records = await open(dir);
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'a',
    goal: '核对 https://example.com/list',
  })) as { taskId: string };
  await records.client.request({
    kind: 'page',
    requestId: 'ready',
    taskId,
    url: 'https://example.com/list',
    phase: 'manual',
  });
  const start = { kind: 'intent', taskId, requestId: 'start', intent: 'start' };
  await records.client.request({ kind: 'execution', command: start });
  await records.client.request({
    kind: 'execution',
    command: { kind: 'claim', taskId, runId: 'old' },
  });
  await records.client.request({
    kind: 'execution',
    command: {
      kind: 'suspend',
      taskId,
      requestId: 'native',
      reason: 'takeover',
    },
  });
  await records.close();
  records = await open(dir);
  expect(
    snapshotSchema.parse(await records.client.request({ kind: 'snapshot' }))
      .tasks[0]?.execution,
  ).toMatchObject({
    intent: 'automatic',
    phase: 'paused',
    pauseReason: 'takeover',
  });
  expect(
    await records.client.request({ kind: 'execution', command: start }),
  ).toMatchObject({ created: false, current: false });
  expect(
    await records.client.request({
      kind: 'execution',
      command: { kind: 'claim', taskId, runId: 'stale' },
    }),
  ).toMatchObject({ claimed: false });
  await records.close();
});
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

test('独立记录进程通过备份入口接受并发停止，恢复与冷重开仍不派发旧工作', async () => {
  const dir = folder();
  let records = await open(dir);
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'A',
    goal: '核对 https://example.com/A',
  })) as { taskId: string };
  await records.client.request({
    kind: 'execution',
    command: { kind: 'intent', requestId: 'start', taskId, intent: 'start' },
  });
  const file = path.join(dir, 'snapshot.helpr-backup');
  const creating = records.client.request({
    kind: 'backup',
    command: { kind: 'create', requestId: 'backup', file },
  });
  await records.client.request({
    kind: 'execution',
    command: { kind: 'intent', requestId: 'stop', taskId, intent: 'stop' },
  });
  const { archive } = (await creating) as { archive: { checksum: string } };
  await records.client.request({
    kind: 'backup',
    command: {
      kind: 'restore',
      requestId: 'restore',
      file,
      checksum: archive.checksum,
    },
  });
  await records.close();
  records = await open(dir);
  const state = snapshotSchema.parse(
    await records.client.request({ kind: 'snapshot' }),
  );
  expect(state.tasks[0]?.execution).toMatchObject({
    intent: 'stopped',
    intentId: 'stop',
    restoreReview: 'required',
  });
  expect(
    await records.client.request({
      kind: 'execution',
      command: { kind: 'claim', taskId, runId: 'old' },
    }),
  ).toMatchObject({ claimed: false });
  await records.close();
});
test('实际备份回执在 IPC 边界丢失，记录进程终止后仍按原身份返回原文件', async () => {
  const dir = folder();
  let dropped = 0;
  let records = await open(dir, (input) => {
    const matched = Boolean(
      input &&
      typeof input === 'object' &&
      'value' in input &&
      input.value &&
      typeof input.value === 'object' &&
      'archive' in input.value,
    );
    if (matched) dropped++;
    return matched;
  });
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'A',
    goal: '回执丢失前的任务',
  })) as { taskId: string };
  const command = {
    kind: 'backup',
    command: {
      kind: 'create',
      requestId: 'original-backup',
      file: path.join(dir, 'original.helpr-backup'),
    },
  };
  await expect(records.client.request(command, 1000)).rejects.toThrow(
    'REQUEST_TIMEOUT',
  );
  expect(dropped).toBe(1);
  const original = readFileSync(command.command.file, 'utf8');
  await records.client.request({
    kind: 'draft',
    requestId: 'later',
    taskId,
    text: '备份后的草稿',
  });
  await records.crash();
  records = await open(dir);
  expect(await records.client.request(command)).toMatchObject({
    archive: { id: 'original-backup', tasks: 1 },
  });
  expect(readFileSync(command.command.file, 'utf8')).toBe(original);
  expect(original).not.toContain('备份后的草稿');
  expect(
    snapshotSchema.parse(await records.client.request({ kind: 'snapshot' }))
      .tasks[0]?.draft,
  ).toBe('备份后的草稿');
  await records.close();
});

test('恢复保留副本写入阶段终止记录进程，重开核对仍保留新停止和原恢复身份', async () => {
  const dir = mkdtempSync(validationDirectory() + '/backup-interrupt-');
  folders.push(dir);
  let records = await open(dir);
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'A',
    goal: '原目标 https://example.com/A',
  })) as { taskId: string };
  const execution = (command: unknown) =>
    records.client.request({ kind: 'execution', command });
  await execution({
    kind: 'intent',
    requestId: 'start',
    taskId,
    intent: 'start',
  });
  const file = path.join(dir, 'old.helpr-backup');
  const saved = (await records.client.request({
    kind: 'backup',
    command: { kind: 'create', requestId: 'old', file },
  })) as { archive: { checksum: string } };
  await execution({
    kind: 'intent',
    requestId: 'stop',
    taskId,
    intent: 'stop',
  });
  await execution({
    kind: 'intent',
    requestId: 'revise',
    taskId,
    intent: 'revise',
    text: '中断后仍保留的新目标',
  });
  await execution({ kind: 'backup-pause', taskId });
  const originalVersion = snapshotSchema.parse(
    await records.client.request({ kind: 'snapshot' }),
  ).tasks[0]!.execution!.version;
  // 只读 SHARED 锁使安全副本回执无法提交；不会改产品资料，也不让切换抢先完成。
  const reader = spawn(
    'python3',
    ['scripts/takeover-storage-reader.py', path.join(dir, 'workspace.sqlite')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(reader);
  const readerExited = new Promise<void>((resolve) =>
    reader.once('exit', () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('READER_NOT_READY')), 1500);
    let output = '';
    reader.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('reader-held')) {
        clearTimeout(timer);
        resolve();
      }
    });
    reader.once('exit', () => {
      clearTimeout(timer);
      reject(Error('READER_EXITED'));
    });
  });
  const directory = path.join(dir, 'backups');
  mkdirSync(directory);
  let crash: Promise<void> | undefined;
  let observed = false;
  const watcher = watch(directory);
  const reached = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('BACKUP_WRITE_NOT_OBSERVED')),
      2000,
    );
    watcher.on('change', (_kind, name) => {
      if (!observed && name?.toString().endsWith('.partial')) {
        observed = true;
        clearTimeout(timer);
        crash = records.crash();
        resolve();
      }
    });
  });
  const command = {
    kind: 'backup',
    command: {
      kind: 'restore',
      requestId: 'same-restore',
      file,
      checksum: saved.archive.checksum,
    },
  };
  const pending = records.client.request(command).then(
    () => 'received',
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  try {
    await reached;
    await crash;
    expect(await pending).toBe('PROCESS_DISCONNECTED');
  } finally {
    watcher.close();
    reader.stdin.end('release\n');
    await readerExited;
  }
  records = await open(dir);
  const before = snapshotSchema.parse(
    await records.client.request({ kind: 'snapshot' }),
  );
  expect(before.tasks).toHaveLength(1);
  expect(before.tasks[0]?.execution?.version).toBe(originalVersion);
  expect(before.tasks[0]).toMatchObject({
    goal: '中断后仍保留的新目标',
    execution: { intent: 'stopped', restoreReview: 'required' },
  });
  const result = (await records.client.request(command)) as {
    state: unknown;
    safety: { file: string };
  };
  const restored = snapshotSchema.parse(result.state);
  expect(restored.tasks[0]).toMatchObject({
    goal: '中断后仍保留的新目标',
    execution: { intent: 'stopped', restoreReview: 'required' },
  });
  expect(readFileSync(result.safety.file, 'utf8')).toContain(
    '中断后仍保留的新目标',
  );
  const again = (await records.client.request(command)) as { state: unknown };
  expect(snapshotSchema.parse(again.state).revision).toBe(restored.revision);
  expect(
    readdirSync(directory).filter((name) => name.endsWith('.helpr-backup')),
  ).toHaveLength(1);
  expect(
    await execution({ kind: 'claim', taskId, runId: 'stale' }),
  ).toMatchObject({ claimed: false });
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

test('真实提交等待期间 draft 不提前回执，释放只读夹具后可靠保存', async () => {
  const base = validationDirectory();
  const dir = mkdtempSync(base + '/storage-reader-');
  folders.push(dir);
  const records = await open(dir);
  const { taskId } = (await records.client.request({
    kind: 'create',
    requestId: 'slow-create',
    goal: '慢提交',
  })) as { taskId: string };
  const reader = spawn(
    'python3',
    ['scripts/takeover-storage-reader.py', path.join(dir, 'workspace.sqlite')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(reader);
  let output = '',
    errors = '',
    ack = false;
  reader.stdout.on('data', (chunk) => {
    output += chunk;
  });
  reader.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const until = async (stage: string) => {
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if (output.includes(stage)) return;
      if (reader.exitCode !== null) throw Error(errors || 'READER_EXITED');
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('STORAGE_STAGE_TIMEOUT:' + stage);
  };
  let draft: Promise<unknown> | undefined;
  try {
    await until('reader-held');
    draft = records.client
      .request({
        kind: 'draft',
        requestId: 'slow-draft',
        taskId,
        text: '保留草稿',
      })
      .then((value) => {
        ack = true;
        return value;
      });
    void draft.catch(() => {});
    await until('writer-waiting');
    expect(ack).toBe(false);
    expect(output).toContain('"independentReaderBusy": true');
    reader.stdin.end('release\n');
    await draft;
    const state = snapshotSchema.parse(
      await records.client.request({ kind: 'snapshot' }),
    );
    expect(state.tasks[0]?.draft).toBe('保留草稿');
    expect(errors).toBe('');
  } finally {
    if (!reader.stdin.destroyed && !reader.stdin.writableEnded)
      reader.stdin.end('release\n');
    await draft?.catch(() => {});
    await records.close();
  }
});
