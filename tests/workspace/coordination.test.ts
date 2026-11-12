import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import { WebsiteSessions } from '../../app/desktop/website-sessions';
import { pageObservation } from '../../app/desktop/page-observation';
import { StorageMonitor } from '../../app/desktop/storage-monitor';
import type { PageObservation } from '../../app/shared/model';
import type {
  SessionContext,
  CoordinationProposal,
} from '../../app/shared/coordination';
import type { NextStep } from '../../app/shared/execution';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function setup() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-coordination-'));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanup.push(() => records.close());
  const contexts = new WebsiteSessions('actual-session');
  const urls = new Map<string, string>();
  const get = (id: string) =>
    records.snapshot().tasks.find((t) => t.id === id)!.execution!;
  const command = (c: unknown) => records.execution(c);
  const intent = (id: string, value = 'start', extra = {}) =>
    command({
      kind: 'intent',
      taskId: id,
      requestId: randomUUID(),
      intent: value,
      ...extra,
    });
  const add = (record: string, site = 'https://example.com') => {
    const url = `${site}/edit?id=${record}`;
    const id = records.execute({
      kind: 'create',
      requestId: randomUUID(),
      goal: `更新 ${url}`,
    }).taskId;
    urls.set(id, url);
    records.execute({
      kind: 'page',
      taskId: id,
      requestId: randomUUID(),
      url,
      phase: 'manual',
    });
    intent(id);
    return id;
  };
  const session = (id: string) => contexts.context(urls.get(id)!);
  const source = (
    id: string,
    account = 'alice',
    generation = 1,
  ): PageObservation => ({
    url: urls.get(id)!,
    title: '编辑记录',
    generation,
    observedAt: Date.now(),
    fingerprint: `${id}:${account}:${generation}`,
    truncated: false,
    text: `账号 ${account}\n可编辑此记录\n已保存\n原内容\n公告`,
    links: [
      {
        name: `账号 ${account}`,
        url: new URL(`/users/${account}`, urls.get(id)).href,
      },
      { name: '当前记录', url: urls.get(id)! },
    ],
  });
  const proof = (s: PageObservation): CoordinationProposal => ({
    account: s.links![0]!,
    target: s.links![1]!,
    permissionEvidence: ['可编辑此记录'],
  });
  const claim = (id: string) =>
    command({
      kind: 'claim',
      taskId: id,
      runId: randomUUID(),
      session: session(id),
    });
  const observe = (id: string, s = source(id), authenticated = false) =>
    command({
      kind: 'coordination-observed',
      taskId: id,
      runId: get(id).runId,
      session: session(id),
      source: s,
      proposal: proof(s),
      authenticated,
    });
  const reserve = (id: string, s = source(id), actionId = randomUUID()) => ({
    result: command({
      kind: 'reserve',
      taskId: id,
      runId: get(id).runId,
      id: actionId,
      summary: '保存此记录',
      source: s,
      binding: { targetId: id, generation: s.generation },
      action: {
        kind: 'click',
        target: { role: 'button', name: '保存', exact: true },
      },
    }),
    actionId,
  });
  const dispatch = (id: string, actionId: string, runId = get(id).runId) =>
    command({ kind: 'dispatch', taskId: id, runId, id: actionId });
  const resolve = (id: string, actionId: string) =>
    command({
      kind: 'resolve',
      taskId: id,
      runId: get(id).runId,
      id: actionId,
      source: source(id),
      evidence: ['已保存'],
    });
  const ready = (id: string) => {
    expect(claim(id).claimed).toBe(true);
    observe(id);
  };
  const login = (id: string) =>
    command({
      kind: 'ask',
      type: 'login',
      taskId: id,
      runId: get(id).runId,
      questionId: randomUUID(),
      text: '请登录',
      url: urls.get(id),
    });
  const recover = (id: string) => {
    if (get(id).recoveryPending)
      command({
        kind: 'recover',
        taskId: id,
        expectedVersion: get(id).version,
      });
    return claim(id);
  };
  return {
    folder,
    records: () => records,
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
    },
    get,
    command,
    intent,
    add,
    session,
    source,
    proof,
    claim,
    observe,
    reserve,
    dispatch,
    resolve,
    ready,
    login,
    recover,
    contexts,
    urls,
  };
}

