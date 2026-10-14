import { expect, test } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRecords } from '../../app/records/workspace';
import { WorkspaceSession } from '../../app/desktop/workspace-session';

test('网页保存失败阻止退出；明确取消未保存的新任务后不永久阻止退出', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-save-failure-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const session = new WorkspaceSession(
    records.snapshot(),
    (input) => {
      try {
        return Promise.resolve(
          (input as { kind: string }).kind === 'lookup'
            ? records.lookupRequest((input as { command: unknown }).command)
            : records.execute(input),
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('RECORDS_UNAVAILABLE'),
        );
      }
    },
    () => {},
  );
  try {
    const task = await session.save({
      kind: 'create',
      requestId: 'a',
      goal: '查看 https://example.com',
    });
    chmodSync(folder, 0o500);
    await expect(
      session.save({
        kind: 'page',
        requestId: 'page',
        taskId: task.taskId,
        url: 'https://example.com/next',
        phase: 'manual',
      }),
    ).rejects.toThrow();
    expect(session.canExit()).toBe(false);
    chmodSync(folder, 0o700);
    await session.save({
      kind: 'page',
      requestId: 'retry-page',
      taskId: task.taskId,
      url: 'https://example.com/next',
      phase: 'manual',
    });
    expect(session.canExit()).toBe(true);
    chmodSync(folder, 0o500);
    await expect(
      session.save({
        kind: 'create',
        requestId: 'cancelled',
        goal: '未保存的委托',
      }),
    ).rejects.toThrow();
    expect(session.canExit()).toBe(false);
    chmodSync(folder, 0o700);
    await session.cancelCreation('cancelled');
    expect(session.canExit()).toBe(true);
    expect(records.snapshot().tasks).toHaveLength(1);
  } finally {
    chmodSync(folder, 0o700);
    records.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('创建已提交但回执丢失，编辑后重试被拒绝，取消仍能核对原任务并退出', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-lost-receipt-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  let drop = true;
  const session = new WorkspaceSession(
    records.snapshot(),
    (input) => {
      try {
        if ((input as { kind: string }).kind === 'lookup')
          return Promise.resolve(
            records.lookupRequest((input as { command: unknown }).command),
          );
        const result = records.execute(input);
        if (drop) {
          drop = false;
          return Promise.reject(new Error('REQUEST_TIMEOUT'));
        }
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('RECORDS_UNAVAILABLE'),
        );
      }
    },
    () => {},
  );
  try {
    await expect(
      session.save({ kind: 'create', requestId: 'one', goal: '原目标' }),
    ).rejects.toThrow('REQUEST_TIMEOUT');
    await expect(
      session.save({ kind: 'create', requestId: 'one', goal: '修改后的目标' }),
    ).rejects.toThrow('REQUEST_CONTENT_CONFLICT');
    await session.cancelCreation('one');
    expect(session.canExit()).toBe(true);
    expect(records.snapshot().tasks.map((task) => task.goal)).toEqual([
      '原目标',
    ]);
  } finally {
    records.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
