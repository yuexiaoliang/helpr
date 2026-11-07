import Database from 'better-sqlite3';
import { readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setup } from './workflow-fixture';
import { resolveWorkflowFields } from '../../app/shared/workflow-rich-text';
import { workflowChoiceSchema } from '../../app/shared/workflow';
import {
  validPublicationReferences,
  workflowHash,
} from '../../app/records/workflow';

async function fixture(frame: string) {
  const f = await setup(false, true, true);
  const nodes = new Map<string, number>();
  f.filter((o) => ({
    ...o,
    controls: o.controls!.map((c) => {
      if (c.name !== '文章正文') return c;
      if (!nodes.has(o.url)) nodes.set(o.url, nodes.size + 50);
      const id = nodes.get(o.url)!;
      const frameUrl = frame === 'main' ? o.url : frame;
      return {
        ...c,
        role: 'generic',
        name: '',
        readOnly: false,
        frameUrl,
        richText: {
          rule: 'contenteditable-ax-v1',
          backendNodeId: id,
          valueSource: 'ax',
          locator: {
            richTextNodeId: id,
            frameUrl,
            path: 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)',
          },
        },
      };
    }),
  }));
  f.plan((step, input) => {
    const c = input.observation.controls!.find((c) => c.richText)!;
    if (step.workflow?.fields) step.workflow.fields[1]!.frameUrl = c.frameUrl;
    if (step.publication?.fields) {
      step.publication.fields[1] = {
        ...step.publication.fields[1]!,
        frameUrl: c.frameUrl,
        richText: step.publication.fields[1]!.richText ?? c.richText!.locator,
      };
    }
    if (
      step.action?.kind === 'fill' &&
      'name' in step.action.target &&
      step.action.target.name === '文章正文'
    )
      step.action.target = c.richText!.locator!;
    return step;
  });
  return { ...f, nodes };
}

test.each(['main', 'about:blank', 'about:srcdoc'])(
  '%s 从实际动作归纳规则，换素材及冷开新任务只用当前节点并逐次确认',
  async (frame) => {
    const f = await fixture(frame);
    const a = await f.add('首次富文本');
    await f.approve(a);
    expect(f.e(a).phase, f.e(a).summary).toBe('complete');
    const w = f.e(a).learnedWorkflows![0]!;
    expect(w.replay?.richTextFields).toMatchObject([
      {
        fieldId: 'text',
        role: 'generic',
        name: '',
        frame: frame === 'main' ? 'main' : 'exact',
      },
    ]);
    expect(JSON.stringify(w.replay)).not.toContain('richTextNodeId');
    const first = f.e(a).publication!.fields![1]!.richText!;
    for (const title of ['第二份富文本', '冷开第三份富文本']) {
      if (title.startsWith('冷开')) await f.cold();
      const b = await f.add(title);
      expect(f.e(b).question?.type, f.e(b).summary).toBe('review');
      expect(
        f.e(b).workflowUses?.[0]?.workflow.replay?.richTextFields,
      ).toBeDefined();
      const current = f.e(b).publication!.fields![1]!.richText!;
      expect(current.richTextNodeId).not.toBe(first.richTextNodeId);
      expect(f.page(b).writes).toEqual(['upload', 'click']);
      await f.approve(b);
      expect(f.e(b).phase, f.e(b).summary).toBe('complete');
      expect(f.page(b).body).toBe('这份正文属于' + title);
      expect(f.calls.filter((c) => c.taskId === b)).toEqual([
        { taskId: b, kind: 'intent-and-inputs' },
      ]);
      expect(validPublicationReferences(b, f.e(b))).toBe(true);
    }
    const file = f.folder + '/rebind.helpr-backup';
    expect(
      (
        await f
          .records()
          .backup({ kind: 'create', requestId: randomUUID(), file })
      ).archive,
    ).toBeTruthy();
    await f.cold();
    expect(f.e(a).phase).toBe('complete');
  },
);

test('预览后换节点不重新绑定，确认后不填写或发布', async () => {
  const f = await fixture('about:blank');
  const a = await f.add('学习');
  await f.approve(a);
  const b = await f.add('本次');
  const before = f.e(b).publication!.fields![1]!.richText!;
  f.nodes.set(f.url(b), before.richTextNodeId + 100);
  await f.approve(b);
  expect(f.page(b).writes).toEqual(['upload', 'click']);
  expect(f.e(b).phase).toBe('paused');
  expect(f.e(b).publication!.fields![1]!.richText).toEqual(before);
});