test('实际 Session 按 Cookie domain 影响已观察网站，端口共享变化且其它网站不变，重开代次不同', () => {
  const sessions = new WebsiteSessions('partition-a');
  const a = sessions.context('https://a.example.com/edit');
  const b = sessions.context('https://a.example.com:8443/edit');
  const c = sessions.context('https://other.test/edit');
  expect(sessions.changed('.example.com').map((s) => s.origin)).toEqual([
    a.origin,
    b.origin,
  ]);
  expect(sessions.context(c.origin)).toEqual(c);
  expect(sessions.context(a.origin).epoch).not.toBe(a.epoch);
  expect(new WebsiteSessions('partition-a').context(a.origin).epoch).not.toBe(
    a.epoch,
  );
  expect(sessions.changed('example.com')).toEqual([]);
});

test('同路径不同稳定记录可同时领取和派发；资源归属绑定所属动作和执行', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2');
  f.ready(a);
  f.ready(b);
  const aa = f.reserve(a).actionId,
    bb = f.reserve(b).actionId;
  expect(f.dispatch(a, aa).permitted).toBe(true);
  expect(f.dispatch(b, bb).permitted).toBe(true);
  expect(f.get(a).phase).toBe('running');
  expect(f.get(b).phase).toBe('running');
  expect(f.get(a).resourceClaims![0]!.targetUrl).not.toBe(
    f.get(b).resourceClaims![0]!.targetUrl,
  );
  expect(f.dispatch(a, bb).permitted).toBe(false);
});

test('同一目标竞争等待；停止未派发拥有者释放，旧拥有者回调失效，等待者必须新观察', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('1');
  f.ready(a);
  f.ready(b);
  const oldRun = f.get(a).runId!,
    aa = f.reserve(a).actionId;
  expect(f.reserve(b).result.created).toBe(false);
  expect(f.get(b).coordination?.waitFor).toBe(a);
  expect(f.claim(b).claimed).toBe(false);
  f.intent(a, 'stop');
  expect(f.get(a).resourceClaims![0]!.status).toBe('released');
  expect(f.dispatch(a, aa, oldRun).permitted).toBe(false);
  expect(f.claim(b).claimed).toBe(true);
  expect(() => f.observe(b)).toThrow('COORDINATION_STALE');
  f.observe(b, f.source(b, 'alice', 2));
  const bb = f.reserve(b, f.source(b, 'alice', 2)).actionId;
  expect(f.dispatch(b, bb).permitted).toBe(true);
});

test('已编辑目标在待确认、停止和接管时保留占用；无关目标可继续，冷开不会窃取原占用', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('1');
  f.ready(a);
  f.ready(b);
  const action = f.reserve(a).actionId;
  f.dispatch(a, action);
  f.resolve(a, action);
  f.command({
    kind: 'ask',
    type: 'review',
    taskId: a,
    runId: f.get(a).runId,
    questionId: randomUUID(),
    text: '确认内容',
    url: f.urls.get(a),
    publication: { content: '原内容', destination: '公告' },
  });
  expect(f.reserve(b).result.created).toBe(false);
  f.intent(a, 'stop');
  expect(f.claim(b).claimed).toBe(false);
  const c = f.add('2');
  f.ready(c);
  expect(f.dispatch(c, f.reserve(c).actionId).permitted).toBe(true);
  f.reopen();
  expect(f.get(a).intent).toBe('stopped');
  expect(f.recover(b).claimed).toBe(false);
  expect(f.get(c).actions[0]?.status).toBe('unknown');
  expect(f.get(a).resourceClaims![0]!.status).toBe('held');
});

