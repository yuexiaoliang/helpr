import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setup, cleanup } from './workflow-fixture';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  cleanupPreviewSchema,
  cleanupReceiptSchema,
} from '../../app/shared/cleanup';
import { MaterialFiles } from '../../app/records/material';
import { storageFailure } from '../../app/shared/storage-failure';

function preview(records: WorkspaceRecords, ...taskIds: string[]) {
  return cleanupPreviewSchema.parse(
    records.cleanup({ kind: 'cleanup-preview', taskIds }),
  );
}
function command(records: WorkspaceRecords, ...taskIds: string[]) {
  return {
    kind: 'cleanup-commit',
    requestId: randomUUID(),
    taskIds,
    token: preview(records, ...taskIds).token,
  };
}
async function restored(folder: string) {
  const dest = await mkdtemp(path.join(tmpdir(), 'helpr-cleanup-restore-'));
  cleanup.push(() => rm(dest, { recursive: true, force: true }));
  const records = new WorkspaceRecords(dest, 'app/records/migrations');
  cleanup.push(async () => {
    records.close();
    await Promise.resolve();
  });
  const file = path.join(folder, 'after.helpr-backup');
  const inspected = await records.backup({ kind: 'inspect', file });
  await records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: inspected.archive.checksum,
  });
  return { records, dest };
}

test('清理前影响可核对；先记录再删副本，发布、选择、素材完成事实和流程保持，冷开与新备份恢复不重发', async () => {
  const f = await setup(),
    a = await f.add('清理完成');
  await f.approve(a);
  const r = f.records(),
    before = r.snapshot().tasks[0]!.execution!;
  const material = before.materials![0]!;
  const p = preview(r, a);
  expect(p.tasks[0]!.eligible, p.tasks[0]!.reason).toBe(true);
  expect(p.bytes).toBe(material.bytes);
  expect(
    await readFile(path.join(f.folder, 'materials', material.sha256)),
  ).toEqual(f.page(a).bytes);
  const c = command(r, a);
  expect(cleanupReceiptSchema.strip().parse(r.cleanup(c)).phase).toBe(
    'complete',
  );
  expect(fs.existsSync(path.join(f.folder, 'materials', material.sha256))).toBe(
    false,
  );
  const after = r.snapshot().tasks[0]!.execution!;
  expect(after.materialProcessing).toEqual(before.materialProcessing);
  expect(after.actions).toEqual(before.actions);
  expect(after.publicationChecks).toEqual(before.publicationChecks);
  expect(after.learnedWorkflows).toEqual(before.learnedWorkflows);
  expect(() =>
    r.execution({
      kind: 'intent',
      taskId: a,
      requestId: randomUUID(),
      intent: 'continue',
    }),
  ).toThrow('HISTORY_CLEANED');
  expect(cleanupReceiptSchema.strip().parse(r.cleanup(c)).removedBytes).toBe(0);
  await r.backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'after.helpr-backup'),
  });
  const imported = await restored(f.folder);
  expect(
    imported.records.snapshot().tasks[0]!.execution!.materialProcessing,
  ).toEqual(before.materialProcessing);
  expect(imported.records.snapshot().tasks[0]!.execution!.phase).toBe(
    'complete',
  );
  await f.cold();
  expect(f.e(a).historyCleanup?.requestId).toBe(c.requestId);
  await expect(
    f.service().intent({
      kind: 'execution-intent',
      taskId: a,
      requestId: randomUUID(),
      intent: 'continue',
    }),
  ).rejects.toThrow('HISTORY_CLEANED');
  expect(f.service().canExit()).toBe(true);
  expect(f.page(a).writes.filter((v) => v === 'click')).toHaveLength(2);
  const b = await f.add('新素材仍可复用');
  await f.approve(b);
  expect(f.e(b).phase).toBe('complete');
});

test('待参与、已停止、未知结果及其它任务引用的流程源均保护，预览后新任务使原令牌失效', async () => {
  const f = await setup(),
    a = await f.add('原任务');
  expect(preview(f.records(), a).tasks[0]!.eligible).toBe(false);
  await f.approve(a);
  const c = command(f.records(), a);
  const b = await f.add('新工作');
  expect(() => f.records().cleanup(c)).toThrow('CLEANUP_CHANGED');
  expect(preview(f.records(), a).tasks[0]!.reason).toContain('引用');
  await f.service().intent({
    kind: 'execution-intent',
    taskId: b,
    requestId: randomUUID(),
    intent: 'stop',
  });
  expect(preview(f.records(), b).tasks[0]!.eligible).toBe(false);
  expect(
    fs.existsSync(
      path.join(f.folder, 'materials', f.e(a).materials![0]!.sha256),
    ),
  ).toBe(true);
});

