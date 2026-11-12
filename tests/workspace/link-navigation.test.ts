import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import { ActionNavigationWindows } from '../../app/desktop/action-navigation';
import { actionFactSchema } from '../../app/shared/execution';
import { expectedNavigationLink } from '../../app/shared/action-navigation';
import type { PageObservation } from '../../app/shared/model';
import { pageObservation } from '../../app/desktop/page-observation';
import { webActionSchema } from '../../app/shared/web-action';

const folders: string[] = [];
afterEach(() =>
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
const from = 'https://example.com/list',
  to = 'https://example.com/item/42';
const link = {
  kind: 'click' as const,
  target: { role: 'link' as const, name: '打开条目', exact: true },
};
function setup() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-link-'));
  folders.push(folder);
  const r = new WorkspaceRecords(folder, 'app/records/migrations');
  const taskId = r.execute({
    kind: 'create',
    requestId: 'create',
    goal: '核对 ' + from,
  }).taskId;
  r.execute({
    kind: 'page',
    requestId: 'ready',
    taskId,
    url: from,
    phase: 'manual',
  });
  r.execution({ kind: 'intent', requestId: 'start', taskId, intent: 'start' });
  r.execution({ kind: 'claim', taskId, runId: 'one' });
  const source: PageObservation = {
    url: from,
    title: '列表',
    fingerprint: 'before',
    generation: 3,
    observedAt: 1,
    truncated: false,
    text: '打开条目',
    links: [{ name: '打开条目', url: to }],
  };
  r.execution({
    kind: 'reserve',
    taskId,
    runId: 'one',
    id: 'a',
    summary: '打开条目',
    action: link,
    effect: 'interaction',
    source,
    binding: { targetId: 'page', generation: 3 },
  });
  r.execution({ kind: 'dispatch', taskId, runId: 'one', id: 'a' });
  const windows = new ActionNavigationWindows(() => 1000);
  windows.arm({
    taskId,
    runId: 'one',
    actionId: 'a',
    targetId: 'page',
    generation: 3,
    inputEpoch: 7,
  });
  const event = windows.started({
    taskId,
    targetId: 'page',
    generation: 3,
    inputEpoch: 7,
    available: true,
    blocked: false,
    url: to,
    mainFrame: true,
    sameDocument: false,
  })!;
  const proof = {
    taskId,
    runId: 'one',
    actionId: 'a',
    targetId: 'page',
    generation: 3,
    inputEpoch: 7,
    reason: 'anchorClick' as const,
    url: to,
    requestedAt: 1000,
  };
  const after = {
    url: to,
    title: '条目42',
    fingerprint: 'after',
    generation: 4,
    observedAt: 1100,
    truncated: false,
  };
  const suspend = () =>
    r.execution({
      kind: 'suspend',
      requestId: 'navigation',
      taskId,
      reason: 'page-change',
    });
  const page = () =>
    r.execute({
      kind: 'page',
      requestId: 'arrived',
      taskId,
      url: to,
      phase: 'manual',
    });
  const resolve = () =>
    r.execution({
      kind: 'navigation-resolved',
      taskId,
      expectedVersion: r.snapshot().tasks[0]!.execution!.version,
      resolution: { proof, source: after, pausedInputEpoch: 9 },
    });
  return {
    folder,
    r,
    taskId,
    source,
    event,
    proof,
    after,
    suspend,
    page,
    resolve,
  };
}

