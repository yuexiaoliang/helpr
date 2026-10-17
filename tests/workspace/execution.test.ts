import { afterAll, afterEach, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { InputGate } from '../../app/desktop/input-gate';

const folders: string[] = [];
let nativeFixture: { gate: InputGate; folder: string } | undefined;
function nativeGate() {
  // 原生模块每进程拥有一个临时门，测试中的任务仍由独立身份隔离。
  if (!nativeFixture) {
    const folder = mkdtempSync(path.join(tmpdir(), 'helpr-execution-gate-'));
    nativeFixture = {
      folder,
      gate: new InputGate(
        path.resolve('dist/native/input-bridge.node'),
        path.join(folder, 'gate'),
        true,
      ),
    };
  }
  nativeFixture.gate.available(true);
  return nativeFixture.gate;
}
afterAll(() => {
  if (nativeFixture)
    rmSync(nativeFixture.folder, { recursive: true, force: true });
});
afterEach(() =>
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);

test('停止后修正目标保持停止，明确继续才领取新执行', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-execution-'));
  folders.push(folder);
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    const taskId = records.execute({
      kind: 'create',
      requestId: 'create',
      goal: '核对列表 https://example.com/list',
    }).taskId;
    records.execute({
      kind: 'page',
      requestId: 'ready',
      taskId,
      url: 'https://example.com/list',
      phase: 'manual',
    });
    records.execution({
      kind: 'intent',
      requestId: 'start',
      taskId,
      intent: 'start',
    });
    records.execution({
      kind: 'intent',
      requestId: 'stop',
      taskId,
      intent: 'stop',
    });
    records.execution({
      kind: 'intent',
      requestId: 'revise',
      taskId,
      intent: 'revise',
      text: '只核对前两条',
    });
    expect(records.snapshot().tasks[0]?.execution).toMatchObject({
      intent: 'stopped',
      phase: 'stopped',
      goal: '只核对前两条',
    });
    expect(
      records.execution({ kind: 'claim', taskId, runId: 'old' }).claimed,
    ).toBe(false);
    records.execution({
      kind: 'intent',
      requestId: 'continue',
      taskId,
      intent: 'continue',
    });
    expect(
      records.execution({ kind: 'claim', taskId, runId: 'new' }).claimed,
    ).toBe(true);
    expect(records.snapshot().tasks[0]?.execution).toMatchObject({
      intent: 'automatic',
      phase: 'checking',
      runId: 'new',
    });
  } finally {
    records.close();
  }
});

test('一次性预留先保存后派发，停止后迟到结果不恢复，继续不消费旧预留', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-execution-'));
  folders.push(folder);
  const r = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    const taskId = r.execute({
      kind: 'create',
      requestId: 'create',
      goal: '核对 https://example.com/list',
    }).taskId;
    r.execute({
      kind: 'page',
      requestId: 'ready',
      taskId,
      url: 'https://example.com/list',
      phase: 'manual',
    });
    r.execution({
      kind: 'intent',
      requestId: 'start',
      taskId,
      intent: 'start',
    });
    r.execution({ kind: 'claim', taskId, runId: 'one' });
    const source = {
      url: 'https://example.com/list',
      title: '清单',
      fingerprint: 'before',
      generation: 1,
      observedAt: 1,
      truncated: false,
      text: 'button 核对第一项',
    };
    r.execution({
      kind: 'reserve',
      taskId,
      runId: 'one',
      id: 'action-one',
      summary: '核对第一项',
      action: { kind: 'click', target: { role: 'button', name: '核对第一项' } },
      source,
      binding: { targetId: 'page-a', generation: 1 },
    });
    expect(
      r.execution({ kind: 'dispatch', taskId, runId: 'one', id: 'action-one' })
        .permitted,
    ).toBe(true);
    expect(
      r.execution({ kind: 'dispatch', taskId, runId: 'one', id: 'action-one' })
        .permitted,
    ).toBe(false);
    r.execution({ kind: 'intent', requestId: 'stop', taskId, intent: 'stop' });
    r.execution({ kind: 'reported', taskId, id: 'action-one', returned: true });
    expect(r.snapshot().tasks[0]?.execution).toMatchObject({
      intent: 'stopped',
      phase: 'stopped',
      actions: [{ id: 'action-one', status: 'unknown', returned: true }],
    });
    r.execution({
      kind: 'intent',
      requestId: 'continue',
      taskId,
      intent: 'continue',
    });
    r.execution({ kind: 'claim', taskId, runId: 'two' });
    expect(
      r.execution({ kind: 'dispatch', taskId, runId: 'one', id: 'action-one' })
        .permitted,
    ).toBe(false);
    r.execution({
      kind: 'resolve',
      taskId,
      runId: 'two',
      id: 'action-one',
      source: { ...source, text: '第一项已核对', fingerprint: 'after' },
      evidence: ['第一项已核对'],
    });
    expect(r.snapshot().tasks[0]?.execution?.actions[0]?.status).toBe(
      'confirmed',
    );
    expect(
      r.snapshot().tasks[0]?.execution?.actions[0]?.resultSource?.fingerprint,
    ).toBe('after');
  } finally {
    r.close();
  }
});