test('共享登录只留一个入口，停止入口任务会转交；恢复不解除原停止或其它任务确认', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2');
  f.ready(a);
  f.ready(b);
  f.login(a);
  expect([a, b].filter((id) => f.get(id).question?.type === 'login')).toEqual([
    a,
  ]);
  const oldQuestion = f.get(a).question!.id;
  f.intent(a, 'stop');
  expect(f.get(a).intent).toBe('stopped');
  expect(f.get(b).question?.id).not.toBe(oldQuestion);
  f.intent(b, 'continue', { loginQuestionId: f.get(b).question!.id });
  expect(f.recover(b).claimed).toBe(true);
  f.observe(b, f.source(b), true);
  f.command({
    kind: 'verified-login',
    taskId: b,
    runId: f.get(b).runId,
    source: f.source(b),
    evidence: ['账号 alice'],
  });
  expect(f.get(a).intent).toBe('stopped');
  expect(f.get(a).coordination?.loginId).toBeUndefined();
  expect(f.get(b).loginOrigin).toBeUndefined();
  expect(() =>
    f.intent(a, 'continue', { loginQuestionId: oldQuestion }),
  ).toThrow('PARTICIPATION_EXPIRED');
});

test('共享登录恢复保留各自的内容确认、接管和已有结果，第三站点不受影响', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2');
  f.ready(a);
  f.ready(b);
  f.command({
    kind: 'ask',
    type: 'review',
    taskId: a,
    runId: f.get(a).runId,
    questionId: randomUUID(),
    text: '确认内容',
    url: f.urls.get(a),
    publication: { content: '原内容', destination: '公告' },
  });
  const question = f.get(a).question!;
  f.login(b);
  expect(f.get(a).question).toEqual(question);
  const c = f.add('1', 'https://independent.test');
  f.ready(c);
  expect(f.dispatch(c, f.reserve(c).actionId).permitted).toBe(true);
  f.command({
    kind: 'suspend',
    taskId: a,
    requestId: randomUUID(),
    reason: 'takeover',
  });
  f.intent(b, 'continue', { loginQuestionId: f.get(b).question!.id });
  f.recover(b);
  f.observe(b, f.source(b), true);
  f.command({
    kind: 'verified-login',
    taskId: b,
    runId: f.get(b).runId,
    source: f.source(b),
    evidence: ['账号 alice'],
  });
  expect(f.get(a)).toMatchObject({
    phase: 'paused',
    pauseReason: 'takeover',
    publication: { approvalId: null },
  });
  expect(f.get(c).phase).toBe('running');
});

test('会话新代次取消未派发预留，重复或迟到通知不退回代次；账号改变不获得旧确认', () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  const oldSession = f.session(a),
    oldRun = f.get(a).runId!,
    action = f.reserve(a).actionId;
  const next = f.contexts.changed('example.com')[0]!;
  f.command({ kind: 'session-invalidated', taskId: a, session: next });
  const version = f.get(a).version;
  f.command({ kind: 'session-invalidated', taskId: a, session: oldSession });
  f.command({ kind: 'session-invalidated', taskId: a, session: next });
  expect(f.get(a).version).toBe(version);
  expect(f.get(a).actions[0]?.status).toBe('cancelled');
  expect(f.dispatch(a, action, oldRun).permitted).toBe(false);
  f.recover(a);
  expect(() => f.observe(a)).toThrow('COORDINATION_STALE');
  f.observe(a, f.source(a, 'bob', 2));
  expect(f.get(a)).toMatchObject({
    phase: 'paused',
    coordination: {
      status: 'account-changed',
      account: { name: '账号 alice' },
    },
  });
  expect(f.get(a).actions).toHaveLength(1);
});

