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

test('旧资料升级前留下独立副本，任务与草稿保留，后续重开不重复备份', () => {
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
  // 外部输入夹具：03 的 SQL 结构相同，但记录格式版本为 3。
  const old = new Database(path.join(folder, 'workspace.sqlite'));
  old.prepare('UPDATE workspace SET schema_version=3').run();
  old.close();
  records = new WorkspaceRecords(folder, 'app/records/migrations');
  expect(records.snapshot().tasks[0]).toMatchObject({
    id: taskId,
    draft: '保留的中文草稿',
  });
  records.close();
  const backups = readdirSync(folder).filter((name) =>
    name.startsWith('workspace-before-recovery-05-'),
  );
  expect(backups).toHaveLength(1);
  records = new WorkspaceRecords(folder, 'app/records/migrations');
  records.close();
  expect(
    readdirSync(folder).filter((name) =>
      name.startsWith('workspace-before-recovery-05-'),
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
});

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
