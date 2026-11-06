import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';

const folders: string[] = [];
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true })),
);

test.each([3, 10, 11])(
  '格式 %i 旧资料升级前留下独立副本，任务与草稿保留，后续重开不重复备份',
  (version) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-04-'));
    folders.push(folder);
    let records = new WorkspaceRecords(folder, 'app/records/migrations');
    const { taskId } = records.execute({
      kind: 'create',
      requestId: 'a',
      goal: '已有任务',
    });
    records.execute({
      kind: 'draft',
      requestId: 'draft',
      taskId,
      text: '保留的中文草稿',
    });
    records.close();
    // 外部旧格式夹具：相同任务字段、不含新增素材；在迁移前留下原库。
    const old = new Database(path.join(folder, 'workspace.sqlite'));
    old.prepare('UPDATE workspace SET schema_version=?').run(version);
    old.close();
    records = new WorkspaceRecords(folder, 'app/records/migrations');
    expect(records.snapshot().tasks[0]).toMatchObject({
      id: taskId,
      draft: '保留的中文草稿',
    });
    records.close();
    const backups = readdirSync(folder).filter((name) =>
      name.startsWith(
        version === 11
          ? 'workspace-before-publication-13-'
          : version === 10
            ? 'workspace-before-material-12-'
            : 'workspace-before-recovery-05-',
      ),
    );
    expect(backups).toHaveLength(1);
    records = new WorkspaceRecords(folder, 'app/records/migrations');
    records.close();
    expect(
      readdirSync(folder).filter((name) =>
        name.startsWith(
          version === 11
            ? 'workspace-before-publication-13-'
            : version === 10
              ? 'workspace-before-material-12-'
              : 'workspace-before-recovery-05-',
        ),
      ),
    ).toHaveLength(1);
    const recovered = mkdtempSync(path.join(tmpdir(), 'helpr-backup-04-'));
    folders.push(recovered);
    copyFileSync(
      path.join(folder, backups[0]!),
      path.join(recovered, 'workspace.sqlite'),
    );
    records = new WorkspaceRecords(recovered, 'app/records/migrations');
    expect(records.snapshot().tasks[0]).toMatchObject({
      id: taskId,
      draft: '保留的中文草稿',
    });
    records.close();
  },
);

test('两项任务重开后保留原身份和各自对话', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-records-'));
  folders.push(folder);
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  const a = records.execute({
    kind: 'create',
    requestId: 'a',
    goal: '发布经营周报',
  });
  const b = records.execute({
    kind: 'create',
    requestId: 'b',
    goal: '整理团队资料',
  });
  records.execute({
    kind: 'message',
    requestId: 'say-a',
    taskId: a.taskId,
    text: '只属于 A 的要求',
  });
  records.execute({
    kind: 'message',
    requestId: 'say-b',
    taskId: b.taskId,
    text: '只属于 B 的要求',
  });
  records.close();
  records = new WorkspaceRecords(folder, 'app/records/migrations');
  const state = records.snapshot();
  expect(state.tasks.map((t) => [t.id, t.goal])).toEqual([
    [a.taskId, '发布经营周报'],
    [b.taskId, '整理团队资料'],
  ]);
  expect(
    state.tasks.map((t) =>
      t.messages.filter((m) => m.role === 'user').map((m) => m.text),
    ),
  ).toEqual([
    ['发布经营周报', '只属于 A 的要求'],
    ['整理团队资料', '只属于 B 的要求'],
  ]);
  records.close();
});

test('分组创建与停止关闭可重送，历史回看和旧关闭提示不改变新执行', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-groups-'));
  folders.push(folder);
  let r = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    const create = {
      kind: 'create',
      requestId: 'groups',
      goal: '把 https://source.test 的周报分别发到 https://a.test 和 https://b.test',
    };
    const { taskId: a, state } = r.execute(create);
    const b = state.tasks[1]!;
    expect(state.tasks.map((t) => t.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(b.groupId).toBeTruthy();
    expect(b.groupId).toBe(state.tasks[0]?.groupId);
    expect(r.execute(create).state.tasks).toHaveLength(2);
    const stop = {
      kind: 'intent',
      intent: 'stop',
      requestId: 'stop-close',
      closeAtVersion: 0,
      taskId: a,
    };
    r.execution(stop);
    r.execution(stop);
    expect(r.snapshot().active).toBe(b.id);
    r.close();
    r = new WorkspaceRecords(folder, 'app/records/migrations');
    r.execute({ kind: 'select', taskId: a, requestId: 'reopen' });
    expect(r.snapshot().tasks[0]).toMatchObject({
      archived: true,
      hidden: false,
      execution: { intent: 'stopped' },
    });
    r.execution({
      kind: 'intent',
      intent: 'continue',
      requestId: 'continue',
      taskId: a,
    });
    expect(() => r.execution({ ...stop, requestId: 'late' })).toThrow(
      'RECORD_VERSION_CONFLICT',
    );
    expect(() =>
      r.execute({ kind: 'archive-task', taskId: a, requestId: 'late-archive' }),
    ).toThrow('RECORD_VERSION_CONFLICT');
    expect(r.snapshot().tasks[1]?.execution).toBeNull();
    r.execute({
      kind: 'page',
      phase: 'manual',
      url: 'https://a.test/',
      taskId: a,
      requestId: 'page',
    });
    r.execution({ kind: 'claim', taskId: a, runId: 'check' });
    r.execution({
      kind: 'ask',
      taskId: a,
      runId: 'check',
      url: 'https://a.test/',
      questionId: crypto.randomUUID(),
      text: '目标栏目是哪个？',
    });
    expect(r.snapshot().tasks[0]).toMatchObject({
      archived: false,
      hidden: false,
      execution: { phase: 'paused' },
    });
    expect(
      r
        .execute({ ...create, requestId: 'one', keepTogether: true })
        .state.tasks.at(-1)?.goal,
    ).toBe(create.goal);
    expect(
      r.execute({
        ...create,
        requestId: 'sequence',
        goal: '从 A 读取后，然后发布到 B 和 C',
      }).state.tasks,
    ).toHaveLength(4);
  } finally {
    r.close();
  }
});