test('公开委托保存后由通用动作产生独立效果，核对完成后继续不重发', async () => {
  const { ExecutionService } =
    await import('../../app/desktop/execution-service');
  const { createServer } = await import('node:http');
  const receipts: string[] = [];
  let done = false;
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      receipts.push('effect');
      done = true;
    }
    res.end(done ? '第一项已核对' : '核对第一项');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_PORT');
  const url = `http://127.0.0.1:${address.port}/list`;
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-execution-'));
  folders.push(folder);
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  let state = records.execute({
    kind: 'create',
    requestId: 'create',
    goal: '核对第一项 ' + url,
  }).state;
  const taskId = state.tasks[0]!.id;
  state = records.execute({
    kind: 'page',
    requestId: 'ready',
    taskId,
    url,
    phase: 'manual',
  }).state;
  const observe = async () => ({
    observation: {
      url,
      title: '清单',
      fingerprint: done ? 'after' : 'before',
      generation: 1,
      observedAt: 1,
      truncated: false,
      text: await (await fetch(url)).text(),
    },
    binding: { targetId: 'owned-page', generation: 1 },
  });
  const service = new ExecutionService({
    current: () => state,
    publish: (next) => {
      state = next;
    },
    records: (c) => Promise.resolve(records.execution(c)),
    observe,
    propose: (input) =>
      Promise.resolve({
        decision: input.observation.text.includes('已核对')
          ? 'complete'
          : 'act',
        summary: input.observation.text.includes('已核对')
          ? '已核对第一项。'
          : '核对第一项',
        evidence: [input.observation.text],
        previous: input.pending
          ? {
              id: input.pending.id,
              status: 'confirmed',
              evidence: ['第一项已核对'],
            }
          : null,
        action: input.observation.text.includes('已核对')
          ? null
          : {
              kind: 'click',
              target: { role: 'button', name: '核对第一项', exact: true },
            },
      }),
    perform: async (job) => {
      if (job.qualified())
        await fetch(url, { method: 'POST', signal: job.signal });
    },
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await service.intent({
      kind: 'execution-intent',
      requestId: 'start',
      taskId,
      intent: 'start',
    });
    await service.settled();
    expect(receipts).toEqual(['effect']);
    expect(state.tasks[0]?.execution).toMatchObject({
      phase: 'complete',
      actions: [{ status: 'confirmed' }],
    });
    await service.intent({
      kind: 'execution-intent',
      requestId: 'continue',
      taskId,
      intent: 'continue',
    });
    await service.settled();
    expect(receipts).toEqual(['effect']);
  } finally {
    service.disable();
    records.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function parallelFixture(inputGate?: InputGate) {
  const { ExecutionService } =
    await import('../../app/desktop/execution-service');
  const { createServer } = await import('node:http');
  const received: string[] = [],
    finished = new Set<string>(),
    held = new Map<string, () => void>();
  const server = createServer((req, res) => {
    const key = (req.url ?? '/').slice(1);
    if (req.method === 'POST') {
      received.push(key);
      held.set(key, () => {
        finished.add(key);
        res.end('accepted');
      });
    } else res.end(finished.has(key) ? `${key}已核对` : `核对${key}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_PORT');
  const base = `http://127.0.0.1:${address.port}`;
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-parallel-'));
  folders.push(folder);
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  let state = records.snapshot();
  const tasks: Record<string, string> = {};
  for (const name of ['A', 'B', 'C']) {
    const c = records.execute({
      kind: 'create',
      requestId: 'create-' + name,
      goal: `核对${name} ${base}/${name}`,
    });
    tasks[name] = c.taskId;
    state = records.execute({
      kind: 'page',
      requestId: 'page-' + name,
      taskId: c.taskId,
      url: `${base}/${name}`,
      phase: 'manual',
    }).state;
  }
  let holdAck: ((command: unknown) => Promise<void>) | undefined;
  let holdSend: ((command: unknown) => Promise<void>) | undefined;
  let holdObservation: (() => Promise<void>) | undefined;
  const service = new ExecutionService({
    input: inputGate
      ? {
          prepare: (id) => {
            const state = inputGate.state(id);
            if (!state.available) throw Error('NATIVE_INPUT_UNAVAILABLE');
            return Promise.resolve(state.epoch);
          },
          block: (id) => inputGate.block(id),
          allow: (id, epoch) => inputGate.allow(id, epoch),
          epoch: (id) => inputGate.state(id).epoch,
          valid: (id, epoch) => inputGate.valid(id, epoch),
          permit: (id, epoch, send) => inputGate.permit(id, epoch, send),
        }
      : undefined,
    records: async (c) => {
      await holdSend?.(c);
      const result = records.execution(c);
      await holdAck?.(c);
      return result;
    },
    current: () => state,
    publish: (next) => {
      if (next.revision >= state.revision) state = next;
    },
    observe: async (taskId) => {
      await holdObservation?.();
      const name = Object.keys(tasks).find((k) => tasks[k] === taskId)!;
      const url = `${base}/${name}`,
        text = await (await fetch(url)).text();
      return {
        observation: {
          url,
          title: name,
          text,
          fingerprint: text,
          generation: 1,
          observedAt: 1,
          truncated: false,
        },
        binding: { targetId: taskId, generation: 1 },
      };
    },
    propose: (input) => {
      const done = input.observation.text.includes('已核对');
      return Promise.resolve({
        decision: done ? 'complete' : input.pending ? 'wait' : 'act',
        summary: done ? '已完成核对。' : '核对本任务记录。',
        evidence: [input.observation.text],
        previous: input.pending
          ? {
              id: input.pending.id,
              status: done ? 'confirmed' : 'unknown',
              evidence: [input.observation.text],
            }
          : null,
        action:
          done || input.pending
            ? null
            : {
                kind: 'click',
                target: {
                  role: 'button',
                  name: input.observation.text,
                  exact: true,
                },
              },
      });
    },
    perform: async (job) => {
      const name = Object.keys(tasks).find((k) => tasks[k] === job.taskId)!;
      if (!job.qualified()) throw Error('EXECUTION_STOPPED');
      await fetch(`${base}/${name}`, { method: 'POST', signal: job.signal });
    },
    revoke: () => {},
    stopModels: () => {},
  });
  return {
    service,
    records,
    folder,
    tasks,
    get: () => state,
    received,
    setAckGate: (gate: typeof holdAck) => {
      holdAck = gate;
    },
    setSendGate: (gate: typeof holdSend) => {
      holdSend = gate;
    },
    setObservationGate: (gate: typeof holdObservation) => {
      holdObservation = gate;
    },
    release: (name: string) => {
      const finish = held.get(name);
      held.delete(name);
      finish?.();
    },
    close: async () => {
      service.disable();
      server.closeAllConnections();
      await service.settled();
      records.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.skipIf(process.platform !== 'darwin')(
  '能力不可用时继续被拒绝仍保留已保存暂停，恢复后只在明确继续时推进',
  async () => {
    const gate = nativeGate();
    const f = await parallelFixture(gate);
    let observing = false;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setObservationGate(async () => {
      observing = true;
      await pending;
    });
    try {
      await f.service.intent({
        kind: 'execution-intent',
        requestId: 'start-native-a',
        taskId: f.tasks.A!,
        intent: 'start',
      });
      await expect.poll(() => observing).toBe(true);
      gate.available(false);
      await f.service.suspend(
        f.tasks.A!,
        'native-unavailable',
        'native-failed',
      );
      await expect(
        f.service.intent({
          kind: 'execution-intent',
          requestId: 'unavailable-continue',
          taskId: f.tasks.A!,
          intent: 'continue',
        }),
      ).rejects.toThrow('NATIVE_INPUT_UNAVAILABLE');
      expect(
        f.service.decorate(f.get()).tasks.find((t) => t.id === f.tasks.A)
          ?.executionControl,
      ).toMatchObject({
        blocked: true,
        stopSaved: true,
        reason: 'native-unavailable',
      });
      gate.available(true);
      release();
      await f.service.settled();
      expect(
        f.get().tasks.find((t) => t.id === f.tasks.A)?.execution,
      ).toMatchObject({
        phase: 'paused',
        intent: 'automatic',
        pauseReason: 'native-unavailable',
      });
      expect(f.received).toEqual([]);
      await f.service.intent({
        kind: 'execution-intent',
        requestId: 'restored-continue',
        taskId: f.tasks.A!,
        intent: 'continue',
      });
      await expect.poll(() => f.received).toEqual(['A']);
      f.release('A');
      await f.service.settled();
    } finally {
      release();
      await f.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  '重送同一开始请求保留当前执行资格，仍能完成且只产生一次网页效果',
  async () => {
    const gate = nativeGate();
    const f = await parallelFixture(gate);
    let observing = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setObservationGate(async () => {
      observing = true;
      await held;
    });
    const start = {
      kind: 'execution-intent' as const,
      requestId: 'retry-start-a',
      taskId: f.tasks.A!,
      intent: 'start' as const,
    };
    try {
      await f.service.intent(start);
      await expect.poll(() => observing).toBe(true);
      await f.service.intent(start);
      release();
      await expect.poll(() => f.received).toEqual(['A']);
      f.release('A');
      await f.service.settled();
      expect(f.received).toEqual(['A']);
      expect(
        f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
      ).toBe('complete');
    } finally {
      release();
      await f.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  '开始已保存但回执丢失，重送转为明确待核对，继续后只产生一次效果',
  async () => {
    const gate = nativeGate();
    const f = await parallelFixture(gate);
    const start = {
      kind: 'execution-intent' as const,
      requestId: 'lost-start-a',
      taskId: f.tasks.A!,
      intent: 'start' as const,
    };
    f.setAckGate((command) =>
      (command as { kind: string }).kind === 'intent'
        ? Promise.reject(Error('RECORD_ACK_LOST'))
        : Promise.resolve(),
    );
    try {
      await expect(f.service.intent(start)).rejects.toThrow('RECORD_ACK_LOST');
      f.setAckGate(undefined);
      await f.service.intent(start);
      await f.service.settled();
      expect(f.received).toEqual([]);
      expect(
        f.get().tasks.find((t) => t.id === f.tasks.A)?.execution,
      ).toMatchObject({ phase: 'paused', pauseReason: 'ownership-unknown' });
      await f.service.intent({
        ...start,
        requestId: 'continue-a',
        intent: 'continue',
      });
      await expect.poll(() => f.received).toEqual(['A']);
      f.release('A');
      await f.service.settled();
      expect(f.received).toEqual(['A']);
      expect(
        f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
      ).toBe('complete');
    } finally {
      await f.close();
    }
  },
);

test('网页接管立即阻断本项，保存回执迟到不妨碍B，明确继续先核对已有效果', async () => {
  const f = await parallelFixture();
  let releaseAck: () => void = () => {};
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  f.setAckGate(async (input) => {
    if ((input as { kind: string }).kind === 'suspend') await ack;
  });
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-a',
      taskId: f.tasks.A!,
      intent: 'start',
    });
    await expect.poll(() => f.received).toEqual(['A']);
    const paused = f.service.suspend(f.tasks.A!, 'takeover', 'native-a');
    expect(
      f.service.decorate(f.get()).tasks.find((t) => t.id === f.tasks.A)
        ?.executionControl,
    ).toMatchObject({ blocked: true, reason: 'takeover' });
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-b',
      taskId: f.tasks.B!,
      intent: 'start',
    });
    await expect.poll(() => f.received).toEqual(['A', 'B']);
    releaseAck();
    await paused;
    f.release('A');
    f.release('B');
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution,
    ).toMatchObject({
      intent: 'automatic',
      phase: 'paused',
      pauseReason: 'takeover',
    });
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'continue-a',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await f.service.settled();
    expect(f.received).toEqual(['A', 'B']);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('complete');
  } finally {
    releaseAck();
    await f.close();
  }
});

test('归属未知保留B的明确停止，刷新和修正目标均不代替A的明确继续', async () => {
  const f = await parallelFixture();
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'stop-b',
      taskId: f.tasks.B!,
      intent: 'stop',
    });
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-a',
      taskId: f.tasks.A!,
      intent: 'start',
    });
    await expect.poll(() => f.received).toEqual(['A']);
    await Promise.all([
      f.service.suspend(f.tasks.A!, 'ownership-unknown', 'unknown-a'),
      f.service.suspend(f.tasks.B!, 'ownership-unknown', 'unknown-b'),
    ]);
    f.release('A');
    await f.service.settled();
    f.service.refresh();
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.B)?.execution,
    ).toMatchObject({ intent: 'stopped', phase: 'stopped' });
    await expect(
      f.service.intent({
        kind: 'execution-intent',
        requestId: 'start-old',
        taskId: f.tasks.A!,
        intent: 'start',
      }),
    ).rejects.toThrow('EXECUTION_CONTINUE_REQUIRED');
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'revise-a',
      taskId: f.tasks.A!,
      intent: 'revise',
      text: '核对A当前记录',
    });
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution,
    ).toMatchObject({ phase: 'paused', pauseReason: 'ownership-unknown' });
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'continue-a',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await f.service.settled();
    expect(f.received).toEqual(['A']);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('complete');
  } finally {
    await f.close();
  }
});

