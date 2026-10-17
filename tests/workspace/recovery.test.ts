import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { createServer } from 'node:http';
import { ExecutionService } from '../../app/desktop/execution-service';
import { WorkspaceSession } from '../../app/desktop/workspace-session';

const folders: string[] = [];
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true })),
);
function folder() {
  const value = mkdtempSync(path.join(tmpdir(), 'helpr-recovery-'));
  folders.push(value);
  return value;
}
function task(
  records: WorkspaceRecords,
  name: string,
  url = `https://example.com/${name}`,
) {
  const taskId = records.execute({
    kind: 'create',
    requestId: name,
    goal: `核对 ${name} ${url}`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: name + '-page',
    taskId,
    url,
    phase: 'manual',
  });
  records.execution({
    kind: 'intent',
    requestId: name + '-start',
    taskId,
    intent: 'start',
  });
  return taskId;
}

test('冷重开只给原活动任务安排恢复核对，停止、接管和待参与保持，旧执行不再派发', () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  records.execution({ kind: 'claim', taskId: a, runId: 'old-a' });
  const b = task(records, 'B');
  records.execution({
    kind: 'intent',
    taskId: b,
    requestId: 'stop-b',
    intent: 'stop',
  });
  const c = task(records, 'C');
  records.execution({
    kind: 'suspend',
    taskId: c,
    requestId: 'takeover-c',
    reason: 'takeover',
  });
  const d = task(records, 'D');
  records.execution({ kind: 'claim', taskId: d, runId: 'old-d' });
  records.execution({
    kind: 'finish',
    taskId: d,
    runId: 'old-d',
    phase: 'unknown',
    summary: '等待补充信息，不可推定已有结果。',
  });
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  try {
    expect(records.snapshot().tasks.map((t) => t.execution)).toMatchObject([
      {
        intent: 'automatic',
        phase: 'queued',
        recoveryPending: true,
        runId: null,
      },
      { intent: 'stopped', phase: 'stopped' },
      { intent: 'automatic', phase: 'paused', pauseReason: 'takeover' },
      { intent: 'automatic', phase: 'unknown' },
    ]);
    expect(
      records.execution({
        kind: 'dispatch',
        taskId: a,
        runId: 'old-a',
        id: 'old-action',
      }),
    ).toMatchObject({ permitted: false });
    expect(
      records.execution({
        kind: 'claim',
        taskId: a,
        runId: 'new-before-check',
      }),
    ).toMatchObject({ claimed: false });
  } finally {
    records.close();
  }
});

