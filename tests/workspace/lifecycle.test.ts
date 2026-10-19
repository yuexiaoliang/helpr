import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import type { NextStep } from '../../app/shared/execution';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function workspace() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-lifecycle-'));
  folders.push(folder);
  return new WorkspaceRecords(folder, 'app/records/migrations');
}
function task(records: WorkspaceRecords, name: string) {
  const taskId = records.execute({
    kind: 'create',
    requestId: name,
    goal: `核对 https://example.com/${name}`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: `${name}-page`,
    taskId,
    url: `https://example.com/${name}`,
    phase: 'manual',
  });
  records.execution({
    kind: 'intent',
    taskId,
    requestId: `${name}-start`,
    intent: 'start',
  });
  return taskId;
}
async function until(ready: () => boolean) {
  const end = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > end) throw Error('WAIT_EXPIRED');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
function fixture(
  records: WorkspaceRecords,
  options: {
    records?: (command: unknown) => Promise<unknown>;
    propose?: () => Promise<NextStep>;
    input?: ConstructorParameters<typeof ExecutionService>[0]['input'];
  } = {},
) {
  let state = records.snapshot();
  const service = new ExecutionService({
    records:
      options.records ??
      ((command) => Promise.resolve(records.execution(command))),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: (taskId) =>
      Promise.resolve({
        observation: {
          url: state.tasks.find((t) => t.id === taskId)!.url,
          title: '页面',
          text: '本次完成',
          fingerprint: 'same',
          generation: 1,
          observedAt: 1,
          truncated: false,
        },
        binding: { targetId: taskId, generation: 1 },
      }),
    propose:
      options.propose ??
      (() =>
        Promise.resolve({
          decision: 'complete',
          summary: '完成',
          evidence: ['本次完成'],
          previous: null,
          action: null,
        })),
    perform: () => Promise.reject(Error('UNEXPECTED_WRITE')),
    revoke: () => {},
    stopModels: () => {},
    input: options.input,
  });
  return { service, current: () => state };
}

test('系统恢复保留接管、输入未知和待参与，不把它们转换为自动恢复', async () => {
  const records = workspace();
  const a = task(records, 'A'),
    b = task(records, 'B'),
    c = task(records, 'C');
  records.execution({
    kind: 'suspend',
    taskId: a,
    requestId: 'takeover',
    reason: 'takeover',
  });
  records.execution({
    kind: 'suspend',
    taskId: b,
    requestId: 'ownership',
    reason: 'ownership-unknown',
  });
  records.execution({ kind: 'claim', taskId: c, runId: 'waiting' });
  records.execution({
    kind: 'finish',
    taskId: c,
    runId: 'waiting',
    phase: 'unknown',
    summary: '等待原参与信息',
  });
  const { service, current } = fixture(records);
  try {
    await service.setSystemCondition('sleeping', true);
    await service.setSystemCondition('sleeping', false);
    await service.settled();
    expect(current().tasks.map((t) => t.execution)).toMatchObject([
      { phase: 'paused', pauseReason: 'takeover' },
      { phase: 'paused', pauseReason: 'ownership-unknown' },
      { phase: 'unknown' },
    ]);
    expect(current().tasks.every((t) => !t.execution?.recoveryPending)).toBe(
      true,
    );
  } finally {
    await service.stopAll();
    records.close();
  }
});

test('系统检查点保存失败时，解除锁屏仍阻断派发并保留原任务', async () => {
  const records = workspace();
  task(records, 'A');
  let requests = 0;
  const { service, current } = fixture(records, {
    records: (command) =>
      (command as { kind: string }).kind === 'system-interrupt'
        ? Promise.reject(Error('RECORDS_UNAVAILABLE'))
        : Promise.resolve(records.execution(command)),
    propose: () => {
      requests++;
      return Promise.resolve({
        decision: 'complete',
        summary: '完成',
        evidence: ['本次完成'],
        previous: null,
        action: null,
      });
    },
  });
  try {
    await expect(
      service.setSystemCondition('screen-locked', true),
    ).rejects.toThrow('RECORDS_UNAVAILABLE');
    await service.setSystemCondition('screen-locked', false);
    service.refresh();
    await service.settled();
    expect(requests).toBe(0);
    expect(
      service.decorate(current()).tasks[0]?.executionControl?.blocked,
    ).toBe(true);
  } finally {
    await service.stopAll();
    records.close();
  }
});