test('只有唯一精确同站主frame链接成为预期导航，拒绝跨站/重名/模糊/子frame/截断', () => {
  const source = { url: from, truncated: false },
    links = [{ name: '打开条目', url: to }];
  expect(expectedNavigationLink(link, source, links)).toBe(to);
  for (const action of [
    { ...link, target: { ...link.target, exact: false } },
    { ...link, target: { ...link.target, frameUrl: to } },
    { ...link, target: { ...link.target, role: 'button' as const } },
    {
      ...link,
      target: {
        ...link.target,
        within: { role: 'row' as const, name: '行', exact: true },
      },
    },
  ])
    expect(expectedNavigationLink(action, source, links)).toBeUndefined();
  for (const list of [
    [],
    [...links, ...links],
    [{ name: '打开条目', url: 'https://other.com/item' }],
    [{ name: '打开条目', url: to + '#fragment' }],
  ])
    expect(expectedNavigationLink(link, source, list)).toBeUndefined();
  expect(
    expectedNavigationLink(link, { ...source, truncated: true }, links),
  ).toBeUndefined();
});

test('按网页区域分别定位主内容和侧栏的同名链接', () => {
  const name = link.target.name;
  const sidebarUrl = 'https://example.com/item/side';
  const anchor = (nodeId: string, href: string) => ({
    nodeId,
    role: { value: 'link' },
    name: { value: name },
    properties: [{ name: 'url', value: { value: href } }],
  });
  const observe = (secondMain = false) =>
    pageObservation(
      { frameTree: { frame: { url: from } } },
      {
        nodes: [
          {
            nodeId: 'root',
            role: { value: 'RootWebArea' },
            childIds: ['main', 'menu'],
          },
          {
            nodeId: 'main',
            role: { value: 'main' },
            childIds: secondMain ? ['a', 'c'] : ['a'],
          },
          {
            nodeId: 'menu',
            role: { value: 'navigation' },
            name: { value: '侧栏' },
            childIds: ['b'],
          },
          anchor('a', to),
          anchor('b', sidebarUrl),
          ...(secondMain ? [anchor('c', to)] : []),
        ],
      },
      3,
    );
  const inMain = webActionSchema.parse({
    ...link,
    target: { ...link.target, within: { role: 'main', name: '', exact: true } },
  });
  const inSidebar = webActionSchema.parse({
    ...link,
    target: {
      ...link.target,
      within: { role: 'navigation', name: '侧栏', exact: true },
    },
  });
  const observed = observe();
  expect(expectedNavigationLink(inMain, observed, observed.links)).toBe(to);
  expect(expectedNavigationLink(inSidebar, observed, observed.links)).toBe(
    sidebarUrl,
  );
  expect(
    expectedNavigationLink(link, observed, observed.links),
  ).toBeUndefined();
  const ambiguous = observe(true);
  expect(
    expectedNavigationLink(inMain, ambiguous, ambiguous.links),
  ).toBeUndefined();
});

test('核对新页面后原子保存检查点并排队，冷开保留动作确认、旧动作不可重派发，23迁移先备份', () => {
  const f = setup();
  let r = f.r;
  try {
    f.suspend();
    f.page();
    r.execution({ kind: 'action-navigation', ...f.event });
    expect(f.resolve().recovered).toBe(true);
    const a = r.snapshot().tasks[0]!.execution!.actions[0]!;
    expect(a.status).toBe('confirmed');
    expect(a.navigationResolution?.source.url).toBe(to);
    expect(r.snapshot().tasks[0]!.execution!.phase).toBe('queued');
    expect(r.snapshot().tasks[0]!.execution!.pauseReason).toBeUndefined();
    r.close();
    r = new WorkspaceRecords(f.folder, 'app/records/migrations');
    expect(r.snapshot().tasks[0]!.execution!.actions[0]).toEqual(a);
    expect(
      r.execution({ kind: 'dispatch', taskId: f.taskId, runId: 'one', id: 'a' })
        .permitted,
    ).toBe(false);
    r.close();
    const db = new Database(path.join(f.folder, 'workspace.sqlite'));
    db.prepare('UPDATE workspace SET schema_version=23').run();
    db.close();
    r = new WorkspaceRecords(f.folder, 'app/records/migrations');
    expect(
      readdirSync(f.folder).some((name) =>
        name.startsWith('workspace-before-link-navigation-23-'),
      ),
    ).toBe(true);
    expect(r.snapshot().tasks[0]!.execution!.actions[0]).toEqual(a);
  } finally {
    r.close();
  }
});

