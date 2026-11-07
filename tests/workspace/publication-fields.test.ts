import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { setup } from './workflow-fixture';
import { pageObservation } from '../../app/desktop/page-observation';
import {
  publicationSchema,
  verifyPublicationFields,
} from '../../app/shared/publication';

test('独立字段首次学习、换输入与冷开复用，每个字段各写本次完整值，下载与公开结果核对', async () => {
  const f = await setup(false, true, true);
  const a = await f.add('第一份字段标题');
  expect(f.e(a).publication?.fields?.map((p) => p.name)).toEqual([
    '发布标题',
    '文章正文',
  ]);
  await f.approve(a);
  expect(f.e(a).phase, f.e(a).summary).toBe('complete');
  const workflow = f.e(a).learnedWorkflows![0]!;
  expect(workflow.replay).toBeDefined();
  expect(
    workflow.steps
      .filter((s) => s.action.kind === 'fill')
      .map((s) => s.bindings[0]?.fieldId),
  ).toEqual(['heading', 'text']);
  for (const title of ['第二份字段标题', '冷开第三份标题']) {
    if (title.startsWith('冷开')) await f.cold();
    const id = await f.add(title, '通知');
    expect(f.e(id).publication?.approvalId).toBeNull();
    await f.approve(id);
    expect(f.e(id).phase, f.e(id).summary).toBe('complete');
    expect(f.page(id).title).toBe(title);
    expect(f.page(id).body).toBe('这份正文属于' + title);
    expect(
      f
        .e(id)
        .actions.at(-1)
        ?.fieldResults?.map((r) => r.textValue),
    ).toEqual([title, '这份正文属于' + title]);
    expect(f.calls.filter((c) => c.taskId === id)).toEqual([
      { taskId: id, kind: 'intent-and-inputs' },
    ]);
  }
  const backup = await f.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'fields.helpr-backup'),
  });
  expect(backup.archive).toBeTruthy();
  const before = f.e(a).publication;
  await f.cold();
  expect(f.e(a).publication).toEqual(before);
});

test('批准字段不能交换定位或用全文代替单字段；网页提示保留但实际值被交换时拒绝发布', async () => {
  const f = await setup(false, true, true);
  const a = await f.add('不可交换的标题');
  f.plan((step) =>
    step.action?.kind === 'fill'
      ? {
          ...step,
          action: {
            ...step.action,
            target: { ...step.action.target, name: '文章正文' },
          },
        }
      : step,
  );
  await f.approve(a);
  expect(f.page(a).published).toBe(false);
  expect(f.page(a).writes).not.toContain('fill');
  const other = await setup(false, true, true);
  const b = await other.add('实际值交换');
  other.filter((observation) => ({
    ...observation,
    controls: observation.controls?.map((c) =>
      c.role === 'textbox' && c.textValue
        ? {
            ...c,
            textValue:
              c.name === '文章正文' ? '实际值交换' : '这份正文属于实际值交换',
          }
        : c,
    ),
  }));
  await other.approve(b);
  expect(other.page(b).published).toBe(false);
  expect(
    other.e(b).materialProcessing?.some((m) => m.status === 'complete'),
  ).not.toBe(true);
});

test('字段改稿形成新确认，旧回复失效；禁止顺带改字段映射，旧格式21迁移保留且不补造字段', async () => {
  const f = await setup(false, true, true);
  const a = await f.add('待改稿标题');
  const old = f.e(a).question!.id;
  const fields = f.e(a).publication!.fields!.map((field) => ({
    ...field,
    value: field.id === 'text' ? '用户重新确认的正文' : field.value,
  }));
  await expect(
    f.service().reply({
      kind: 'participation-decision',
      taskId: a,
      questionId: old,
      operation: 'edit',
      content: fields.map((p) => p.value).join('\n\n'),
      fields: fields.map((p) => ({ ...p, name: '其它字段' })),
    }),
  ).rejects.toThrow();
  await f.service().reply({
    kind: 'participation-decision',
    taskId: a,
    questionId: old,
    operation: 'edit',
    content: fields.map((p) => p.value).join('\n\n'),
    fields,
  });
  expect(f.e(a).publication?.approvalId).toBeNull();
  await expect(
    f.service().reply({
      kind: 'participation-decision',
      taskId: a,
      questionId: old,
      operation: 'approve',
    }),
  ).rejects.toThrow();
  await f.approve(a);
  expect(f.e(a).phase, f.e(a).summary).toBe('complete');
  expect(f.page(a).body).toBe('用户重新确认的正文');
  const legacy = await setup();
  const id = await legacy.add('格式21资料');
  await legacy.approve(id);
  await legacy.service().stopAll();
  legacy.records().close();
  const db = new Database(path.join(legacy.folder, 'workspace.sqlite'));
  db.prepare('UPDATE workspace SET schema_version=21').run();
  db.close();
  await legacy.cold();
  expect(legacy.e(id).publication?.fields).toBeUndefined();
  expect(
    (await readdir(legacy.folder)).some((f) =>
      f.startsWith('workspace-before-publication-fields-23-'),
    ),
  ).toBe(true);
});