test('缺证明、歧义、路径、角色、名称、frame或截断观察均不能选择；模型不接受旧节点', async () => {
  const f = await fixture('about:srcdoc');
  const a = await f.add('学习反例');
  await f.approve(a);
  const b = await f.add('新输入');
  const use = f.e(b).workflowUses![0]!;
  expect(
    workflowChoiceSchema.safeParse({
      taskId: a,
      version: use.workflow.version,
      sha256: use.workflow.sha256,
      content: use.content,
      destination: use.destination,
      fields: f.e(b).publication!.fields,
    }).success,
  ).toBe(false);
  for (const mode of [
    'missing',
    'duplicate',
    'path',
    'role',
    'name',
    'frame',
    'truncated',
    'disabled',
    'value',
    'readonly',
  ]) {
    const o = structuredClone(f.observe(b)),
      c = o.controls!.find((c) => c.richText)!;
    if (mode === 'missing') delete c.richText;
    if (mode === 'duplicate') o.controls!.push(structuredClone(c));
    if (mode === 'path') c.richText!.locator!.path += ' > p:nth-child(1)';
    if (mode === 'role') c.role = 'textbox';
    if (mode === 'name') c.name = '假名称';
    if (mode === 'frame') c.frameUrl = 'about:blank';
    if (mode === 'truncated') o.truncated = true;
    if (mode === 'disabled') c.disabled = true;
    if (mode === 'value') delete c.textValue;
    if (mode === 'readonly') c.readOnly = true;
    expect(() => resolveWorkflowFields(use, o), mode).toThrow(
      'WORKFLOW_CONTROL_CHANGED',
    );
  }
  const bad = structuredClone(f.e(a));
  bad.learnedWorkflows![0]!.replay!.richTextFields![0]!.name = '伪造名称';
  bad.learnedWorkflows![0]!.sha256 = workflowHash(bad.learnedWorkflows![0]!);
  expect(validPublicationReferences(a, bad)).toBe(false);
});

test('复用改稿只改完整新值，拒绝定位交换；备份恢复保留本次证明且要求核对', async () => {
  const f = await fixture('about:srcdoc');
  const a = await f.add('改稿来源');
  await f.approve(a);
  const b = await f.add('改稿新任务');
  const before = f.e(b).publication!;
  const fields = before.fields!.map((field) => ({
    ...field,
    value: field.id === 'text' ? '本人修改第一行\n本人修改第二行' : field.value,
  }));
  const command = {
    kind: 'participation-decision' as const,
    taskId: b,
    questionId: f.e(b).question!.id,
    operation: 'edit' as const,
    content: fields.map((f) => f.value).join('\n\n'),
    fields,
  };
  await expect(
    f.service().reply({
      ...command,
      fields: fields.map((f) =>
        f.richText
          ? { ...f, richText: { ...f.richText, richTextNodeId: 999 } }
          : f,
      ),
    }),
  ).rejects.toThrow('PARTICIPATION_EXPIRED');
  await f.service().reply(command);
  await f.service().settled();
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.page(b).body).toBe(fields[1]!.value);
  const file = f.folder + '/restored.helpr-backup';
  const saved = await f
    .records()
    .backup({ kind: 'create', requestId: randomUUID(), file });
  const g = await fixture('main');
  await g.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  const restored = g
    .records()
    .snapshot()
    .tasks.find((t) => t.id === b)!.execution!;
  expect(restored.restoreReview).toBe('required');
  expect(restored.workflowUses).toEqual(f.e(b).workflowUses);
  expect(restored.publication!.richTextReview).toEqual(
    f.e(b).publication!.richTextReview,
  );
});

test('34迁移先备份，旧unusable历史不能补造新规则或采用', async () => {
  const f = await fixture('main');
  const a = await f.add('历史候选');
  await f.approve(a);
  const legacy = structuredClone(f.e(a));
  const w = legacy.learnedWorkflows![0]!;
  delete w.replay;
  w.sha256 = workflowHash(w);
  delete legacy.workflowAdoption;
  legacy.workflowDecisions![0]!.status = 'unusable';
  const db = new Database(f.folder + '/workspace.sqlite');
  db.prepare('UPDATE task_executions SET body=? WHERE task_id=?').run(
    JSON.stringify(legacy),
    a,
  );
  db.exec('UPDATE workspace SET schema_version=34');
  db.close();
  await f.cold();
  expect(
    (await readdir(f.folder)).some((n) =>
      n.startsWith('workspace-before-rich-text-rebind-23-'),
    ),
  ).toBe(true);
  expect(f.e(a).learnedWorkflows![0]!.replay).toBeUndefined();
  expect(f.e(a).workflowDecisions![0]!.status).toBe('unusable');
  expect(f.e(a).phase).toBe('complete');
});