test('时间关联本身不能恢复：目的URL、代次、原生epoch或首frame证据冲突均回滚', () => {
  const f = setup();
  try {
    f.suspend();
    f.page();
    f.r.execution({ kind: 'action-navigation', ...f.event });
    const a = f.r.snapshot().tasks[0]!.execution!.actions[0]!;
    for (const resolution of [
      {
        proof: { ...f.proof, url: from },
        source: f.after,
        pausedInputEpoch: 9,
      },
      {
        proof: f.proof,
        source: { ...f.after, generation: 5 },
        pausedInputEpoch: 9,
      },
      { proof: f.proof, source: f.after, pausedInputEpoch: 10 },
      {
        proof: f.proof,
        source: { ...f.after, truncated: true },
        pausedInputEpoch: 9,
      },
    ]) {
      expect(() =>
        f.r.execution({
          kind: 'navigation-resolved',
          taskId: f.taskId,
          expectedVersion: f.r.snapshot().tasks[0]!.execution!.version,
          resolution,
        }),
      ).toThrow();
      expect(f.r.snapshot().tasks[0]!.execution!.actions[0]).toEqual(a);
    }
    expect(
      actionFactSchema.safeParse({
        ...a,
        status: 'confirmed',
        navigation: { ...a.navigation, mainFrame: false },
        navigationResolution: {
          proof: f.proof,
          source: f.after,
          pausedInputEpoch: 9,
        },
      }).success,
    ).toBe(false);
    f.r.execution({
      kind: 'intent',
      taskId: f.taskId,
      requestId: 'stop',
      intent: 'stop',
    });
    expect(f.resolve().recovered).toBe(false);
    expect(f.r.snapshot().tasks[0]!.execution!.intent).toBe('stopped');
  } finally {
    f.r.close();
  }
});

for (const race of [
  'none',
  'stop-before-read',
  'input-before-read',
  'stop-after-save',
  'input-after-save',
  'different-page',
  'save-failure',
] as const) {
  test('执行入口只读核对、自动续行与竞争：' + race, async () => {
    const f = setup();
    let state = f.r.snapshot(),
      epoch = 8,
      allowed = 0,
      plans = 0,
      performed = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ExecutionService({
      current: () => state,
      publish: (next) => {
        state = next;
      },
      records: async (command) => {
        if (
          (command as { kind: string }).kind === 'navigation-resolved' &&
          race === 'save-failure'
        )
          throw Error('RECORDS_UNAVAILABLE');
        const result = f.r.execution(command);
        if ((command as { kind: string }).kind === 'navigation-resolved') {
          if (race === 'input-after-save') epoch++;
          if (race === 'stop-after-save')
            await service.intent({
              kind: 'execution-intent',
              taskId: f.taskId,
              intent: 'stop',
              requestId: 'new-stop',
            });
        }
        return result;
      },
      navigationReady: async () => {
        await held;
        return true;
      },
      observe: () =>
        Promise.resolve({
          binding: {
            targetId: race === 'different-page' ? 'other' : 'page',
            generation: 4,
          },
          observation: { ...f.after, text: '条目42' },
        }),
      propose: () => {
        plans++;
        return Promise.resolve({
          decision: 'complete',
          previous: null,
          action: null,
          summary: '核对完成',
          evidence: ['条目42'],
        });
      },
      perform: () => {
        performed++;
        return Promise.resolve();
      },
      revoke: () => {},
      stopModels: () => {},
      input: {
        prepare: () => Promise.resolve(epoch),
        block: () => {
          epoch++;
        },
        epoch: () => epoch,
        valid: (_id, e) => e === epoch,
        allow: (_id, e) => {
          if (e !== epoch) return false;
          allowed++;
          return true;
        },
        permit: (_id, _e, send) => send(),
      },
    });
    try {
      await service.suspend(f.taskId, 'page-change', 'navigation');
      f.page();
      state = f.r.snapshot();
      service.acceptLinkNavigation(f.proof);
      await service.recordNavigation(f.event);
      if (race === 'stop-before-read')
        await service.intent({
          kind: 'execution-intent',
          taskId: f.taskId,
          intent: 'stop',
          requestId: 'stop',
        });
      if (race === 'input-before-read') epoch++;
      release();
      await service.settled();
      expect(performed).toBe(0);
      if (race === 'none') {
        expect(allowed).toBe(1);
        expect(plans).toBe(1);
        expect(state.tasks[0]!.execution!.phase).toBe('complete');
        expect(state.tasks[0]!.execution!.actions[0]!.status).toBe('confirmed');
      } else {
        expect(allowed).toBe(0);
        expect(plans).toBe(0);
        if (race.startsWith('stop-'))
          expect(state.tasks[0]!.execution!.intent).toBe('stopped');
        expect(state.tasks[0]!.execution!.phase).not.toBe('queued');
      }
    } finally {
      release();
      await service.stopAll();
      f.r.close();
    }
  });
}