test('已派发未知效果保留目标占用；同站未知身份保守等待，伪造和重名链接不能证明独立', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2');
  f.ready(a);
  f.ready(b);
  const bad = f.source(b);
  bad.links = [bad.links![0]!, bad.links![0]!, bad.links![1]!];
  expect(() => f.observe(b, bad)).toThrow('COORDINATION_EVIDENCE_MISSING');
  const fake = f.source(b);
  fake.text +=
    '\n[observed-link] {"name":"当前记录","url":"https://example.com/fake"}';
  expect(() =>
    f.command({
      kind: 'coordination-observed',
      taskId: b,
      runId: f.get(b).runId,
      session: f.session(b),
      source: fake,
      proposal: {
        ...f.proof(fake),
        target: { name: '当前记录', url: 'https://example.com/fake' },
      },
    }),
  ).toThrow('COORDINATION_EVIDENCE_MISSING');
  const aa = f.reserve(a).actionId;
  f.dispatch(a, aa);
  f.intent(a, 'stop');
  f.intent(b, 'stop');
  const c = f.add('3');
  expect(f.claim(c).claimed).toBe(true);
  f.command({
    kind: 'coordination-observed',
    taskId: c,
    runId: f.get(c).runId,
    session: f.session(c),
    source: { ...f.source(c), links: [] },
  });
  expect(f.reserve(c).result.created).toBe(false);
  expect(['dispatched', 'unknown']).toContain(f.get(a).actions[0]?.status);
});

test('长列表保留账号和目标核对所需的证据，超出本机观察上限仍停止', () => {
  const f = setup();
  const id = f.add('1');
  const fixture = f.source(id);
  const observe = (length: number) => {
    const nodes = [
      {
        nodeId: 'list',
        role: { value: 'StaticText' },
        name: { value: '表'.repeat(length) },
      },
      ...fixture.links!.map(({ name, url }, index) => ({
        nodeId: String(index),
        role: { value: 'link' },
        name: { value: name },
        properties: [{ name: 'url', value: { value: url } }],
      })),
      {
        nodeId: 'permission',
        role: { value: 'StaticText' },
        name: { value: '可编辑此记录' },
      },
    ];
    return pageObservation(
      { frameTree: { frame: { url: fixture.url } } },
      { nodes },
      1,
    );
  };
  const record = (source: PageObservation) =>
    f.command({
      kind: 'coordination-observed',
      taskId: id,
      runId: f.get(id).runId,
      session: f.session(id),
      source,
      proposal: f.proof(fixture),
    });
  expect(f.claim(id).claimed).toBe(true);
  const observed = observe(30000);
  expect(() => record(observed)).not.toThrow();
  expect(observed.truncated).toBe(false);
  expect(observed.text.indexOf('可编辑此记录')).toBeGreaterThan(30000);
  expect(f.get(id).coordination).toMatchObject({ status: 'ready' });

  const oversized = observe(80000);
  expect(oversized.truncated).toBe(true);
  expect(() => record(oversized)).toThrow('COORDINATION_STALE');
});

test('资源和会话关系进入备份、迁移与冷开引用检查；恢复仍暂停', async () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  const aa = f.reserve(a).actionId;
  f.dispatch(a, aa);
  const file = path.join(f.folder, 'coordination.helpr-backup');
  const { archive } = await f
    .records()
    .backup({ kind: 'create', requestId: 'backup', file });
  const target = setup();
  await target.records().backup({
    kind: 'restore',
    requestId: 'restore',
    file,
    checksum: archive.checksum,
  });
  expect(target.get(a)).toMatchObject({
    phase: 'paused',
    restoreReview: 'required',
    coordination: { status: 'unverified' },
    resourceClaims: [{ status: 'held' }],
  });
  f.records().close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=14');
  db.close();
  f.reopen();
  expect(
    readdirSync(f.folder).some((n) =>
      n.startsWith('workspace-before-coordination-16-'),
    ),
  ).toBe(true);
  expect(f.get(a).actions[0]?.status).toBe('unknown');
});