test('效果已发生但本机未记账，冷重开自动只读核实完成而不重复写入', async () => {
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') writes++;
    res.end(writes ? 'A备注已写入，核对码 ONE' : 'A备注待写入');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_PORT');
  const url = `http://127.0.0.1:${address.port}/A`;
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A', url);
  records.execution({ kind: 'claim', taskId: a, runId: 'old' });
  const source = {
    url,
    title: 'A记录',
    text: 'A备注待写入',
    fingerprint: 'before',
    generation: 1,
    observedAt: 1,
    truncated: false,
  };
  records.execution({
    kind: 'reserve',
    taskId: a,
    runId: 'old',
    id: 'old-action',
    summary: '写入备注',
    action: { kind: 'click', target: { role: 'button', name: '写入备注' } },
    source,
    binding: { targetId: 'old-page', generation: 1 },
  });
  records.execution({
    kind: 'dispatch',
    taskId: a,
    runId: 'old',
    id: 'old-action',
  });
  await fetch(url, { method: 'POST' });
  // 不登记效果回执，结束记录拥有者；网页效果是独立 HTTP 服务的事实。
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  let state = records.snapshot();
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: async () => ({
      observation: {
        ...source,
        generation: 2,
        text: await (await fetch(url)).text(),
        fingerprint: 'after',
      },
      binding: { targetId: 'new-page', generation: 2 },
    }),
    propose: (input) =>
      Promise.resolve({
        decision: 'complete',
        summary: '本次备注已核对完成',
        evidence: ['A备注已写入，核对码 ONE'],
        previous: input.pending
          ? {
              id: input.pending.id,
              status: 'confirmed',
              evidence: ['A备注已写入，核对码 ONE'],
            }
          : null,
        action: null,
      }),
    perform: async () => {
      await fetch(url, { method: 'POST' });
    },
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    service.refresh();
    await service.settled();
    expect(state.tasks[0]?.execution).toMatchObject({
      phase: 'complete',
      actions: [{ status: 'confirmed' }],
    });
    expect(writes).toBe(1);
  } finally {
    service.disable();
    records.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('可靠的未派发检查点在冷重开后只允许新的剩余动作，原预留不能再次消费', () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  records.execution({ kind: 'claim', taskId: a, runId: 'old' });
  const source = {
    url: 'https://example.com/A',
    title: 'A记录',
    text: 'A备注待写入',
    fingerprint: 'before',
    generation: 1,
    observedAt: 1,
    truncated: false,
  };
  const reserve = {
    kind: 'reserve',
    taskId: a,
    runId: 'old',
    id: 'not-sent',
    summary: '写入备注',
    action: { kind: 'click', target: { role: 'button', name: '写入备注' } },
    source,
    binding: { targetId: 'old-page', generation: 1 },
  };
  records.execution(reserve);
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  try {
    expect(records.snapshot().tasks[0]?.execution?.actions).toMatchObject([
      { id: 'not-sent', status: 'cancelled', dispatchState: 'not-dispatched' },
    ]);
    const version = records.snapshot().tasks[0]!.execution!.version;
    records.execution({ kind: 'recover', taskId: a, expectedVersion: version });
    records.execution({ kind: 'claim', taskId: a, runId: 'new' });
    expect(
      records.execution({
        kind: 'dispatch',
        taskId: a,
        runId: 'old',
        id: 'not-sent',
      }).permitted,
    ).toBe(false);
    records.execution({ ...reserve, runId: 'new', id: 'remaining' });
    expect(
      records.execution({
        kind: 'dispatch',
        taskId: a,
        runId: 'new',
        id: 'remaining',
      }).permitted,
    ).toBe(true);
  } finally {
    records.close();
  }
});

test('已经初始化的资料丢失数据库时保留现场并报错，不自动生成空白任务库', () => {
  const dir = folder();
  const records = new WorkspaceRecords(dir, 'app/records/migrations');
  task(records, 'A');
  records.close();
  const file = path.join(dir, 'workspace.sqlite');
  rmSync(file);
  expect(() => new WorkspaceRecords(dir, 'app/records/migrations')).toThrow(
    'DATA_MISSING',
  );
  expect(existsSync(file)).toBe(false);
});

test('已经初始化的数据库被截空时保持原字节并拒绝创建新空库', () => {
  const dir = folder(),
    records = new WorkspaceRecords(dir, 'app/records/migrations');
  task(records, 'A');
  records.close();
  const file = path.join(dir, 'workspace.sqlite');
  writeFileSync(file, '');
  expect(() => new WorkspaceRecords(dir, 'app/records/migrations')).toThrow(
    'DATA_CORRUPT',
  );
  expect(readFileSync(file)).toEqual(Buffer.alloc(0));
});

test('不认识的状态模型保留原库字节并明确拒绝恢复', () => {
  const dir = folder();
  const records = new WorkspaceRecords(dir, 'app/records/migrations');
  task(records, 'A');
  records.close();
  const file = path.join(dir, 'workspace.sqlite');
  const fixture = new Database(file);
  fixture
    .prepare(
      "UPDATE task_executions SET body=json_set(body,'$.modelVersion',9)",
    )
    .run();
  fixture.close();
  const original = readFileSync(file);
  expect(() => new WorkspaceRecords(dir, 'app/records/migrations')).toThrow(
    'STATE_MODEL_UNSUPPORTED',
  );
  expect(readFileSync(file)).toEqual(original);
});

test('重建网页转到另一目标时暂停并保留原目标，不能把新页面当成恢复依据', () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  try {
    const version = records.snapshot().tasks[0]!.execution!.version;
    records.execute({
      kind: 'page',
      requestId: 'redirect',
      taskId: a,
      url: 'https://example.com/other-target',
      phase: 'manual',
    });
    expect(
      records.execution({
        kind: 'recover',
        taskId: a,
        expectedVersion: version,
      }),
    ).toMatchObject({ recovered: false });
    expect(records.snapshot().tasks[0]?.execution).toMatchObject({
      phase: 'paused',
      pauseReason: 'page-change',
      goal: '核对 A https://example.com/A',
    });
  } finally {
    records.close();
  }
});

