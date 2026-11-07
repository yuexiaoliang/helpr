import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ActionNavigationWindows } from '../../app/desktop/action-navigation';
import { WorkspaceRecords } from '../../app/records/workspace';
import { actionFactSchema } from '../../app/shared/execution';

const binding = { targetId: 'page-a', generation: 3 };
const window = {
  taskId: 'a',
  runId: 'one',
  actionId: 'action-one',
  ...binding,
  inputEpoch: 7,
};
const navigation = {
  taskId: 'a',
  ...binding,
  inputEpoch: 7,
  blocked: false,
  available: true,
  url: 'https://example.com/item/42',
  mainFrame: true,
  sameDocument: false,
};
const folders: string[] = [];
afterEach(() =>
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup(dispatch = true) {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-navigation-'));
  folders.push(folder);
  const r = new WorkspaceRecords(folder, 'app/records/migrations');
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
  r.execution({ kind: 'intent', requestId: 'start', taskId, intent: 'start' });
  r.execution({ kind: 'claim', taskId, runId: 'one' });
  r.execution({
    kind: 'reserve',
    taskId,
    runId: 'one',
    id: 'action-one',
    summary: '打开条目',
    action: { kind: 'click', target: { role: 'button', name: '打开条目' } },
    source: {
      url: 'https://example.com/list',
      title: '清单',
      fingerprint: 'before',
      generation: 3,
      observedAt: 1,
      truncated: false,
      text: 'button 打开条目',
    },
    binding,
  });
  if (dispatch)
    r.execution({ kind: 'dispatch', taskId, runId: 'one', id: 'action-one' });
  const windows = new ActionNavigationWindows(() => 1000);
  windows.arm({ ...window, taskId });
  const event = windows.started({ ...navigation, taskId })!;
  return {
    r,
    folder,
    taskId,
    event,
    command: { kind: 'action-navigation', ...event },
  };
}

test('首个导航只记录动作窗口相关性；子frame和同文档保留原属性，不推定成功或归属', () => {
  for (const flags of [
    { mainFrame: true, sameDocument: false },
    { mainFrame: false, sameDocument: false },
    { mainFrame: true, sameDocument: true },
  ]) {
    const windows = new ActionNavigationWindows(() => 1000);
    windows.arm(window);
    expect(windows.started({ ...navigation, ...flags })).toMatchObject({
      taskId: 'a',
      runId: 'one',
      actionId: 'action-one',
      navigation: {
        association: 'during-action',
        sourceGeneration: 3,
        generation: 4,
        inputEpoch: 7,
        ...flags,
      },
    });
    expect(windows.started(navigation)).toBeUndefined();
  }
});

test('手动输入代次、已阻断、能力不可用、页面替换、陈旧代次、过期或未知导航不关联动作', () => {
  for (const change of [
    { inputEpoch: 8 },
    { blocked: true },
    { available: false },
    { targetId: 'other' },
    { generation: 4 },
    { url: 'file:///tmp/local' },
  ]) {
    const windows = new ActionNavigationWindows(() => 1000);
    windows.arm(window);
    expect(windows.started({ ...navigation, ...change })).toBeUndefined();
    expect(windows.started(navigation)).toBeUndefined();
  }
  let now = 1000;
  const windows = new ActionNavigationWindows(() => now);
  expect(windows.started(navigation)).toBeUndefined();
  windows.arm(window);
  now += 16000;
  expect(windows.started(navigation)).toBeUndefined();
});

test('结束和暂停消除窗口；迟到清理不移除新动作；A导航不消费B窗口', () => {
  const windows = new ActionNavigationWindows(() => 1000);
  windows.arm(window);
  expect(() => windows.arm(window)).toThrow('ACTION_WINDOW_EXISTS');
  windows.disarm('a', 'action-one');
  windows.arm({ ...window, actionId: 'action-two' });
  windows.disarm('a', 'action-one');
  windows.arm({ ...window, taskId: 'b' });
  expect(windows.started(navigation)?.actionId).toBe('action-two');
  expect(windows.started({ ...navigation, taskId: 'b' })?.actionId).toBe(
    'action-one',
  );
  windows.arm(window);
  windows.disarm('a');
  expect(windows.started(navigation)).toBeUndefined();
});

test('动作派发与来源精确匹配才保存导航；幂等、冲突及未派发反例', () => {
  const f = setup();
  try {
    for (const command of [
      { ...f.command, runId: 'other-run' },
      { ...f.command, actionId: 'other-action' },
      {
        ...f.command,
        navigation: { ...f.event.navigation, targetId: 'other-page' },
      },
      {
        ...f.command,
        navigation: {
          ...f.event.navigation,
          sourceGeneration: 4,
          generation: 5,
        },
      },
    ])
      expect(() => f.r.execution(command)).toThrow('ACTION_NOT_OWNED');
    expect(f.r.execution(f.command).recorded).toBe(true);
    expect(f.r.execution(f.command).recorded).toBe(false);
    expect(() =>
      f.r.execution({
        ...f.command,
        navigation: { ...f.event.navigation, url: 'https://example.com/other' },
      }),
    ).toThrow('REQUEST_CONTENT_CONFLICT');
    expect(f.r.snapshot().tasks[0]!.execution!.actions[0]).toMatchObject({
      status: 'dispatched',
      returned: false,
      navigation: f.event.navigation,
    });
  } finally {
    f.r.close();
  }
  const pending = setup(false);
  try {
    expect(() => pending.r.execution(pending.command)).toThrow(
      'ACTION_NOT_OWNED',
    );
  } finally {
    pending.r.close();
  }
});

test('暂停和停止之后迟到导航仅补事实，冷开及备份保留，继续不能重发旧动作', async () => {
  const f = setup();
  let r = f.r;
  try {
    r.execution({
      kind: 'suspend',
      taskId: f.taskId,
      requestId: 'page-change',
      reason: 'page-change',
    });
    r.execution({
      kind: 'intent',
      taskId: f.taskId,
      requestId: 'stop',
      intent: 'stop',
    });
    const before = r.snapshot().tasks[0]!.execution!;
    r.execution(f.command);
    const after = r.snapshot().tasks[0]!.execution!;
    expect({ ...after, actions: before.actions }).toEqual(before);
    expect(after.actions[0]).toMatchObject({
      status: 'unknown',
      returned: false,
      navigation: f.event.navigation,
    });
    const { archive } = await r.backup({
      kind: 'create',
      requestId: 'backup',
      file: path.join(f.folder, 'navigation.helpr-backup'),
    });
    expect(archive).toBeTruthy();
    r.close();
    r = new WorkspaceRecords(f.folder, 'app/records/migrations');
    expect(r.snapshot().tasks[0]!.execution!.actions[0]!.navigation).toEqual(
      f.event.navigation,
    );
    expect(r.snapshot().tasks[0]!.execution!.intent).toBe('stopped');
    r.execution({
      kind: 'intent',
      taskId: f.taskId,
      requestId: 'continue',
      intent: 'continue',
    });
    r.execution({ kind: 'claim', taskId: f.taskId, runId: 'two' });
    expect(
      r.execution({
        kind: 'dispatch',
        taskId: f.taskId,
        runId: 'one',
        id: 'action-one',
      }).permitted,
    ).toBe(false);
    // 结构校验也覆盖备份导入／冷开，禁止损坏的来源关联或伪造成功分类。
    const a = r.snapshot().tasks[0]!.execution!.actions[0]!;
    expect(
      actionFactSchema.safeParse({
        ...a,
        binding: { ...a.binding, targetId: 'other' },
      }).success,
    ).toBe(false);
    expect(
      actionFactSchema.safeParse({
        ...a,
        navigation: { ...a.navigation, association: 'verified' },
      }).success,
    ).toBe(false);
  } finally {
    r.close();
  }
});

test('格式22迁移先备份，不给历史动作补造导航；损坏关联冷开拒绝', () => {
  const f = setup();
  f.r.execution({
    kind: 'intent',
    taskId: f.taskId,
    requestId: 'stop',
    intent: 'stop',
  });
  f.r.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.prepare('UPDATE workspace SET schema_version=22').run();
  db.close();
  const migrated = new WorkspaceRecords(f.folder, 'app/records/migrations');
  try {
    expect(
      migrated.snapshot().tasks[0]!.execution!.actions[0]!.navigation,
    ).toBeUndefined();
    expect(
      readdirSync(f.folder).some((p) =>
        p.startsWith('workspace-before-action-navigation-23-'),
      ),
    ).toBe(true);
    migrated.execution(f.command);
  } finally {
    migrated.close();
  }
  const corrupt = new Database(path.join(f.folder, 'workspace.sqlite'));
  const row = corrupt
    .prepare('SELECT body FROM task_executions WHERE task_id=?')
    .get(f.taskId) as { body: string };
  const body = JSON.parse(row.body) as {
    actions: { navigation: { sourceGeneration: number } }[];
  };
  body.actions[0]!.navigation.sourceGeneration = 99;
  corrupt
    .prepare('UPDATE task_executions SET body=? WHERE task_id=?')
    .run(JSON.stringify(body), f.taskId);
  corrupt.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow();
});
