import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setup } from './workflow-fixture';
import { availableWorkflows } from '../../app/shared/workflow-catalog';
import { WorkspaceRecords } from '../../app/records/workspace';

const changed = { draft: '暂存附件', title: '公告全文', publish: '确认送出' };

test('共享会话变化撤销待保存的修复资格，保留已核对上传但不保存草稿', async () => {
  const f = await setup(true);
  const a = await f.add('基准');
  await f.approve(a);
  let interrupted = false;
  f.intercept(async (raw) => {
    const c = raw as { kind: string; taskId: string };
    if (c.kind === 'workflow-repair' && !interrupted) {
      interrupted = true;
      await f.sessionChanged(c.taskId);
    }
  });
  const b = await f.add('会话变化', '公告', changed);
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).workflowRepairs).toBeUndefined();
  expect(interrupted).toBe(true);
  expect(f.e(b).actions[0]!.status).toBe('confirmed');
  expect(f.e(b).actions[0]!.uploadCheck).toBeDefined();
  expect(f.e(b).learnedWorkflows).toBeUndefined();
});

test('修复回执丢失重读同一记录，冲突请求不改写来源', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.intercept(async (raw) => {
    const c = raw as { kind: string; taskId: string };
    if (c.kind === 'workflow-repair') {
      f.records().execution(raw);
      expect(f.records().execution(raw)).toMatchObject({ created: false });
      expect(() =>
        f.records().execution({ ...c, reason: 'WORKFLOW_CONDITION_CHANGED' }),
      ).toThrow('REQUEST_CONTENT_CONFLICT');
    }
    await Promise.resolve();
  });
  const b = await f.add('回执丢失', '公告', changed);
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.e(b).workflowRepairs).toHaveLength(1);
  expect(f.e(b).learnedWorkflows).toHaveLength(1);
});

test('页面条件变化有限重读后由模型重新观察，原成功规则保持', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    text: o.text.replaceAll('固定标签：公告', '固定标签：已改版'),
  }));
  f.plan((s) => ({
    ...s,
    evidence: s.evidence.map((v) =>
      v.replaceAll('固定标签：公告', '固定标签：已改版'),
    ),
  }));
  const b = await f.add('条件变化');
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.e(b).workflowRepairs![0]!.reason).toBe('WORKFLOW_CONDITION_CHANGED');
  expect(f.e(b).learnedWorkflows![0]!.resultRule).toBe(
    f.e(a).learnedWorkflows![0]!.resultRule,
  );
});

test('控件变化由实际观察触发修复，固定输入与确认，成功后自动采用并冷复用', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const parent = f.e(a).learnedWorkflows![0]!;
  const b = await f.add('变化后的输入', '通知', changed);
  expect(f.e(b).workflowRepairs).toHaveLength(1);
  expect(f.e(b).workflowRepairs![0]!.reason).toBe('WORKFLOW_CONTROL_CHANGED');
  expect(f.e(b).workflowUses![0]!.workflow).toEqual(parent);
  expect(f.e(b).learnedWorkflows).toBeUndefined();
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.e(b).summary).toContain('已适应网页变化');
  expect(f.e(b).workflowDecisions![0]!.status).toBe('adopted');
  const repaired = f.e(b).learnedWorkflows![0]!;
  expect(repaired.parentVersion).toBe(parent.version);
  expect(repaired.steps[1]!.action.target).toMatchObject({
    name: changed.draft,
  });
  expect(f.e(b).publication!.approvalId).not.toBe(
    f.e(a).publication!.approvalId,
  );
  expect(f.page(b).writes).toEqual([
    'upload',
    'click',
    'fill',
    'select',
    'click',
  ]);
  await f.cold();
  const c = await f.add('冷开新输入', '公告', changed);
  await f.approve(c);
  expect(f.e(c).phase, f.e(c).summary).toBe('complete');
  expect(f.e(c).workflowUses![0]!.workflow).toEqual(repaired);
  expect(f.e(c).workflowRepairs).toBeUndefined();
  expect(f.calls.filter((ca) => ca.taskId === c)).toHaveLength(1);
});