test('同一目标前项完成后，新改写必须取得本任务的取舍回复，内容确认不能替代', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('1');
  f.ready(a);
  f.ready(b);
  const aa = f.reserve(a).actionId;
  f.dispatch(a, aa);
  f.resolve(a, aa);
  expect(f.reserve(b).result.created).toBe(false);
  f.command({
    kind: 'finish',
    taskId: a,
    runId: f.get(a).runId,
    phase: 'complete',
    source: f.source(a),
    evidence: ['已保存'],
    summary: '已完成',
  });
  expect(f.claim(b).claimed).toBe(true);
  const fresh = f.source(b, 'alice', 2);
  f.observe(b, fresh);
  expect(f.get(b).coordination?.changedBy).toBe(a);
  expect(() => f.reserve(b, fresh)).toThrow('PARTICIPATION_REQUIRED');
  const questionId = randomUUID();
  f.command({
    kind: 'ask',
    taskId: b,
    runId: f.get(b).runId,
    coordinationDecision: true,
    questionId,
    text: '如何处理原结果？',
    url: f.urls.get(b),
  });
  f.command({
    kind: 'participation-reply',
    taskId: b,
    questionId,
    text: '保留前项结果并按本次要求追加。',
  });
  expect(f.get(b).coordination?.changedBy).toBeUndefined();
  f.recover(b);
  f.observe(b, fresh);
  expect(f.reserve(b, fresh).result.created).toBe(true);
});

test('共享登录保存失败整批回滚；未可靠保存的解除不会授予任何任务新资格', () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2');
  f.ready(a);
  f.ready(b);
  const before = f.records().snapshot();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  try {
    db.exec(
      `CREATE TRIGGER reject_coordination BEFORE UPDATE ON task_executions WHEN NEW.task_id='${b}' BEGIN SELECT RAISE(ABORT, 'SAVE_FAILED'); END`,
    );
    expect(() => f.login(a)).toThrow('SAVE_FAILED');
    expect(f.records().snapshot()).toEqual(before);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_coordination');
    db.close();
  }
  f.login(a);
  expect(f.get(b).runId).toBeNull();
  expect(f.get(b).coordination?.status).toBe('login');
});