test('停止已提交但回执丢失，记录服务重新连接后核对可靠停止，不留伪造的未保存状态', async () => {
  const dir = folder();
  const records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  let state = records.snapshot();
  const service = new ExecutionService({
    records: (command) => {
      records.execution(command);
      return Promise.reject(Error('PROCESS_DISCONNECTED'));
    },
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () => Promise.reject(Error('NO_PAGE')),
    propose: () => Promise.reject(Error('NO_MODEL')),
    perform: () => Promise.reject(Error('NO_WRITE')),
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await expect(
      service.intent({
        kind: 'execution-intent',
        requestId: 'stop',
        taskId: a,
        intent: 'stop',
      }),
    ).rejects.toThrow('PROCESS_DISCONNECTED');
    expect(service.decorate(state).tasks[0]?.executionControl?.stopSaved).toBe(
      false,
    );
    service.recordsRestored(records.snapshot());
    await service.settled();
    expect(service.decorate(state).tasks[0]).toMatchObject({
      execution: { intent: 'stopped', phase: 'stopped' },
      executionControl: { blocked: true, stopSaved: true },
    });
  } finally {
    service.disable();
    records.close();
  }
});

test('自动恢复仍在等待页面资格时收到新停止，迟到就绪不能恢复写操作', async () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  let state = records.snapshot(),
    release: () => void = () => {},
    entered: () => void = () => {};
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const hold = new Promise<number>((r) => {
    release = () => r(1);
  });
  const effects: string[] = [];
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () => {
      effects.push('observe');
      return Promise.reject(Error('SHOULD_NOT_OBSERVE'));
    },
    propose: () => Promise.reject(Error('NO_MODEL')),
    perform: () => {
      effects.push('write');
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
    input: {
      prepare: () => {
        entered();
        return hold;
      },
      block: () => {},
      allow: () => true,
      epoch: () => 1,
      valid: () => true,
      permit: (_id, _epoch, send) => send(),
    },
  });
  try {
    service.refresh();
    await ready;
    await service.intent({
      kind: 'execution-intent',
      requestId: 'new-stop',
      taskId: a,
      intent: 'stop',
    });
    release();
    await service.settled();
    expect(state.tasks[0]?.execution).toMatchObject({
      intent: 'stopped',
      phase: 'stopped',
    });
    expect(effects).toEqual([]);
  } finally {
    release();
    service.disable();
    await service.settled();
    records.close();
  }
});

