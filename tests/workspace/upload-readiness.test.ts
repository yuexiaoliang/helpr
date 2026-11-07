import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { setup, cleanup } from './workflow-fixture';
import { executionSchema } from '../../app/shared/execution';
import { uploadedLink } from '../../app/shared/upload-readiness';
import { WorkspaceRecords } from '../../app/records/workspace';

const hide = (o: ReturnType<Awaited<ReturnType<typeof setup>>['observe']>) => ({
  ...o,
  links: o.links?.filter((l) => l.name !== '下载附件'),
});

test('异步回填期间只观察，唯一链接稳定且字节匹配后才保存；检查点、冷开与备份关联保留', async () => {
  const f = await setup(false, false);
  let waiting = 0;
  f.filter((o) => {
    const id = new URL(o.url).searchParams.get('task')!;
    if (f.page(id).uploaded && waiting++ < 4) {
      expect(f.page(id).writes).toEqual(['upload']);
      expect(f.calls.filter((c) => c.taskId === id)).toHaveLength(2);
      return hide(o);
    }
    return o;
  });
  const id = await f.add('延迟附件');
  expect(waiting).toBeGreaterThanOrEqual(6);
  const e = f.e(id),
    a = e.actions[0]!;
  expect(a.status).toBe('confirmed');
  expect(a.uploadCheck).toMatchObject({
    rule: 'unique-new-link-v1',
    download: {
      sha256: e.materials![0]!.sha256,
      bytes: e.materials![0]!.bytes,
    },
  });
  expect(
    e.preparation?.find((p) => p.id === a.uploadCheck!.uploadFactId)!.actionId,
  ).toBe(a.id);
  expect(f.page(id).writes).toEqual(['upload', 'click']);
  await f.cold();
  expect(f.e(id).actions[0]).toEqual(a);
  expect(f.page(id).writes).toEqual(['upload', 'click']);
  const archive = (
    await f.records().backup({
      kind: 'create',
      requestId: randomUUID(),
      file: path.join(f.folder, 'upload.helpr-backup'),
    })
  ).archive;
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-upload-restore-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const restored = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanup.push(async () => {
    restored.close();
    await Promise.resolve();
  });
  await restored.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive.file,
    checksum: archive.checksum,
  });
  const back = restored.snapshot().tasks.find((t) => t.id === id)!.execution!;
  expect(back.actions[0]).toEqual(a);
  expect(back.restoreReview).toBe('required');
  for (const damage of ['digest', 'target', 'upload', 'link', 'generation']) {
    const corrupt = structuredClone(e),
      c = corrupt.actions[0]!;
    if (damage === 'digest') c.uploadCheck!.download.sha256 = '0'.repeat(64);
    if (damage === 'target') c.uploadCheck!.targetFactId = randomUUID();
    if (damage === 'upload') c.uploadCheck!.uploadFactId = randomUUID();
    if (damage === 'link') c.resultLinks!.push(c.resultLinks!.at(-1)!);
    if (damage === 'generation') c.uploadCheck!.binding.generation++;
    expect(executionSchema.safeParse(corrupt).success, damage).toBe(false);
  }
});

test('上传超时保持未知；冷开与伪造备份review不确认', async () => {
  const f = await setup(false, false);
  f.filter(hide);
  const id = await f.add('超时附件');
  expect(f.e(id).phase).toBe('unknown');
  expect(f.page(id).writes).toEqual(['upload']);
  expect(f.calls).toHaveLength(2);
  expect(f.e(id).actions[0]!.uploadCheck).toBeUndefined();
  await f.cold();
  expect(f.calls).toHaveLength(2);
  f.records().execution({ kind: 'backup-pause', taskId: id });
  const e = f
    .records()
    .snapshot()
    .tasks.find((t) => t.id === id)!.execution!;
  f.records().execution({
    kind: 'backup-review-result',
    taskId: id,
    expectedVersion: e.version,
    source: f.observe(id),
    step: {
      decision: 'act',
      summary: '完成',
      evidence: ['编辑附件'],
      action: null,
      previous: {
        id: e.actions[0]!.id,
        status: 'confirmed',
        evidence: ['编辑附件'],
      },
    },
  });
  expect(
    f
      .records()
      .snapshot()
      .tasks.find((t) => t.id === id)!.execution!.actions[0]!.status,
  ).toBe('unknown');
  // 用原资料重新打开，模拟本人明确继续；不是脚本替真人验收。
  await f.cold();
  expect(f.page(id).writes).toEqual(['upload']);
});