test('两项实际请求重叠，第三项排队；停止A释放容量，B继续，A继续先核对不重复发送', async () => {
  const f = await parallelFixture();
  try {
    for (const name of ['A', 'B', 'C'])
      await f.service.intent({
        kind: 'execution-intent',
        requestId: 'start-' + name,
        taskId: f.tasks[name]!,
        intent: 'start',
      });
    await expect.poll(() => f.received.slice().sort()).toEqual(['A', 'B']);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.C)?.execution?.phase,
    ).toBe('queued');
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'stop-a',
      taskId: f.tasks.A!,
      intent: 'stop',
    });
    await expect.poll(() => f.received.includes('C')).toBe(true);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.B)?.execution?.intent,
    ).toBe('automatic');
    f.release('A');
    f.release('B');
    f.release('C');
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('stopped');
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'continue-a',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await f.service.settled();
    expect(f.received.filter((n) => n === 'A')).toHaveLength(1);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('complete');
  } finally {
    await f.close();
  }
});

test('实际保存失败时停止即时生效且明确未保存，恢复后重试不复活旧动作', async () => {
  const f = await parallelFixture();
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-a',
      taskId: f.tasks.A!,
      intent: 'start',
    });
    await expect.poll(() => f.received).toEqual(['A']);
    chmodSync(f.folder, 0o500);
    const stop = {
      kind: 'execution-intent' as const,
      requestId: 'stop-a',
      taskId: f.tasks.A!,
      intent: 'stop' as const,
    };
    await expect(f.service.intent(stop)).rejects.toThrow();
    expect(
      f.service.decorate(f.get()).tasks.find((t) => t.id === f.tasks.A)
        ?.executionControl,
    ).toMatchObject({ blocked: true, stopSaved: false });
    expect(f.service.canExit()).toBe(false);
    chmodSync(f.folder, 0o700);
    await f.service.intent(stop);
    f.release('A');
    await f.service.settled();
    expect(f.service.canExit()).toBe(true);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.intent,
    ).toBe('stopped');
    expect(f.received).toEqual(['A']);
  } finally {
    chmodSync(f.folder, 0o700);
    await f.close();
  }
});