test('旧预留缺少未派发证明时只读核对，未知结果不能被下一步动作绕过', async () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  records.execution({ kind: 'claim', taskId: a, runId: 'old' });
  const source = {
    url: 'https://example.com/A',
    title: 'A记录',
    text: 'A备注待写入',
    fingerprint: 'before',
    generation: 1,
    observedAt: 1,
    truncated: false,
  };
  records.execution({
    kind: 'reserve',
    taskId: a,
    runId: 'old',
    id: 'old-reserve',
    summary: '写备注',
    action: { kind: 'click', target: { role: 'button', name: '写备注' } },
    source,
    binding: { targetId: 'old-page', generation: 1 },
  });
  records.close();
  // 旧格式外部输入：仅有预留，没有当前格式的未派发证明。
  const fixture = new Database(path.join(dir, 'workspace.sqlite'));
  fixture
    .prepare(
      "UPDATE task_executions SET body=json_remove(body,'$.actions[0].dispatchState')",
    )
    .run();
  fixture.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  let state = records.snapshot();
  const effects: string[] = [];
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () =>
      Promise.resolve({
        observation: source,
        binding: { targetId: 'new-page', generation: 1 },
      }),
    propose: (input) =>
      Promise.resolve({
        decision: 'act',
        summary: '想再次写入',
        evidence: ['A备注待写入'],
        previous: {
          id: input.pending!.id,
          status: 'unknown',
          evidence: ['A备注待写入'],
        },
        action: {
          kind: 'click',
          target: { role: 'button', name: '写备注', exact: true },
        },
      }),
    perform: () => {
      effects.push('write');
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    service.refresh();
    await service.settled();
    expect(state.tasks[0]?.execution).toMatchObject({
      phase: 'unknown',
      actions: [{ status: 'unknown' }],
    });
    expect(effects).toEqual([]);
  } finally {
    service.disable();
    records.close();
  }
});

test('退出时只冻结派发，不伪造用户停止或尚未保存的停止', async () => {
  const dir = folder(),
    records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  let state = records.snapshot();
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () => Promise.reject(Error('NO_PAGE')),
    propose: () => Promise.reject(Error('NO_MODEL')),
    perform: () => Promise.reject(Error('NO_WRITE')),
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await service.stopAll();
    expect(service.canExit()).toBe(true);
    expect(service.decorate(state).tasks[0]).toMatchObject({
      execution: { intent: 'automatic' },
      executionControl: { blocked: true, stopSaved: true },
    });
    expect(state.tasks[0]?.id).toBe(a);
  } finally {
    records.close();
  }
});

test('新目标保存未提交时记录重连仍阻断旧目标，不能因旧资料可读而自动写入', async () => {
  const dir = folder();
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  const a = task(records, 'A');
  let state = records.snapshot(),
    writes = 0;
  const workspace = new WorkspaceSession(
    state,
    (command) => {
      if ((command as { kind: string }).kind === 'navigate')
        return Promise.reject(Error('PROCESS_DISCONNECTED'));
      const original = (command as { command: unknown }).command;
      return Promise.resolve(records.lookupRequest(original));
    },
    (next) => {
      state = next;
    },
  );
  await expect(
    workspace.save({
      kind: 'navigate',
      requestId: 'new-target',
      taskId: a,
      url: 'https://example.com/B',
    }),
  ).rejects.toThrow('PROCESS_DISCONNECTED');
  records.close();
  records = new WorkspaceRecords(dir, 'app/records/migrations');
  state = records.snapshot();
  const source = {
    url: 'https://example.com/A',
    title: 'A记录',
    fingerprint: 'A',
    generation: 1,
    observedAt: 1,
    truncated: false,
  };
  const service = new ExecutionService({
    records: (command) => Promise.resolve(records.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () =>
      Promise.resolve({
        observation: { ...source, text: writes ? 'A已完成' : 'A待处理' },
        binding: { targetId: 'A', generation: 1 },
      }),
    propose: (input) =>
      Promise.resolve({
        decision: writes ? 'complete' : 'act',
        summary: '处理A',
        evidence: [input.observation.text],
        previous: input.pending
          ? {
              id: input.pending.id,
              status: 'confirmed',
              evidence: [input.observation.text],
            }
          : null,
        action: writes
          ? null
          : {
              kind: 'click',
              target: { role: 'button', name: '处理A', exact: true },
            },
      }),
    perform: () => {
      writes++;
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await workspace.reconcileCommitted();
    service.recordsRestored(state, [a]);
    await service.settled();
    expect(writes).toBe(0);
    expect(workspace.canExit()).toBe(false);
    expect(service.decorate(state).tasks[0]?.executionControl?.blocked).toBe(
      true,
    );
  } finally {
    service.disable();
    records.close();
  }
});
