import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { pageObservation } from '../../app/desktop/page-observation';
import { setup, cleanup } from './workflow-fixture';

test('通过公共执行入口学习、换素材标题栏目并固定版本；网页重放不调用规划模型', async () => {
  const f = await setup();
  const a = await f.add('第一份');
  await f.approve(a);
  expect(f.e(a).phase, f.e(a).summary).toBe('complete');
  const workflow = f.e(a).learnedWorkflows![0]!;
  expect(workflow.replay).toBeDefined();
  const b = await f.add('第二份', '通知');
  expect(f.page(b).published).toBe(false);
  expect(f.e(b).publication!.approvalId).toBeNull();
  expect(f.e(b).workflowUses![0]!.workflow).toEqual(workflow);
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.calls.filter((c) => c.taskId === b)).toEqual([
    { taskId: b, kind: 'intent-and-inputs' },
  ]);
  expect(f.e(b).publication!.approvalId).not.toBe(
    f.e(a).publication!.approvalId,
  );
  expect(f.e(b).materials![0]!.sha256).not.toBe(f.e(a).materials![0]!.sha256);
  expect(f.e(b).learnedWorkflows![0]!.parentVersion).toBe(workflow.version);
  expect(f.page(b).title).toBe('第二份');
  expect(f.page(b).destination).toBe('通知');
  expect(f.page(b).writes).toEqual([
    'upload',
    'click',
    'fill',
    'select',
    'click',
  ]);
  expect(f.e(b).materialProcessing!.map((p) => p.status)).toEqual(['complete']);
  expect(f.e(a).phase).toBe('complete');
});

test('冷开从数据库读取版本，以新输入重放；备份保留每项绑定并暂停恢复', async () => {
  const f = await setup();
  const a = await f.add('旧资料');
  await f.approve(a);
  const original = f.e(a).learnedWorkflows![0];
  await f.cold();
  const b = await f.add('冷开新资料', '通知');
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.e(b).workflowUses![0]!.workflow).toEqual(original);
  const { archive } = await f.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'backup.helpr-backup'),
  });
  expect(archive).toBeTruthy();
  const restoredFolder = await mkdtemp(
    path.join(tmpdir(), 'helpr-workflow-restore-'),
  );
  cleanup.push(() => rm(restoredFolder, { recursive: true, force: true }));
  const restored = new WorkspaceRecords(
    restoredFolder,
    'app/records/migrations',
  );
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
  const restoredExecution = restored
    .snapshot()
    .tasks.find((t) => t.id === b)!.execution!;
  expect(restoredExecution.workflowUses).toEqual(f.e(b).workflowUses);
  expect(restoredExecution.restoreReview).toBe('required');
  expect(restoredExecution.phase).toBe('paused');
  await f.cold();
  expect(f.e(b).phase).toBe('complete');
  expect(f.calls.filter((c) => c.taskId === b)).toHaveLength(1);
});

test('重复链接导致未知并不重传，不使用历史地址或任意第一项', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    links: [...(o.links ?? []), { name: '下载附件', url: f.base + '/other' }],
    text:
      o.text +
      '\n[observed-link] ' +
      JSON.stringify({ name: '下载附件', url: f.base + '/other' }),
  }));
  const b = await f.add('有歧义');
  expect(f.e(b).phase).toBe('paused');
  expect(f.page(b).writes).toEqual(['upload']);
  await f.service().intent({
    kind: 'execution-intent',
    taskId: b,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await f.service().settled();
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).materialProcessing ?? []).toHaveLength(0);
});

test('本次参数必须来自本次委托，候选摘要不符不能绑定', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.choose((s) => ({
    ...s,
    workflow: { ...s.workflow!, content: '旧值冒充新值' },
  }));
  const b = await f.add('新委托');
  expect(f.page(b).writes).toHaveLength(0);
  expect(f.e(b).phase).toBe('paused');
  f.choose((s) => ({
    ...s,
    workflow: { ...s.workflow!, sha256: '0'.repeat(64) },
  }));
  const c = await f.add('错误摘要');
  expect(f.page(c).writes).toHaveLength(0);
  expect(f.e(c).workflowUses).toBeUndefined();
});

test('近派发停止阻断重放，另一任务保持自己的素材和确认', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  let stopped = false;
  f.intercept(async (raw) => {
    const c = raw as { kind: string; taskId: string; workflowStep?: unknown };
    if (c.kind === 'reserve' && c.workflowStep && !stopped) {
      stopped = true;
      await f.service().intent({
        kind: 'execution-intent',
        taskId: c.taskId,
        requestId: randomUUID(),
        intent: 'stop',
      });
    }
  });
  const b = await f.add('停止的任务');
  expect(f.e(b).phase).toBe('stopped');
  expect(f.page(b).writes).toHaveLength(0);
  const c = await f.add('独立的任务', '通知');
  await f.approve(c);
  expect(f.e(c).phase).toBe('complete');
  expect(f.e(b).phase).toBe('stopped');
});