test('已送出但结果不明时继续只核对，稍后有完成证据再继续也不重发', async () => {
  const f = await parallelFixture();
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-a',
      taskId: f.tasks.A!,
      intent: 'start',
    });
    await expect.poll(() => f.received).toEqual(['A']);
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'stop-a',
      taskId: f.tasks.A!,
      intent: 'stop',
    });
    await f.service.settled();
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'continue-unknown',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('unknown');
    expect(f.received).toEqual(['A']);
    f.release('A');
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'continue-known',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('complete');
    expect(f.received).toEqual(['A']);
  } finally {
    await f.close();
  }
});

test('动作提交回执迟到不能越过已生效的停止，接收端没有操作', async () => {
  const f = await parallelFixture();
  let unblock: () => void = () => {};
  let held = false;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  f.setAckGate(async (input) => {
    const c = input as { kind: string; taskId: string };
    if (c.kind === 'dispatch' && c.taskId === f.tasks.A) {
      held = true;
      await gate;
    }
  });
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'start-a',
      taskId: f.tasks.A!,
      intent: 'start',
    });
    await expect.poll(() => held).toBe(true);
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'stop-a',
      taskId: f.tasks.A!,
      intent: 'stop',
    });
    unblock();
    await f.service.settled();
    expect(f.received).toEqual([]);
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.intent,
    ).toBe('stopped');
  } finally {
    unblock();
    await f.close();
  }
});