test('同页未知上传在明确继续后读已有附件，不重复发送', async () => {
  const f = await setup(false, false);
  let stopped = false;
  f.intercept(async (input) => {
    await Promise.resolve();
    const c = input as { kind: string; taskId: string };
    if (c.kind === 'preparation-observed' && !stopped) {
      stopped = true;
      await f.service().intent({
        kind: 'execution-intent',
        taskId: c.taskId,
        requestId: randomUUID(),
        intent: 'stop',
      });
    }
  });
  const id = await f.add('中断附件');
  expect(f.e(id).intent).toBe('stopped');
  expect(f.page(id).writes).toEqual(['upload']);
  await f.cold();
  expect(f.page(id).writes).toEqual(['upload']);
  f.intercept(async () => {});
  await f.service().intent({
    kind: 'execution-intent',
    taskId: id,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await f.service().settled();
  expect(f.e(id).actions[0]!.uploadCheck).toBeDefined();
  expect(f.page(id).writes).toEqual(['upload', 'click']);
});

test.each([
  'takeover',
  'page-change',
  'session',
  'record-failure',
  'stop-at-resolve',
] as const)('%s使旧等待或迟到保存失效，不提前草稿', async (reason) => {
  const f = await setup(true, false);
  let interrupted = false;
  f.intercept(async (input) => {
    await Promise.resolve();
    const c = input as { kind: string; taskId: string };
    if (
      c.kind !==
        (reason === 'stop-at-resolve' ? 'resolve' : 'preparation-observed') ||
      interrupted
    )
      return;
    interrupted = true;
    if (reason === 'record-failure') throw Error('DISK_WRITE_FAILED');
    if (reason === 'session') await f.sessionChanged(c.taskId);
    else if (reason === 'stop-at-resolve')
      await f.service().intent({
        kind: 'execution-intent',
        taskId: c.taskId,
        requestId: randomUUID(),
        intent: 'stop',
      });
    else await f.service().suspend(c.taskId, reason, randomUUID());
  });
  const id = await f.add('中断-' + reason);
  expect(interrupted).toBe(true);
  expect(f.page(id).writes).toEqual(['upload']);
  expect(f.e(id).actions[0]!.uploadCheck).toBeUndefined();
  expect(f.e(id).actions[0]!.status).toBe('unknown');
});

test('同轮resolve缺字节或实际链接被拒绝，页面和字节变化不继续写入', async () => {
  const f = await setup(false, false);
  let checked = false;
  f.intercept(async (input) => {
    await Promise.resolve();
    const c = input as { kind: string; taskId: string; [key: string]: unknown };
    if (c.kind === 'resolve' && !checked) {
      checked = true;
      const forged = { ...c };
      delete forged.download;
      expect(() => f.records().execution(forged)).toThrow(
        'EXECUTION_RESULT_UNKNOWN',
      );
      f.page(c.taskId).bytes = Buffer.from('different');
    }
  });
  // 改变的是下载后的远端字节，因此后续发布仍要独立再下载核对。
  const id = await f.add('后续改变');
  expect(checked).toBe(true);
  await f.approve(id);
  expect(f.page(id).published).toBe(false);
});

test('实际下载字节不符，仅保存页面关联，未知上传不由模型确认', async () => {
  const f = await setup(false, false);
  f.intercept(async (input) => {
    await Promise.resolve();
    const c = input as { kind: string; taskId: string };
    if (c.kind === 'preparation-observed')
      f.page(c.taskId).bytes = Buffer.from('wrong-file');
  });
  const id = await f.add('错误字节');
  expect(f.e(id).phase).toBe('unknown');
  expect(f.page(id).writes).toEqual(['upload']);
  expect(f.e(id).preparation?.some((p) => p.kind === 'upload')).toBe(true);
  expect(f.e(id).actions[0]!.uploadCheck).toBeUndefined();
  expect(f.calls).toHaveLength(2);
});

test('新增链接规则拒绝歧义、旧地址、跨站、片段、截断和页面变化，不选择第一个', () => {
  const action = {
    source: { url: 'https://example.com/edit' },
    observedUrls: ['https://example.com/old'],
  };
  const link = { name: '任意文件标签', url: 'https://example.com/new' };
  const source = { url: action.source.url, truncated: false, links: [link] };
  expect(
    uploadedLink(action as Parameters<typeof uploadedLink>[0], source),
  ).toEqual(link);
  expect(
    uploadedLink(
      {
        ...action,
        source: { ...action.source, truncated: true },
      } as Parameters<typeof uploadedLink>[0],
      source,
    ),
  ).toBeNull();
  for (const bad of [
    { ...source, links: [link, link] },
    {
      ...source,
      links: [link, { ...link, url: 'https://example.com/another' }],
    },
    { ...source, links: [{ ...link, url: 'https://other.example/new' }] },
    { ...source, links: [{ ...link, url: link.url + '#fragment' }] },
    { ...source, links: [{ ...link, url: 'https://example.com/old' }] },
    { ...source, truncated: true },
    { ...source, url: 'https://example.com/another' },
  ])
    expect(
      uploadedLink(action as Parameters<typeof uploadedLink>[0], bad),
    ).toBeNull();
});

test('27迁移前备份，历史动作不伪造上传检查点', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-upload-migrate-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const initial = new WorkspaceRecords(folder, 'app/records/migrations');
  initial.close();
  const db = new Database(path.join(folder, 'workspace.sqlite'));
  db.prepare('UPDATE workspace SET schema_version=27').run();
  db.close();
  const upgraded = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanup.push(async () => {
    upgraded.close();
    await Promise.resolve();
  });
  expect(
    (await readdir(folder)).some((n) =>
      n.startsWith('workspace-before-upload-ready-23-'),
    ),
  ).toBe(true);
  expect(upgraded.snapshot().tasks).toEqual([]);
});

test('就绪后附件链接消失，旧检查点不能放行新的保存', async () => {
  const f = await setup(false, false);
  let checked = false;
  f.intercept(async (input) => {
    await Promise.resolve();
    const c = input as { kind: string; effect?: string; source?: unknown };
    if (c.kind === 'reserve' && c.effect === 'draft') {
      checked = true;
      const source = c.source as ReturnType<typeof f.observe>;
      expect(() =>
        f.records().execution({ ...c, source: hide(source) }),
      ).toThrow('EXECUTION_RESULT_UNKNOWN');
    }
  });
  const id = await f.add('关联消失');
  expect(checked).toBe(true);
  expect(f.page(id).writes).toEqual(['upload', 'click']);
});
