import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';

const folders: string[] = [];
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true })),
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
