import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  ExecutionService,
  type WebActionJob,
} from '../../app/desktop/execution-service';
import { actionFactSchema, type NextStep } from '../../app/shared/execution';
import type { PageObservation } from '../../app/shared/model';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function fixture(direct = false) {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-created-target-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanups.push(() => records.close());
  const entry = 'https://example.com/new',
    url = 'https://example.com/edit/' + randomUUID();
  const taskId = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: `在 ${entry} 创建“独立草稿”到公告，后续补充正文`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId,
    url: entry,
    phase: 'manual',
  });
  const post = (c: Record<string, unknown>) =>
    records.execution({ taskId, ...c });
  const execution = () =>
    records.snapshot().tasks.find((t) => t.id === taskId)!.execution!;
  post({ kind: 'intent', requestId: randomUUID(), intent: 'start' });
  const session = {
    id: 'fixture-session',
    origin: new URL(entry).origin,
    epoch: randomUUID() + ':0',
  };
  post({ kind: 'claim', runId: 'create', ...(direct ? { session } : {}) });
  const source: PageObservation = {
    url: entry,
    title: '新建',
    text: '标题 独立草稿 公告',
    fingerprint: 'new',
    generation: 1,
    observedAt: 1,
    truncated: false,
    controls: [
      {
        role: 'textbox',
        name: '标题',
        textValue: '独立草稿',
        frameUrl: entry,
        disabled: false,
      },
    ],
    links: [],
  };
  if (direct)
    post({ kind: 'coordination-observed', runId: 'create', session, source });
  const reserve = {
    kind: 'reserve',
    runId: 'create',
    id: 'create-draft',
    summary: '保存草稿',
    effect: 'draft',
    action: {
      kind: 'click',
      target: { role: 'button', name: '保存草稿', exact: true },
    },
    source,
    binding: { targetId: 'page', generation: 1 },
    evidence: ['公告'],
    targetCreation: {
      rule: 'same-site-editor-v1',
      fields: [{ name: '标题', value: '独立草稿' }],
      destination: '公告',
    },
  };
  const observation: PageObservation = {
    ...source,
    url,
    title: '已保存',
    generation: direct ? 2 : 3,
    observedAt: 10,
    fingerprint: 'saved',
    controls: [{ ...source.controls![0]!, frameUrl: url }],
    links: [
      { name: '编辑此草稿', url },
      { name: '新建入口', url: entry },
    ],
  };
  const event = {
    taskId,
    runId: 'create',
    actionId: 'create-draft',
    navigation: {
      id: randomUUID(),
      association: 'during-action' as const,
      targetId: 'page',
      sourceGeneration: 1,
      generation: 2,
      url: direct ? url : entry + '/submit',
      mainFrame: true,
      sameDocument: false,
      inputEpoch: 4,
      observedAt: 5,
    },
  };
  const dispatch = () => {
    post(reserve);
    post({ kind: 'dispatch', runId: 'create', id: 'create-draft' });
  };
  const arrive = () =>
    records.execute({
      kind: 'page',
      requestId: randomUUID(),
      taskId,
      url,
      phase: 'manual',
    });
  const pause = () => {
    arrive();
    post({ kind: 'suspend', requestId: randomUUID(), reason: 'page-change' });
    post({ kind: 'action-navigation', ...event });
  };
  const freeze = (o = observation, targetId = 'page') =>
    post({
      kind: 'created-target-observed',
      expectedVersion: execution().version,
      actionId: 'create-draft',
      source: o,
      binding: { targetId, generation: o.generation },
    });
  const service = (
    options: {
      beforeRecord?: (c: Record<string, unknown>) => void;
      afterRecord?: (c: Record<string, unknown>) => void;
      observe?: () => PageObservation;
      changedSession?: boolean;
    } = {},
  ) => {
    let state = records.snapshot(),
      epoch = direct ? 5 : 12;
    const prepare = vi.fn(() => Promise.resolve(epoch)),
      allow = vi.fn(() => true),
      perform = vi.fn<(job: WebActionJob) => Promise<void>>(() =>
        Promise.resolve(),
      );
    const propose = vi.fn((): Promise<NextStep> =>
      Promise.resolve({
        decision: 'wait' as const,
        summary: '剩余正文等待处理',
        evidence: [],
        previous: null,
        action: null,
      }),
    );
    const instance = new ExecutionService({
      records: (c) => {
        options.beforeRecord?.(c as Record<string, unknown>);
        const result = records.execution(c);
        options.afterRecord?.(c as Record<string, unknown>);
        return Promise.resolve(result);
      },
      current: () => state,
      publish: (s) => {
        state = s;
      },
      observe: () =>
        Promise.resolve({
          ...(direct
            ? {
                session: options.changedSession
                  ? { ...session, epoch: session.epoch.replace(':0', ':1') }
                  : session,
              }
            : {}),
          observation: options.observe?.() ?? observation,
          binding: { targetId: 'page', generation: direct ? 2 : 3 },
        }),
      ...(direct ? { session: () => Promise.resolve(session) } : {}),
      resultPageReady: () => Promise.resolve(true),
      navigationReady: () => Promise.resolve(true),
      propose,
      perform,
      revoke: () => {},
      stopModels: () => {},
      input: {
        epoch: () => epoch,
        block: () => {
          epoch++;
        },
        prepare,
        allow,
        valid: () => true,
        permit: (_t, _e, send) => send(),
      },
    });
    return {
      instance,
      prepare,
      allow,
      propose,
      perform,
      nativeChange: () => {
        epoch++;
      },
    };
  };
  return {
    get records() {
      return records;
    },
    folder,
    taskId,
    url,
    session,
    post,
    execution,
    source,
    reserve,
    observation,
    event,
    dispatch,
    arrive,
    pause,
    freeze,
    service,
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
    },
  };
}