test('备份与恢复在文件等待期间保护清理，旧备份不能覆盖较新的清理决定', async () => {
  const f = await setup(),
    a = await f.add('备份竞争');
  await f.approve(a);
  const r = f.records(),
    c = command(r, a),
    file = path.join(f.folder, 'old.helpr-backup');
  const fixed = path.join(f.folder, 'materials', f.e(a).materials![0]!.sha256);
  const backup = r.backup({ kind: 'create', requestId: randomUUID(), file });
  expect(() => r.cleanup(c)).toThrow('CLEANUP_BUSY');
  const { archive } = await backup;
  r.cleanup(command(r, a));
  expect(fs.existsSync(fixed)).toBe(false);
  const work = r.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: archive.checksum,
  });
  expect(() => preview(r, a)).toThrow('CLEANUP_BUSY');
  await work;
  expect(r.snapshot().tasks[0]!.execution!.historyCleanup).toBeDefined();
  expect(r.snapshot().tasks[0]!.execution!.phase).toBe('complete');
  expect(fs.existsSync(fixed)).toBe(false);
  expect(() =>
    r.execution({
      kind: 'intent',
      taskId: a,
      intent: 'revise',
      requestId: randomUUID(),
      text: '再发',
    }),
  ).toThrow('HISTORY_CLEANED');
});

test('记录提交失败不删除副本；删除失败只留下冗余文件，冷开按原请求重试', async () => {
  const f = await setup(),
    a = await f.add('受控失败');
  await f.approve(a);
  const r = f.records(),
    c = command(r, a),
    sha = f.e(a).materials![0]!.sha256;
  const external = new Database(path.join(f.folder, 'workspace.sqlite'));
  external.exec(
    "CREATE TRIGGER reject_cleanup BEFORE UPDATE ON task_executions BEGIN SELECT RAISE(ABORT, 'controlled failure'); END",
  );
  expect(() => r.cleanup(c)).toThrow();
  expect(fs.existsSync(path.join(f.folder, 'materials', sha))).toBe(true);
  expect(r.snapshot().tasks[0]!.execution!.historyCleanup).toBeUndefined();
  external.exec('DROP TRIGGER reject_cleanup');
  external.close();
  fs.chmodSync(path.join(f.folder, 'materials'), 0o500);
  try {
    expect(cleanupReceiptSchema.strip().parse(r.cleanup(c)).phase).toBe(
      'pending',
    );
  } finally {
    fs.chmodSync(path.join(f.folder, 'materials'), 0o700);
  }
  expect(fs.existsSync(path.join(f.folder, 'materials', sha))).toBe(true);
  expect(r.snapshot().tasks[0]!.execution!.historyCleanup).toBeDefined();
  await f.cold();
  expect(cleanupReceiptSchema.strip().parse(f.records().cleanup(c)).phase).toBe(
    'complete',
  );
  expect(fs.existsSync(path.join(f.folder, 'materials', sha))).toBe(false);
});

test('素材目录被替换为链接时拒绝删除；浏览器登录、原文件与诊断之外资料保持', async () => {
  const f = await setup(),
    a = await f.add('目录保护');
  await f.approve(a);
  const r = f.records(),
    c = command(r, a);
  const outside = path.join(f.folder, 'website-session');
  await mkdir(outside);
  const sentinel = path.join(outside, 'cookie');
  await writeFile(sentinel, 'login-preserved');
  fs.renameSync(
    path.join(f.folder, 'materials'),
    path.join(f.folder, 'kept-materials'),
  );
  await symlink(outside, path.join(f.folder, 'materials'));
  expect(() => r.cleanup(c)).toThrow('CLEANUP_FILE_CHANGED');
  expect(await readFile(sentinel, 'utf8')).toBe('login-preserved');
  expect(await readFile(f.page(a).file)).toEqual(f.page(a).bytes);
});