test('两个同父修复保留完整成果；后提交者不覆盖已采用版本或在途固定版本', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const [b, c] = await Promise.all([
    f.add('修复甲', '通知', changed),
    f.add('修复乙', '公告', { ...changed, publish: '发送全文' }),
  ]);
  const frozen = structuredClone(f.e(c).workflowUses![0]!.workflow);
  await Promise.all([f.approve(b), f.approve(c)]);
  expect(f.e(b).phase).toBe('complete');
  expect(f.e(c).phase).toBe('complete');
  const decisions = [
    f.e(b).workflowDecisions![0]!,
    f.e(c).workflowDecisions![0]!,
  ];
  expect(decisions.map((d) => d.status).sort()).toEqual([
    'adopted',
    'conflict',
  ]);
  const winner = decisions.find((d) => d.status === 'adopted')!;
  expect(decisions.find((d) => d.status === 'conflict')!.observedHeads).toEqual(
    [winner.version],
  );
  expect(f.e(c).workflowUses![0]!.workflow).toEqual(frozen);
  expect(f.e(b).learnedWorkflows).toHaveLength(1);
  expect(f.e(c).learnedWorkflows).toHaveLength(1);
  expect(availableWorkflows(f.snapshot().tasks).map((w) => w.version)).toEqual([
    winner.version,
  ]);
  await f.cold();
  expect(availableWorkflows(f.snapshot().tasks).map((w) => w.version)).toEqual([
    winner.version,
  ]);
});

test('冲突候选不拼接：后续从当前采用版重新走通组合变化才形成新的候选', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const b = await f.add('分支甲', '公告', { ...changed, publish: '发布附件' });
  const c = await f.add('分支乙', '通知', changed);
  await f.approve(b);
  await f.approve(c);
  const winner = f.e(b).learnedWorkflows![0]!;
  expect(f.e(c).workflowDecisions![0]!.status).toBe('conflict');
  const d = await f.add('组合验证', '公告', changed);
  await f.approve(d);
  expect(f.e(d).phase, f.e(d).summary).toBe('complete');
  expect(f.e(d).workflowUses![0]!.workflow.version).toBe(winner.version);
  expect(f.e(d).workflowRepairs).toHaveLength(1);
  expect(
    f
      .e(d)
      .learnedWorkflows![0]!.steps.every((s) =>
        f.e(d).actions.some((a) => a.id === s.actionId),
      ),
  ).toBe(true);
  expect(f.e(d).workflowDecisions![0]!.status).toBe('adopted');
});

test.each(['destination', 'content', 'effect'] as const)(
  '模型试图改写 %s 时请求参与，不保存变更或新候选',
  async (field) => {
    const f = await setup();
    const a = await f.add('基准');
    await f.approve(a);
    f.plan((step, input) => {
      if (!input.repair) return step;
      if (field === 'effect')
        return step.action ? { ...step, effect: 'publication' } : step;
      return step.decision === 'review'
        ? {
            ...step,
            publication: { ...step.publication!, [field]: '未经授权的栏目' },
          }
        : step;
    });
    const b = await f.add('不能改目标', '公告', changed);
    expect(f.e(b).question?.type).toBeUndefined();
    expect(f.e(b).question?.text).toContain('原目标');
    expect(f.e(b).publication?.destination).not.toBe('未经授权的栏目');
    expect(f.e(b).learnedWorkflows).toBeUndefined();
    expect(f.page(b).published).toBe(false);
  },
);

test('修复同样拒绝未观察到的或重复同名控件，不盲选第一项', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    controls: [
      ...o.controls!,
      ...o.controls!.filter((c) => c.name === changed.draft),
    ],
  }));
  const b = await f.add('重复控件', '公告', changed);
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).phase).toBe('paused');
  expect(f.e(b).learnedWorkflows).toBeUndefined();
});

test('旧候选不能在模型选择后覆盖新头部，绑定再次核对当前采用版', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const old = f.e(a).learnedWorkflows![0]!;
  const b = await f.add('新版本', '公告', changed);
  await f.approve(b);
  f.choose((s) => ({
    ...s,
    workflow: {
      ...s.workflow!,
      taskId: a,
      version: old.version,
      sha256: old.sha256,
    },
  }));
  const c = await f.add('旧模型选择', '公告', changed);
  expect(f.e(c).workflowUses).toBeUndefined();
  expect(f.page(c).writes).toEqual([]);
});