test('创建前字段必须来自完整唯一主文档文本框，已知目标不能冻结新建约定', () => {
  const f = fixture();
  for (const source of [
    { ...f.source, truncated: true },
    { ...f.source, controls: [] },
    { ...f.source, controls: [...f.source.controls!, ...f.source.controls!] },
    {
      ...f.source,
      controls: [{ ...f.source.controls![0]!, textValue: '其它草稿' }],
    },
  ]) {
    expect(() => f.post({ ...f.reserve, source })).toThrow(
      'PREPARATION_TARGET_CHANGED',
    );
  }
  expect(f.execution().actions).toHaveLength(0);
});

test('动态草稿只读核对后保存目标和草稿事实，仍暂停且不取得输入资格', async () => {
  const f = fixture();
  f.dispatch();
  const s = f.service();
  f.arrive();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.execution()).toMatchObject({
    phase: 'paused',
    pauseReason: 'page-change',
  });
  expect(f.execution().actions[0]).toMatchObject({
    status: 'confirmed',
    navigation: { association: 'during-action' },
    discoveredTarget: { source: { url: f.url } },
  });
  expect(
    f.execution().preparation?.map((f) => [f.kind, f.url, f.actionId]),
  ).toEqual([
    ['target', f.url, 'create-draft'],
    ['draft', f.url, 'create-draft'],
  ]);
  for (const spy of [s.prepare, s.allow, s.propose, s.perform])
    expect(spy).not.toHaveBeenCalled();
  await s.instance.stopAll();
});

test.each([
  'field',
  'source-link',
  'self-link',
  'duplicate',
  'truncated',
  'target',
  'generation',
] as const)('新目标身份反例 %s 不改变未知创建', (variant) => {
  const f = fixture();
  f.dispatch();
  f.pause();
  const o = structuredClone(f.observation);
  if (variant === 'field') o.controls![0]!.textValue = '其它目标';
  if (variant === 'source-link') o.links = o.links!.slice(0, 1);
  if (variant === 'self-link') o.links = o.links!.slice(1);
  if (variant === 'duplicate') o.links!.push(o.links![0]!);
  if (variant === 'truncated') o.truncated = true;
  if (variant === 'generation') o.generation = 1;
  expect(() => f.freeze(o, variant === 'target' ? 'other' : 'page')).toThrow();
  expect(f.execution().actions[0]!.status).toBe('unknown');
  expect(f.execution().preparation).toBeUndefined();
});

test('停止和保存失败均不确认创建，不恢复输入', async () => {
  for (const stop of [true, false]) {
    const f = fixture();
    f.dispatch();
    const s = f.service({
      beforeRecord: (c) => {
        if (c.kind === 'created-target-observed') {
          if (stop)
            f.post({ kind: 'intent', requestId: randomUUID(), intent: 'stop' });
          else throw Error('DISK_FAILURE');
        }
      },
    });
    f.arrive();
    await s.instance.recordNavigation(f.event);
    await s.instance.suspend(f.taskId, 'page-change', randomUUID());
    await s.instance.settled();
    expect(f.execution().actions[0]!.discoveredTarget).toBeUndefined();
    expect(s.allow).not.toHaveBeenCalled();
    expect(s.perform).not.toHaveBeenCalled();
    if (stop) expect(f.execution().intent).toBe('stopped');
    await s.instance.stopAll();
  }
});

test('两次观察之间原生epoch变化放弃创建身份', async () => {
  const f = fixture();
  f.dispatch();
  let reads = 0;
  const s = f.service({
    observe: () => {
      if (++reads === 2) s.nativeChange();
      return f.observation;
    },
  });
  f.arrive();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.execution().actions[0]!.discoveredTarget).toBeUndefined();
  await s.instance.stopAll();
});