test('公开执行入口的迟到预留回执不能越过会话撤权；另一网站继续，不产生旧写入', async () => {
  const f = setup(),
    a = f.add('1'),
    b = f.add('2', 'https://independent.test');
  let state = f.records().snapshot();
  let release!: () => void, entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const effects: string[] = [];
  const service = new ExecutionService({
    current: () => state,
    publish: (s) => {
      state = s;
    },
    records: async (command) => {
      const result = f.command(command);
      const c = command as { kind: string; taskId: string };
      if (c.kind === 'reserve' && c.taskId === a) {
        entered();
        await holding;
      }
      return result;
    },
    session: (id) => Promise.resolve(f.session(id)),
    observe: (id) =>
      Promise.resolve({
        observation: f.source(id),
        session: f.session(id),
        binding: { targetId: id, generation: 1 },
      }),
    propose: ({ taskId, pending }) =>
      Promise.resolve({
        decision: effects.includes(taskId) ? 'complete' : 'act',
        summary: '保存记录',
        evidence: ['已保存'],
        coordination: f.proof(f.source(taskId)),
        previous: pending
          ? { id: pending.id, status: 'confirmed', evidence: ['已保存'] }
          : null,
        action: effects.includes(taskId)
          ? null
          : {
              kind: 'click',
              target: { role: 'button', name: '保存', exact: true },
            },
      } satisfies NextStep),
    perform: (job) => {
      effects.push(job.taskId);
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
  });
  cleanup.push(() => service.disable());
  service.refresh();
  await started;
  // 暂停后保存的新会话事实比预留回执更新。
  await service.intent({
    kind: 'execution-intent',
    taskId: a,
    requestId: randomUUID(),
    intent: 'stop',
  });
  const next: SessionContext = f.contexts.changed('example.com')[0]!;
  await service.sessionChanged(next, [a]);
  release();
  await service.settled();
  expect(effects).toEqual([b]);
  expect(f.get(a)).toMatchObject({
    intent: 'stopped',
    coordination: { session: next },
  });
  expect(f.get(b).phase).toBe('complete');
});

test('共享存储监视只接受自有会话通知，只传来源；不向网页工作者增加读写能力', async () => {
  let notify!: (value: unknown) => void;
  const methods: string[] = [],
    origins: string[] = [];
  const monitor = new StorageMonitor(
    {
      client: (taskId) => ({
        taskId,
        targetId: taskId,
        generation: 1,
        token: 'private',
        revoked: false,
        inputEpoch: 0,
      }),
      close: () => Promise.resolve(),
      onEvent: (listener) => {
        notify = listener;
        return () => {};
      },
      protocol: (method) => {
        methods.push(method);
        return Promise.resolve(
          method === 'Target.attachToTarget' ? { sessionId: 'owned' } : {},
        );
      },
    },
    (origin) => origins.push(origin),
  );
  await monitor.ensure('task-a', 'https://example.com');
  await monitor.ensure('task-a', 'https://example.com');
  expect(methods).toEqual([
    'Target.attachToTarget',
    'DOMStorage.enable',
    'Storage.trackIndexedDBForOrigin',
  ]);
  notify({
    method: 'DOMStorage.domStorageItemUpdated',
    sessionId: 'foreign',
    params: {
      storageId: { isLocalStorage: true },
      key: 'secret',
      newValue: 'never forward',
    },
  });
  notify({
    method: 'DOMStorage.domStorageItemUpdated',
    sessionId: 'owned',
    params: {
      storageId: { isLocalStorage: false },
      key: 'secret',
      newValue: 'never forward',
    },
  });
  expect(origins).toEqual([]);
  notify({
    method: 'DOMStorage.domStorageItemUpdated',
    sessionId: 'owned',
    params: {
      storageId: {
        securityOrigin: 'https://example.com',
        isLocalStorage: true,
      },
      key: 'secret',
      newValue: 'never forward',
    },
  });
  notify({
    method: 'Storage.indexedDBContentUpdated',
    sessionId: 'owned',
    params: { origin: 'https://example.com', databaseName: 'private' },
  });
  expect(origins).toEqual(['https://example.com', 'https://example.com']);
});

test('未知派发与共享登录障碍同时保留；恢复登录不能授权重发', () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  const action = f.reserve(a).actionId;
  f.dispatch(a, action);
  f.login(a);
  expect(f.get(a).resourceClaims![0]!.status).toBe('held');
  f.intent(a, 'continue', { loginQuestionId: f.get(a).question!.id });
  f.recover(a);
  f.observe(a, f.source(a), true);
  f.command({
    kind: 'verified-login',
    taskId: a,
    runId: f.get(a).runId,
    source: f.source(a),
    evidence: ['账号 alice'],
  });
  expect(() => f.reserve(a)).toThrow('EXECUTION_RESULT_UNKNOWN');
  expect(f.get(a).actions).toHaveLength(1);
});

test('冷开拒绝缺失资源归属的动作引用，不把损坏资料当成空占用', () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  f.reserve(a);
  const e = f.get(a);
  e.resourceClaims = [];
  f.records().close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.prepare('UPDATE task_executions SET body=? WHERE task_id=?').run(
    JSON.stringify(e),
    a,
  );
  db.close();
  expect(() => f.reopen()).toThrow('DATA_CORRUPT');
});

test.each([1, 9])(
  '结果回显与只读规划交错时最多重读两次，已有动作不重发（%s）',
  async (changes) => {
    const f = setup(),
      a = f.add('1');
    let state = f.records().snapshot(),
      writes = 0,
      stale = 0,
      proposals = 0;
    const service = new ExecutionService({
      current: () => state,
      publish: (s) => {
        state = s;
      },
      records: (c) => Promise.resolve(f.command(c)),
      session: (id) => Promise.resolve(f.session(id)),
      observe: (id) =>
        Promise.resolve({
          observation: { ...f.source(id), fingerprint: String(writes) },
          session: f.session(id),
          binding: { targetId: id, generation: 1 },
        }),
      propose: ({ pending }) => {
        proposals++;
        if (pending && stale < changes) {
          stale++;
          return Promise.reject(Error('EXECUTION_PAGE_CHANGED'));
        }
        return Promise.resolve({
          decision: pending ? 'complete' : 'act',
          summary: '核对结果',
          evidence: ['已保存'],
          coordination: f.proof(f.source(a)),
          previous: pending
            ? { id: pending.id, status: 'confirmed', evidence: ['已保存'] }
            : null,
          action: pending
            ? null
            : {
                kind: 'click',
                target: { role: 'button', name: '保存', exact: true },
              },
        } satisfies NextStep);
      },
      perform: () => {
        writes++;
        return Promise.resolve();
      },
      revoke: () => {},
      stopModels: () => {},
    });
    cleanup.push(() => service.disable());
    service.refresh();
    await service.settled();
    expect(f.get(a).phase).toBe(changes === 1 ? 'complete' : 'unknown');
    expect(writes).toBe(1);
    expect(proposals).toBe(changes === 1 ? 3 : 4);
  },
);