test('系统中断保存原活动任务的核对检查点，原停止保持，旧执行不能派发', () => {
  const records = workspace();
  try {
    const a = task(records, 'A'),
      b = task(records, 'B');
    records.execution({ kind: 'claim', taskId: a, runId: 'old-a' });
    records.execution({
      kind: 'intent',
      taskId: b,
      requestId: 'stop-b',
      intent: 'stop',
    });
    for (const taskId of [a, b]) {
      const execution = records
        .snapshot()
        .tasks.find((t) => t.id === taskId)!.execution!;
      records.execution({
        kind: 'system-interrupt',
        taskId,
        expectedVersion: execution.version,
      });
    }
    expect(records.snapshot().tasks.map((t) => t.execution)).toMatchObject([
      {
        intent: 'automatic',
        phase: 'queued',
        runId: null,
        recoveryPending: true,
      },
      { intent: 'stopped', phase: 'stopped' },
    ]);
    expect(
      records.execution({ kind: 'claim', taskId: a, runId: 'before-recheck' }),
    ).toMatchObject({ claimed: false });
    expect(
      records.execution({
        kind: 'dispatch',
        taskId: a,
        runId: 'old-a',
        id: 'old',
      }),
    ).toMatchObject({ permitted: false });
  } finally {
    records.close();
  }
});

test('锁屏和休眠独立阻断，全部条件解除后才核对原活动任务，重复通知不重复核对', async () => {
  const records = workspace();
  task(records, 'A');
  task(records, 'B');
  let state = records.snapshot(),
    observations = 0;
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: (taskId) => {
      observations++;
      return Promise.resolve({
        observation: {
          url: state.tasks.find((t) => t.id === taskId)!.url,
          title: '核对',
          text: '已核对完成',
          fingerprint: 'same',
          generation: 1,
          observedAt: 1,
          truncated: false,
        },
        binding: { targetId: taskId, generation: 1 },
      });
    },
    propose: () =>
      Promise.resolve({
        decision: 'complete',
        summary: '完成',
        evidence: ['已核对完成'],
        previous: null,
        action: null,
      }),
    perform: () => Promise.reject(Error('UNEXPECTED_WRITE')),
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await service.setSystemCondition('screen-locked', true);
    await service.setSystemCondition('sleeping', true);
    await service.setSystemCondition('screen-locked', false);
    service.refresh();
    await service.settled();
    expect(observations).toBe(0);
    expect(service.decorate(state).runtime?.conditions).toEqual(['sleeping']);
    expect(service.decorate(state).tasks[0]?.executionControl).toMatchObject({
      blocked: true,
      system: true,
    });
    await service.setSystemCondition('screen-locked', false);
    await service.setSystemCondition('sleeping', false);
    await service.settled();
    expect(observations).toBe(2);
    expect(state.tasks.map((t) => t.execution?.phase)).toEqual([
      'complete',
      'complete',
    ]);
    await service.setSystemCondition('sleeping', false);
    await service.settled();
    expect(observations).toBe(2);
  } finally {
    await service.stopAll();
    records.close();
  }
});

test('领取已提交但回执在锁屏后才到达，解锁仍重新核对，不能遗失活动任务', async () => {
  const records = workspace();
  task(records, 'A');
  let release: (() => void) | undefined,
    delayed = false;
  const { service, current } = fixture(records, {
    records: async (command) => {
      const result = records.execution(command);
      if ((command as { kind: string }).kind === 'claim' && !delayed) {
        delayed = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return result;
    },
  });
  try {
    service.refresh();
    await until(() => !!release);
    await service.setSystemCondition('screen-locked', true);
    await service.setSystemCondition('screen-locked', false);
    release!();
    await service.settled();
    expect(current().tasks[0]?.execution).toMatchObject({ phase: 'complete' });
  } finally {
    release?.();
    await service.stopAll();
    records.close();
  }
});

test('继续的原生准备期间锁屏，迟到准备不能重新开放资格，解锁后仍先核对', async () => {
  const records = workspace(),
    a = task(records, 'A');
  let release: (() => void) | undefined,
    first = true,
    allowed = 0;
  const { service, current } = fixture(records, {
    input: {
      prepare: async () => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return 1;
      },
      block: () => {},
      allow: () => {
        allowed++;
        return true;
      },
      epoch: () => 1,
      valid: () => true,
      permit: (_id, _epoch, send) => send(),
    },
  });
  try {
    const continuing = service.intent({
      kind: 'execution-intent',
      taskId: a,
      requestId: 'continue-a',
      intent: 'continue',
    });
    await until(() => !!release);
    await service.setSystemCondition('screen-locked', true);
    release!();
    await continuing;
    expect(allowed).toBe(0);
    expect(current().tasks[0]?.execution).toMatchObject({
      phase: 'queued',
      recoveryPending: true,
    });
    await service.setSystemCondition('screen-locked', false);
    await service.settled();
    expect(current().tasks[0]?.execution?.phase).toBe('complete');
  } finally {
    release?.();
    await service.stopAll();
    records.close();
  }
});