test('观察只保留未受保护文本框的完整值，缺值／歧义／截断不能证明字段已填', () => {
  const source = pageObservation(
    { frameTree: { frame: { url: 'https://example.test/edit' } } },
    {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'textbox' },
          name: { value: '标题' },
          value: { value: '测试标题' },
        },
        {
          nodeId: '2',
          role: { value: 'textbox' },
          name: { value: '密钥' },
          value: { value: 'do-not-copy' },
          properties: [{ name: 'protected', value: { value: true } }],
        },
      ],
    },
    1,
  );
  expect(source.controls).toHaveLength(1);
  expect(JSON.stringify(source)).not.toContain('do-not-copy');
  const p = publicationSchema.parse({
    content: '测试标题',
    destination: '公告',
    fields: [{ id: 'heading', name: '标题', value: '测试标题' }],
  });
  expect(verifyPublicationFields(p, source)).toHaveLength(1);
  expect(() =>
    verifyPublicationFields(p, { ...source, truncated: true }),
  ).toThrow();
  expect(() =>
    verifyPublicationFields(p, {
      ...source,
      controls: [...source.controls!, ...source.controls!],
    }),
  ).toThrow();
  expect(() =>
    publicationSchema.parse({ ...p, content: '另一正文' }),
  ).toThrow();
});

test('旧备份恢复不替换较新字段改稿和停止事实，损坏字段证明冷开拒绝', async () => {
  const f = await setup(false, true, true);
  const id = await f.add('字段备份');
  const { archive } = await f.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'old.helpr-backup'),
  });
  const fields = f.e(id).publication!.fields!.map((p) => ({
    ...p,
    value: p.id === 'text' ? '较新正文' : p.value,
  }));
  await f.service().reply({
    kind: 'participation-decision',
    taskId: id,
    questionId: f.e(id).question!.id,
    operation: 'edit',
    content: fields.map((p) => p.value).join('\n\n'),
    fields,
  });
  await f.service().intent({
    kind: 'execution-intent',
    taskId: id,
    requestId: randomUUID(),
    intent: 'stop',
  });
  await f.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive.file,
    checksum: archive.checksum,
  });
  await f.cold();
  expect(f.e(id).intent).toBe('stopped');
  expect(f.e(id).publication?.fields).toEqual(fields);
  const corrupt = await setup(false, true, true);
  const other = await corrupt.add('损坏证明');
  await corrupt.approve(other);
  expect(corrupt.e(other).phase).toBe('complete');
  await corrupt.service().stopAll();
  corrupt.records().close();
  const db = new Database(path.join(corrupt.folder, 'workspace.sqlite'));
  const row = db
    .prepare('SELECT body FROM task_executions WHERE task_id=?')
    .get(other) as { body: string };
  const value = JSON.parse(row.body) as {
    actions: { fieldResults?: { textValue: string }[] }[];
  };
  value.actions.at(-1)!.fieldResults![0]!.textValue = '不是已确认标题';
  db.prepare('UPDATE task_executions SET body=? WHERE task_id=?').run(
    JSON.stringify(value),
    other,
  );
  db.close();
  expect(
    () => new WorkspaceRecords(corrupt.folder, 'app/records/migrations'),
  ).toThrow();
});