test('登录核对失败后的新入口具有新请求身份，恢复原账号可再次核对且旧入口失效', () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  f.login(a);
  const first = f.get(a).question!.id;
  f.command({
    kind: 'intent',
    taskId: a,
    intent: 'continue',
    requestId: 'login:' + first,
    loginQuestionId: first,
    expectedVersion: f.get(a).version,
  });
  f.recover(a);
  f.observe(a, f.source(a, 'bob'), true);
  const next = f.get(a).question!.id;
  expect(next).not.toBe(first);
  expect(f.get(a).coordination?.account?.name).toBe('账号 alice');
  f.command({
    kind: 'intent',
    taskId: a,
    intent: 'continue',
    requestId: 'login:' + next,
    loginQuestionId: next,
    expectedVersion: f.get(a).version,
  });
  f.recover(a);
  f.observe(a, f.source(a), true);
  f.command({
    kind: 'verified-login',
    taskId: a,
    runId: f.get(a).runId,
    source: f.source(a),
    evidence: ['账号 alice'],
  });
  expect(f.get(a).loginOrigin).toBeUndefined();
  expect(() => f.intent(a, 'continue', { loginQuestionId: first })).toThrow(
    'PARTICIPATION_EXPIRED',
  );
});

test('登录核对准备期间新会话已保存：旧版本拒绝后保留可重试入口和退出资格', async () => {
  const f = setup(),
    a = f.add('1');
  f.ready(a);
  f.login(a);
  let state = f.records().snapshot();
  let changed = false;
  const service = new ExecutionService({
    current: () => state,
    publish: (s) => {
      state = s;
    },
    records: (c) => Promise.resolve(f.command(c)),
    observe: () => Promise.reject(Error('UNEXPECTED_OBSERVE')),
    propose: () => Promise.reject(Error('UNEXPECTED_MODEL')),
    perform: () => Promise.reject(Error('UNEXPECTED_DISPATCH')),
    revoke: () => {},
    stopModels: () => {},
    input: {
      prepare: async () => {
        if (!changed) {
          changed = true;
          await service.sessionChanged(f.contexts.changed('example.com')[0]!, [
            a,
          ]);
        }
        return 1;
      },
      block: () => {},
      allow: () => true,
      epoch: () => 1,
      valid: () => true,
      permit: (_id, _epoch, send) => send(),
    },
  });
  cleanup.push(() => service.disable());
  const questionId = f.get(a).question!.id;
  await expect(
    service.reply({
      kind: 'participation-decision',
      operation: 'login-check',
      taskId: a,
      questionId,
    }),
  ).rejects.toThrow('RECORD_VERSION_CONFLICT');
  expect(service.canExit()).toBe(true);
  expect(
    service.decorate(state).tasks.find((t) => t.id === a)?.executionControl
      ?.stopSaved,
  ).not.toBe(false);
  expect(f.get(a).question?.id).toBe(questionId);
  expect(f.get(a).phase).toBe('paused');
  await expect(
    service.reply({
      kind: 'participation-decision',
      operation: 'login-check',
      taskId: a,
      questionId,
    }),
  ).resolves.toBeDefined();
  expect(f.get(a).intentId).toBe('login:' + questionId);
  expect(f.get(a).question).toBeUndefined();
});