test('保存失败只返回固定分类，包裹的数据库错误及素材写入故障均不泄漏异常原文', async () => {
  expect(
    storageFailure(
      new Error('SELECT secret', {
        cause: Object.assign(Error('secret path'), { code: 'SQLITE_FULL' }),
      }),
    ),
  ).toBe('STORAGE_FULL');
  for (const code of ['ENOSPC', 'EDQUOT'])
    expect(storageFailure({ code })).toBe('STORAGE_FULL');
  for (const code of ['SQLITE_IOERR_FSYNC', 'SQLITE_READONLY', 'EIO', 'EROFS'])
    expect(storageFailure({ code })).toBe('STORAGE_UNAVAILABLE');
  expect(storageFailure(new Error('some website error'))).toBeNull();
  const f = await setup(),
    a = await f.add('文件读保护');
  await f.approve(a);
  f.records().cleanup(command(f.records(), a));
  const m = f.records().snapshot().tasks[0]!.execution!.materials![0]!;
  await expect(new MaterialFiles(f.folder).read(m)).rejects.toThrow(
    'HISTORY_CLEANED',
  );
});

async function fixedTask(records: WorkspaceRecords, source: string) {
  const taskId = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: `使用“${source}”核对内容`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId,
    url: 'https://example.com/editor',
    phase: 'manual',
  });
  records.execution({
    kind: 'intent',
    taskId,
    requestId: randomUUID(),
    intent: 'start',
  });
  const runId = randomUUID();
  records.execution({ kind: 'claim', taskId, runId });
  await records.material({
    kind: 'select',
    taskId,
    runId,
    selection: {
      scope: source,
      basis: `使用“${source}”`,
      rule: 'exact',
      name: null,
      extension: null,
    },
  });
  return { taskId, runId };
}

test('导入新任务所需的共享副本保留，原任务仍保持清理状态', async () => {
  const current = await setup();
  const id = await current.add('保留新导入的素材引用');
  await current.approve(id);
  const records = current.records();
  const material = current.e(id).materials![0]!;
  records.cleanup(command(records, id));
  const fixed = path.join(current.folder, 'materials', material.sha256);
  expect(fs.existsSync(fixed)).toBe(false);

  const incoming = await setup();
  const { taskId } = await fixedTask(incoming.records(), current.page(id).file);
  const file = path.join(incoming.folder, 'shared.helpr-backup');
  const { archive } = await incoming.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file,
  });
  await records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: archive.checksum,
  });

  const tasks = records.snapshot().tasks;
  expect(
    tasks.find((task) => task.id === id)?.execution?.historyCleanup,
  ).toBeDefined();
  expect(tasks.find((task) => task.id === taskId)?.execution).toMatchObject({
    restoreReview: 'required',
    materials: [{ sha256: material.sha256 }],
  });
  expect(await readFile(fixed)).toEqual(current.page(id).bytes);
});

test('同内容共享副本需所有引用均可清理；未完成引用一直保护，不按文件名删除', async () => {
  const f = await setup(false, false),
    records = f.records();
  const a = await f.add('相同内容');
  await f.approve(a);
  const b = await f.add('相同内容');
  expect(preview(records, a).tasks[0]!.eligible).toBe(false);
  expect(preview(records, a, b).tasks.every((t) => !t.eligible)).toBe(true);
  await f.approve(b);
  expect(preview(records, a).tasks[0]!.eligible).toBe(false);
  expect(preview(records, a, b).files).toHaveLength(1);
  records.cleanup(command(records, a, b));
  expect(await readFile(f.page(a).file)).toEqual(f.page(a).bytes);
  expect(
    records.snapshot().tasks.every((t) => t.execution!.historyCleanup),
  ).toBe(true);
});

test('清理提交与新取材竞争：已有取材Promise保持保护，新引用提交后重新预览', async () => {
  const f = await setup(),
    records = f.records();
  const a = await f.add('取材竞争');
  await f.approve(a);
  const c = command(records, a);
  const selecting = fixedTask(records, f.page(a).file);
  expect(() => records.cleanup(c)).toThrow('CLEANUP_BUSY');
  await selecting;
  expect(() => records.cleanup(c)).toThrow('CLEANUP_CHANGED');
});

test('清理标记损坏不能在冷开成为可派发状态，格式20迁移保留原库', async () => {
  const f = await setup(),
    a = await f.add('格式核对');
  await f.approve(a);
  const external = new Database(path.join(f.folder, 'workspace.sqlite'));
  external.prepare('UPDATE workspace SET schema_version=20').run();
  external.close();
  await f.cold();
  expect(
    fs
      .readdirSync(f.folder)
      .some((name) => name.startsWith('workspace-before-cleanup-22-')),
  ).toBe(true);
  f.records().cleanup(command(f.records(), a));
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  const e = f.records().snapshot().tasks[0]!.execution!;
  e.phase = 'queued';
  db.prepare('UPDATE task_executions SET body=? WHERE task_id=?').run(
    JSON.stringify(e),
    a,
  );
  db.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});