test('格式25迁移先备份；冷开保留创建事实，明确继续才规划剩余工作', async () => {
  const f = fixture();
  f.dispatch();
  f.pause();
  f.freeze();
  const before = f.execution().actions;
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=25');
  db.close();
  f.reopen();
  expect(
    readdirSync(f.folder).some((n) =>
      n.startsWith('workspace-before-created-target-23-'),
    ),
  ).toBe(true);
  f.arrive();
  const s = f.service();
  s.instance.refresh();
  await s.instance.settled();
  expect(s.propose).not.toHaveBeenCalled();
  expect(f.execution().actions).toEqual(before);
  await s.instance.intent({
    kind: 'execution-intent',
    requestId: randomUUID(),
    taskId: f.taskId,
    intent: 'continue',
  });
  await s.instance.settled();
  expect(s.propose).toHaveBeenCalledTimes(1);
  expect(s.propose.mock.calls[0]).toBeDefined();
  expect(s.perform).not.toHaveBeenCalled();
  expect(f.execution().actions).toHaveLength(1);
  await s.instance.stopAll();
});

test('明确继续时创建后的字段已被改动，不规划、不重建', async () => {
  const f = fixture();
  f.dispatch();
  f.pause();
  f.freeze();
  const s = f.service({ observe: () => ({ ...f.observation, controls: [] }) });
  await s.instance.intent({
    kind: 'execution-intent',
    requestId: randomUUID(),
    taskId: f.taskId,
    intent: 'continue',
  });
  await s.instance.settled();
  expect(s.propose).not.toHaveBeenCalled();
  expect(s.perform).not.toHaveBeenCalled();
  expect(f.execution().phase).toBe('unknown');
  await s.instance.stopAll();
});

test('真实备份导入保留restoreReview；伪造字段与坏事实引用拒绝', async () => {
  const f = fixture();
  f.dispatch();
  f.pause();
  f.freeze();
  const a = structuredClone(f.execution().actions[0]!);
  a.discoveredTarget!.controls[0]!.textValue = '伪造';
  expect(actionFactSchema.safeParse(a).success).toBe(false);
  const file = path.join(f.folder, 'target.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file,
  });
  const g = fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  expect(
    g.records.snapshot().tasks.find((t) => t.id === f.taskId)!.execution,
  ).toMatchObject({
    restoreReview: 'required',
    actions: f.execution().actions,
  });
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "UPDATE task_executions SET body=json_set(body,'$.actions[0].discoveredTarget.targetFactId','00000000-0000-4000-8000-000000000000')",
  );
  db.close();
  expect(() => f.reopen()).toThrow('DATA_CORRUPT');
});

test('明确继续只执行剩余字段动作，不重放创建点击', async () => {
  const f = fixture();
  f.dispatch();
  f.pause();
  f.freeze();
  const s = f.service();
  s.propose.mockImplementationOnce(() =>
    Promise.resolve({
      decision: 'act',
      summary: '补充正文',
      evidence: ['公告'],
      previous: null,
      action: {
        kind: 'fill',
        target: { role: 'textbox', name: '正文', exact: true },
        value: '后续正文',
      },
    }),
  );
  await s.instance.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await s.instance.settled();
  expect(s.perform).toHaveBeenCalledTimes(1);
  expect(s.perform.mock.calls[0]![0]).toMatchObject({
    action: { kind: 'fill', value: '后续正文' },
  });
  expect(f.execution().actions.map((a) => a.action.kind)).toEqual([
    'click',
    'fill',
  ]);
  expect(f.execution().actions[0]!.status).toBe('confirmed');
  await s.instance.stopAll();
});

test('创建检查点缺失时明确继续仍未知，不让模型消除未知或再次创建', async () => {
  const f = fixture();
  f.dispatch();
  f.pause();
  const s = f.service();
  await s.instance.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await s.instance.settled();
  expect(s.propose).not.toHaveBeenCalled();
  expect(s.perform).not.toHaveBeenCalled();
  expect(f.execution().phase).toBe('unknown');
  expect(f.execution().actions[0]!.status).toBe('unknown');
  await s.instance.stopAll();
});

function formProof(f: ReturnType<typeof fixture>) {
  return {
    taskId: f.taskId,
    runId: 'create',
    actionId: 'create-draft',
    targetId: 'page',
    generation: 1,
    inputEpoch: 4,
    reason: 'formSubmissionPost' as const,
    url: f.url,
    requestedAt: 5,
  };
}