test('独立浏览器订阅只接受所属鼠标发送后的主frame anchorClick，不从脚本、表单或其它任务推断', async () => {
  const { LinkNavigationWatch } =
    await import('../../app/desktop/link-navigation');
  for (const scenario of [
    'valid',
    'no-input',
    'other-task',
    'script',
    'form',
    'subframe',
    'new-tab',
    'different-url',
  ] as const) {
    let inputListener: Parameters<
      import('../../app/desktop/observation-broker').ObservationBroker['onInputSent']
    >[0] = () => {};
    let listener: (event: unknown) => void = () => {};
    const proofs: unknown[] = [];
    let closed = 0;
    const q = {
      taskId: 'a',
      targetId: 'page',
      generation: 3,
      inputEpoch: 7,
      token: 'private',
      revoked: false,
      sessionId: 'session',
    };
    const watch = new LinkNavigationWatch(
      {
        client: () => q,
        observe: () =>
          Promise.resolve({ frameTree: { frame: { id: 'main' } } }),
        protocol: () => Promise.resolve({}),
        close: () => {
          closed++;
          return Promise.resolve();
        },
        onEvent: (l) => {
          listener = l;
          return () => {
            listener = () => {};
          };
        },
        onInputSent: (l) => {
          inputListener = l;
          return () => {};
        },
      },
      (proof) => proofs.push(proof),
    );
    await watch.start({
      taskId: 'a',
      runId: 'r',
      actionId: 'act',
      action: link,
      source: {
        url: from,
        title: '',
        text: '',
        fingerprint: 'one',
        generation: 3,
        observedAt: 1,
        truncated: false,
        links: [{ name: '打开条目', url: to }],
      },
      binding: { targetId: 'page', generation: 3 },
      signal: new AbortController().signal,
      qualified: () => true,
    });
    if (scenario !== 'no-input')
      inputListener(
        { ...q, taskId: scenario === 'other-task' ? 'b' : 'a' },
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', button: 'left' },
      );
    listener({
      sessionId: 'session',
      method: 'Page.frameRequestedNavigation',
      params: {
        frameId: scenario === 'subframe' ? 'child' : 'main',
        reason:
          scenario === 'script'
            ? 'scriptInitiated'
            : scenario === 'form'
              ? 'formSubmissionPost'
              : 'anchorClick',
        disposition: scenario === 'new-tab' ? 'newTab' : 'currentTab',
        url: scenario === 'different-url' ? from : to,
      },
    });
    expect(proofs).toHaveLength(scenario === 'valid' ? 1 : 0);
    expect(closed).toBe(1);
    watch.dispose();
  }
});