test.each(['stop', 'takeover', 'page-change'] as const)(
  '修复回执前的 %s 使旧资格失效',
  async (mode) => {
    const f = await setup();
    const a = await f.add('基准');
    await f.approve(a);
    let interrupted = false;
    f.intercept(async (raw) => {
      const c = raw as { kind: string; taskId: string };
      if (c.kind !== 'workflow-repair' || interrupted) return;
      interrupted = true;
      if (mode === 'stop')
        await f.service().intent({
          kind: 'execution-intent',
          taskId: c.taskId,
          requestId: randomUUID(),
          intent: 'stop',
        });
      else
        await f
          .service()
          .suspend(
            c.taskId,
            mode === 'takeover' ? 'takeover' : 'page-change',
            randomUUID(),
          );
    });
    const b = await f.add('中断修复', '公告', changed);
    expect(f.page(b).writes).toEqual(['upload']);
    expect(f.e(b).workflowRepairs).toBeUndefined();
    expect(f.e(b).learnedWorkflows).toBeUndefined();
  },
);

test('未知提交先核对，不因修复重发；失败结果不生成候选', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const b = await f.add('未知提交', '公告', changed);
  f.act(async (job) => {
    await Promise.resolve();
    if (
      job.action.kind === 'click' &&
      job.action.target.name === changed.publish
    )
      throw Error('EXECUTION_ACT_TIMEOUT');
  });
  await f.approve(b);
  expect(f.e(b).learnedWorkflows).toBeUndefined();
  await f.service().intent({
    kind: 'execution-intent',
    taskId: b,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await f.service().settled();
  expect(f.e(b).actions.filter((a) => a.effect === 'publication')).toHaveLength(
    1,
  );
  expect(f.page(b).published).toBe(false);
  expect(f.e(b).learnedWorkflows).toBeUndefined();
});

test('结果与采用事务失败全部回滚，冷开只读补记；重复回执不新增候选', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const b = await f.add('原子修复', '公告', changed);
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    `CREATE TRIGGER fail_adoption BEFORE UPDATE ON task_executions WHEN NEW.task_id='${b}' AND instr(NEW.body, 'workflowDecisions')>0 BEGIN SELECT RAISE(ABORT, 'INJECTED_ADOPTION_FAILURE'); END`,
  );
  await f.approve(b);
  expect(f.page(b).published).toBe(true);
  expect(
    f
      .records()
      .snapshot()
      .tasks.find((t) => t.id === b)!.execution!.learnedWorkflows,
  ).toBeUndefined();
  expect(
    f
      .records()
      .snapshot()
      .tasks.find((t) => t.id === b)!.execution!.publicationChecks,
  ).toBeUndefined();
  db.exec('DROP TRIGGER fail_adoption');
  db.close();
  await f.cold();
  await f.service().intent({
    kind: 'execution-intent',
    taskId: b,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await f.service().settled();
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  const check = f.e(b).publicationChecks![0]!;
  f.records().execution({
    kind: 'publication-result',
    taskId: b,
    runId: f.e(b).actions.at(-1)!.runId,
    check,
  });
  expect(
    f
      .records()
      .snapshot()
      .tasks.find((t) => t.id === b)!.execution!.learnedWorkflows,
  ).toHaveLength(1);
  expect(f.page(b).writes.filter((k) => k === 'click')).toHaveLength(2);
});

test('备份保留修复、冲突和采用引用；格式15迁移保留原库，篡改修复引用拒绝冷开', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  const b = await f.add('修复甲', '公告', changed),
    c = await f.add('修复乙', '通知', changed);
  await f.approve(b);
  await f.approve(c);
  const { archive } = await f.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'repair.helpr-backup'),
  });
  await f.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive.file,
    checksum: archive.checksum,
  });
  const restored = f
    .records()
    .snapshot()
    .tasks.find((t) => t.id === c)!.execution!;
  expect(restored.workflowDecisions).toEqual(f.e(c).workflowDecisions);
  expect(restored.workflowRepairs).toEqual(f.e(c).workflowRepairs);
  f.records().close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=15');
  db.close();
  const migrated = new WorkspaceRecords(f.folder, 'app/records/migrations');
  migrated.close();
  expect(
    (await readdir(f.folder)).some((s) =>
      s.startsWith('workspace-before-workflow-repair-17-'),
    ),
  ).toBe(true);
  const bad = structuredClone(restored);
  bad.workflowRepairs![0]!.useId = randomUUID();
  const corrupt = new Database(path.join(f.folder, 'workspace.sqlite'));
  corrupt
    .prepare('UPDATE task_executions SET body=? WHERE task_id=?')
    .run(JSON.stringify(bad), c);
  corrupt.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});