test.each([
  'valid',
  'no-proof',
  'wrong-request',
  'redirect',
  'input-between',
  'input-after-save',
  'stop-before-save',
  'save-failure',
  'field-changed',
  'session-observation',
  'session-before-save',
] as const)('表单独立证明、目标检查点与自动续行：%s', async (variant) => {
  const f = fixture(variant !== 'redirect');
  f.dispatch();
  let reads = 0;
  const s = f.service({
    changedSession: variant === 'session-observation',
    observe: () => {
      reads++;
      if (variant === 'input-between' && reads === 2) s.nativeChange();
      return variant === 'field-changed' && reads >= 3
        ? { ...f.observation, controls: [] }
        : f.observation;
    },
    beforeRecord: (c) => {
      if (c.kind !== 'form-navigation-resolved') return;
      if (variant === 'stop-before-save')
        f.post({ kind: 'intent', requestId: randomUUID(), intent: 'stop' });
      if (variant === 'save-failure') throw Error('DISK_FAILURE');
      if (variant === 'session-before-save')
        f.post({
          kind: 'session-invalidated',
          session: { ...f.session, epoch: f.session.epoch.replace(':0', ':1') },
        });
    },
    afterRecord: (c) => {
      if (
        c.kind === 'form-navigation-resolved' &&
        variant === 'input-after-save'
      )
        s.nativeChange();
    },
  });
  s.propose.mockImplementationOnce(() =>
    Promise.resolve({
      decision: 'act',
      summary: '补充正文',
      evidence: ['公告'],
      previous: null,
      action: {
        kind: 'fill',
        target: { role: 'textbox', name: '正文', exact: true },
        value: '后续正文',
      },
    }),
  );
  f.arrive();
  if (variant !== 'no-proof')
    s.instance.acceptFormNavigation({
      ...formProof(f),
      ...(variant === 'wrong-request' ? { url: f.url + '/other' } : {}),
    });
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  if (variant === 'valid') {
    expect(s.perform).toHaveBeenCalledTimes(1);
    expect(s.perform.mock.calls[0]![0].action).toMatchObject({
      kind: 'fill',
      value: '后续正文',
    });
    expect(f.execution().actions[0]).toMatchObject({
      status: 'confirmed',
      formNavigationResolution: { proof: formProof(f), pausedInputEpoch: 6 },
    });
    expect(f.execution().actions.map((a) => a.action.kind)).toEqual([
      'click',
      'fill',
    ]);
    expect(f.execution().preparation?.map((f) => f.kind)).toEqual([
      'target',
      'draft',
    ]);
  } else {
    expect(s.perform).not.toHaveBeenCalled();
    expect(s.propose).not.toHaveBeenCalled();
    expect(s.allow).not.toHaveBeenCalled();
    expect(f.execution().phase).not.toBe('queued');
  }
  await s.instance.stopAll();
});

test('表单检查点拒绝坏epoch、代次、指纹及无已保存目标；28迁移与真实备份不补造许可', async () => {
  const f = fixture(true);
  f.dispatch();
  f.pause();
  f.freeze();
  const a = f.execution().actions[0]!;
  const resolution = {
    proof: formProof(f),
    source: a.discoveredTarget!.source,
    pausedInputEpoch: 6,
  };
  expect(
    actionFactSchema.safeParse({ ...a, formNavigationResolution: resolution })
      .success,
  ).toBe(true);
  for (const change of [
    { pausedInputEpoch: 7 },
    { proof: { ...resolution.proof, reason: 'anchorClick' } },
    { source: { ...resolution.source, generation: 3 } },
    { source: { ...resolution.source, fingerprint: 'other' } },
    { proof: { ...resolution.proof, url: f.url + '/other' } },
  ])
    expect(
      actionFactSchema.safeParse({
        ...a,
        formNavigationResolution: { ...resolution, ...change },
      }).success,
    ).toBe(false);
  expect(
    actionFactSchema.safeParse({
      ...a,
      discoveredTarget: undefined,
      formNavigationResolution: resolution,
    }).success,
  ).toBe(false);
  const postResolution = () =>
    f.post({
      kind: 'form-navigation-resolved',
      expectedVersion: f.execution().version,
      resolution,
    });
  expect(postResolution().recovered).toBe(true);
  const savedActions = f.execution().actions;
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=28');
  db.close();
  f.reopen();
  expect(
    readdirSync(f.folder).some((n) =>
      n.startsWith('workspace-before-form-navigation-23-'),
    ),
  ).toBe(true);
  expect(f.execution().actions).toEqual(savedActions);
  expect(postResolution().recovered).toBe(false);
  const file = path.join(f.folder, 'form.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file,
  });
  const g = fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  expect(
    g.records.snapshot().tasks.find((t) => t.id === f.taskId)!.execution,
  ).toMatchObject({ restoreReview: 'required', actions: savedActions });
});