test('表单订阅仅接受实际点击后同站主frame POST；拒绝链接、脚本、GET、跨站、片段和截断', async () => {
  const { LinkNavigationWatch } =
    await import('../../app/desktop/link-navigation');
  for (const scenario of [
    'valid',
    'no-input',
    'other-task',
    'script',
    'link',
    'get',
    'fragment',
    'truncated',
    'no-creation',
    'subframe',
    'new-tab',
    'different-url',
  ] as const) {
    let inputListener: Parameters<
      import('../../app/desktop/observation-broker').ObservationBroker['onInputSent']
    >[0] = () => {};
    let listener: (event: unknown) => void = () => {};
    const proofs: unknown[] = [];
    let closed = 0;
    const q = {
      taskId: 'a',
      targetId: 'page',
      generation: 3,
      inputEpoch: 7,
      token: 'private',
      revoked: false,
      sessionId: 'session',
    };
    const watch = new LinkNavigationWatch(
      {
        client: () => q,
        observe: () =>
          Promise.resolve({ frameTree: { frame: { id: 'main' } } }),
        protocol: () => Promise.resolve({}),
        close: () => {
          closed++;
          return Promise.resolve();
        },
        onEvent: (l) => {
          listener = l;
          return () => {
            listener = () => {};
          };
        },
        onInputSent: (l) => {
          inputListener = l;
          return () => {};
        },
      },
      () => {
        throw Error('UNEXPECTED_LINK_PROOF');
      },
      (proof) => proofs.push(proof),
    );
    await watch.start({
      taskId: 'a',
      runId: 'r',
      actionId: 'act',
      action: {
        kind: 'click',
        target: { role: 'button', name: '创建草稿', exact: true },
      },
      targetCreation:
        scenario === 'no-creation'
          ? undefined
          : {
              rule: 'same-site-editor-v1',
              fields: [{ name: '标题', value: '草稿' }],
              destination: '公告',
            },
      source: {
        url: from,
        title: '',
        text: '公告',
        controls: [
          {
            role: 'textbox',
            name: '标题',
            textValue: '草稿',
            disabled: false,
            frameUrl: from,
          },
        ],
        fingerprint: 'one',
        generation: 3,
        observedAt: 1,
        truncated: scenario === 'truncated',
        links: [{ name: '打开条目', url: to }],
      },
      binding: { targetId: 'page', generation: 3 },
      signal: new AbortController().signal,
      qualified: () => true,
    });
    if (scenario !== 'no-input')
      inputListener(
        { ...q, taskId: scenario === 'other-task' ? 'b' : 'a' },
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', button: 'left' },
      );
    listener({
      sessionId: 'session',
      method: 'Page.frameRequestedNavigation',
      params: {
        frameId: scenario === 'subframe' ? 'child' : 'main',
        reason:
          scenario === 'script'
            ? 'scriptInitiated'
            : scenario === 'link'
              ? 'anchorClick'
              : scenario === 'get'
                ? 'formSubmissionGet'
                : 'formSubmissionPost',
        disposition: scenario === 'new-tab' ? 'newTab' : 'currentTab',
        url:
          scenario === 'different-url'
            ? 'https://other.com/editor'
            : scenario === 'fragment'
              ? to + '#part'
              : to,
      },
    });
    if (scenario === 'valid') {
      const send = (method: string, params: unknown) =>
        listener({ sessionId: 'session', method, params });
      send('Network.requestWillBeSent', {
        requestId: 'req',
        loaderId: 'loader',
        frameId: 'main',
        type: 'Document',
        request: { url: to, method: 'POST' },
      });
      send('Network.responseReceived', {
        requestId: 'req',
        loaderId: 'loader',
        frameId: 'main',
        type: 'Document',
        response: { url: to, status: 200 },
      });
      send('Page.frameNavigated', {
        frame: { id: 'main', loaderId: 'loader', url: to },
      });
      send('Network.loadingFinished', { requestId: 'req' });
    }
    expect(proofs).toHaveLength(scenario === 'valid' ? 1 : 0);
    expect(closed).toBe(
      ['truncated', 'no-creation'].includes(scenario) ? 0 : 1,
    );
    watch.dispose();
  }
});