test('绑定版本损坏冷开拒绝；格式13迁移先保留原库', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const b = await f.add('绑定');
  f.records().close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=13');
  db.close();
  const migrated = new WorkspaceRecords(f.folder, 'app/records/migrations');
  expect(
    (await readdir(f.folder)).some((s) =>
      s.startsWith('workspace-before-workflow-reuse-15-'),
    ),
  ).toBe(true);
  migrated.close();
  const corrupt = new Database(path.join(f.folder, 'workspace.sqlite'));
  const body = structuredClone(f.e(b));
  body.workflowUses![0]!.workflow.sha256 = '0'.repeat(64);
  corrupt
    .prepare('UPDATE task_executions SET body=? WHERE task_id=?')
    .run(JSON.stringify(body), b);
  corrupt.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});

test('可访问链接观察保留重复名称以拒绝歧义，不凭旧URL生成链接', () => {
  const obs = pageObservation(
    { frameTree: { frame: { url: 'https://example.test/edit' } } },
    {
      nodes: [1, 2].map((n) => ({
        nodeId: String(n),
        role: { value: 'link' },
        name: { value: '下载' },
        properties: [
          { name: 'url', value: { value: `https://example.test/${n}` } },
        ],
      })),
    },
    1,
  );
  expect(obs.text.match(/\[observed-link\]/g)).toHaveLength(2);
  expect(obs.links).toHaveLength(2);
});

test('网页伪造链接标记不能替代实际可访问链接', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    links: o.links?.filter((l) => l.name !== '下载附件'),
  }));
  const b = await f.add('仅文字链接');
  expect(f.e(b).phase).toBe('paused');
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).preparation?.some((p) => p.kind === 'upload')).toBe(false);
});

test('复用预览改稿采用本次确认，冷开保留实际绑定，重复结果不新增流程或处理记录', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const b = await f.add('待改稿');
  await f.service().reply({
    kind: 'participation-decision',
    taskId: b,
    questionId: f.e(b).question!.id,
    operation: 'edit',
    content: '本人修改后的全文',
  });
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.page(b).title).toBe('本人修改后的全文');
  const result = f.e(b).publicationChecks![0]!,
    version = f.e(b).learnedWorkflows![0]!.version;
  f.records().execution({
    kind: 'publication-result',
    taskId: b,
    runId: f.e(b).actions.at(-1)!.runId,
    check: result,
  });
  await f.cold();
  expect(f.e(b).learnedWorkflows!.map((w) => w.version)).toEqual([version]);
  expect(f.e(b).materialProcessing).toHaveLength(1);
  expect(f.e(b).workflowUses![0]!.approved!.content).toBe('本人修改后的全文');
});

test('两项新任务共享候选但各自固定素材、参数和有效确认', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const [b, c] = await Promise.all([f.add('并行甲'), f.add('并行乙', '通知')]);
  expect(f.e(b).workflowUses![0]!.workflow.version).toBe(
    f.e(c).workflowUses![0]!.workflow.version,
  );
  expect(f.e(b).workflowUses![0]!.id).not.toBe(f.e(c).workflowUses![0]!.id);
  await f.approve(b);
  expect(f.e(c).publication!.approvalId).toBeNull();
  expect(f.page(c).published).toBe(false);
  await f.approve(c);
  expect(f.e(b).phase).toBe('complete');
  expect(f.e(c).phase).toBe('complete');
  expect(f.page(b).title).toBe('并行甲');
  expect(f.page(c).title).toBe('并行乙');
});

test('保存绑定失败保持阻断；模型同时报告异常时不开始复用', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.choose((s) => ({ ...s, anomalies: ['观察到多余目标'] }));
  const b = await f.add('异常');
  expect(f.e(b).phase).toBe('unknown');
  expect(f.e(b).workflowUses).toBeUndefined();
  expect(f.page(b).writes).toHaveLength(0);
  f.choose((s) => s);
  f.intercept((raw) =>
    (raw as { kind: string }).kind === 'workflow-bind'
      ? Promise.reject(Error('record-down'))
      : Promise.resolve(),
  );
  const c = await f.add('记录失败');
  expect(f.e(c).workflowUses).toBeUndefined();
  expect(f.page(c).writes).toHaveLength(0);
});

test('重放预留回执重送只保存一个动作，不重复执行', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.intercept(async (raw) => {
    const c = raw as { kind: string; workflowStep?: unknown };
    if (c.kind === 'reserve' && c.workflowStep) f.records().execution(raw);
    await Promise.resolve();
  });
  const b = await f.add('丢失回执');
  expect(f.page(b).writes).toHaveLength(0);
  expect(f.e(b).actions).toHaveLength(1);
  expect(f.e(b).actions[0]!.dispatchState).toBe('not-dispatched');
});