test('继续已保存但回执丢失后，重试同一请求可核对并推进，不重复创建意图', async () => {
  const f = await parallelFixture();
  try {
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'stop-a',
      taskId: f.tasks.A!,
      intent: 'stop',
    });
    let lose = true;
    f.setAckGate((input) => {
      const c = input as { kind: string; intent?: string };
      if (lose && c.kind === 'intent' && c.intent === 'continue') {
        lose = false;
        return Promise.reject(Error('REQUEST_TIMEOUT'));
      }
      return Promise.resolve();
    });
    const command = {
      kind: 'execution-intent' as const,
      requestId: 'continue-a',
      taskId: f.tasks.A!,
      intent: 'continue' as const,
    };
    await expect(f.service.intent(command)).rejects.toThrow('REQUEST_TIMEOUT');
    expect(f.received).toEqual([]);
    await f.service.intent(command);
    await expect.poll(() => f.received).toEqual(['A']);
    f.release('A');
    await f.service.settled();
    expect(
      f
        .get()
        .tasks.find((t) => t.id === f.tasks.A)
        ?.messages.filter((m) => m.text === '继续'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('较旧停止回执超时不能覆盖已保存的新继续，或永久占住执行容量', async () => {
  const f = await parallelFixture();
  let release: () => void = () => {},
    held = false;
  const oldAck = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setAckGate(async (input) => {
    if ((input as { requestId?: string }).requestId === 'old-stop') {
      held = true;
      await oldAck;
      throw Error('REQUEST_TIMEOUT');
    }
  });
  try {
    const oldStop = f.service
      .intent({
        kind: 'execution-intent',
        requestId: 'old-stop',
        taskId: f.tasks.A!,
        intent: 'stop',
      })
      .catch(() => {});
    await expect.poll(() => held).toBe(true);
    await f.service.intent({
      kind: 'execution-intent',
      requestId: 'new-continue',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    await expect.poll(() => f.received).toEqual(['A']);
    release();
    await oldStop;
    expect(
      f.service.decorate(f.get()).tasks.find((t) => t.id === f.tasks.A)
        ?.executionControl?.blocked,
    ).not.toBe(true);
    f.release('A');
    await f.service.settled();
    expect(
      f.get().tasks.find((t) => t.id === f.tasks.A)?.execution?.phase,
    ).toBe('complete');
    expect(f.service.canExit()).toBe(true);
  } finally {
    release();
    await f.close();
  }
});

test('接管保存后才到达的旧继续不能覆盖可靠暂停，另项保持运行', async () => {
  const f = await parallelFixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  try {
    f.setObservationGate(() => waiting);
    for (const name of ['A', 'B'])
      await f.service.intent({
        kind: 'execution-intent',
        requestId: 'start-' + name,
        taskId: f.tasks[name]!,
        intent: 'start',
      });
    await f.service.suspend(f.tasks.A!, 'takeover', 'first-input');
    f.setSendGate(async (input) => {
      const c = input as { kind: string; intent?: string };
      if (c.kind === 'intent' && c.intent === 'continue') {
        reached = true;
        await waiting;
      }
    });
    const old = f.service.intent({
      kind: 'execution-intent',
      requestId: 'old-continue',
      taskId: f.tasks.A!,
      intent: 'continue',
    });
    const rejected = expect(old).rejects.toThrow('RECORD_VERSION_CONFLICT');
    await expect.poll(() => reached).toBe(true);
    await f.service.suspend(f.tasks.A!, 'takeover', 'input-during-send');
    release();
    await rejected;
    expect(
      f.records.snapshot().tasks.find((t) => t.id === f.tasks.A)?.execution,
    ).toMatchObject({ phase: 'paused', pauseReason: 'takeover' });
    expect(
      f.records.snapshot().tasks.find((t) => t.id === f.tasks.B)?.execution
        ?.intent,
    ).toBe('automatic');
  } finally {
    release();
    await f.close();
  }
});

test.each(['stopped', 'unstarted'] as const)(
  '%s 任务的旧继续在随后输入后不能改写已有状态',
  async (initial) => {
    const f = await parallelFixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    try {
      if (initial === 'stopped')
        await f.service.intent({
          kind: 'execution-intent',
          requestId: 'stop-a',
          taskId: f.tasks.A!,
          intent: 'stop',
        });
      f.setSendGate(async (input) => {
        const c = input as { kind: string; intent?: string };
        if (c.kind === 'intent' && c.intent === 'continue') {
          reached = true;
          await waiting;
        }
      });
      const old = f.service.intent({
        kind: 'execution-intent',
        requestId: 'old-continue',
        taskId: f.tasks.A!,
        intent: 'continue',
      });
      const rejected = expect(old).rejects.toThrow('RECORD_VERSION_CONFLICT');
      await expect.poll(() => reached).toBe(true);
      await f.service.suspend(f.tasks.A!, 'ownership-unknown', 'new-input');
      release();
      await rejected;
      const execution = f.records
        .snapshot()
        .tasks.find((t) => t.id === f.tasks.A)?.execution;
      if (initial === 'stopped')
        expect(execution).toMatchObject({
          phase: 'stopped',
          intent: 'stopped',
        });
      else expect(execution).toBeNull();
    } finally {
      release();
      await f.close();
    }
  },
);

test('重送旧回执不使在途真实停止的控制顺序失效', async () => {
  const f = await parallelFixture();
  const taskId = f.tasks.A!;
  const start = {
    kind: 'intent',
    taskId,
    intent: 'start',
    requestId: 'start',
    controlSequence: 1,
  };
  try {
    f.records.execution(start);
    f.records.execution({ ...start, controlSequence: 3 });
    expect(() =>
      f.records.execution({
        kind: 'intent',
        taskId,
        intent: 'stop',
        requestId: 'stop',
        controlSequence: 2,
      }),
    ).not.toThrow();
    expect(
      f.records.snapshot().tasks.find((t) => t.id === taskId)?.execution,
    ).toMatchObject({ phase: 'stopped', intent: 'stopped' });
  } finally {
    await f.close();
  }
});
