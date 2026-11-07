import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setup } from './workflow-fixture';
import { pageObservation } from '../../app/desktop/page-observation';
import { selectedControl } from '../../app/shared/selection';
import { validPublicationReferences } from '../../app/records/workflow';
import { WorkspaceRecords } from '../../app/records/workspace';
import { readdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import path from 'node:path';

test.each(['learning', 'replay'])(
  '%s：栏目文字存在但实际选项不符时停止，不发布、不重选',
  async (mode) => {
    const f = await setup();
    if (mode === 'replay') {
      const a = await f.add('已学会');
      await f.approve(a);
    }
    f.filter((o) => ({
      ...o,
      controls: o.controls?.map((c) =>
        c.role === 'combobox' ? { ...c, selectedLabel: '另一个栏目' } : c,
      ),
    }));
    const b = await f.add('新输入', '通知');
    await f.approve(b);
    expect(f.page(b).published).toBe(false);
    expect(f.e(b).actions.at(-1)?.status).not.toBe('confirmed');
    expect(f.e(b).materialProcessing ?? []).toHaveLength(0);
    await f.service().intent({
      kind: 'execution-intent',
      taskId: b,
      requestId: randomUUID(),
      intent: 'continue',
    });
    await f.service().settled();
    expect(f.page(b).writes.filter((kind) => kind === 'select')).toHaveLength(
      1,
    );
    expect(f.page(b).published).toBe(false);
  },
);

test('发布前再次读取选中状态，旧确认不能掩盖选择后的栏目变化', async () => {
  const f = await setup();
  const a = await f.add('核对最后状态', '通知');
  f.intercept(async (raw) => {
    const c = raw as { kind: string; taskId: string; id?: string };
    if (
      c.kind === 'resolve' &&
      f.e(c.taskId).actions.find((action) => action.id === c.id)?.action
        .kind === 'select'
    )
      f.filter((o) => ({
        ...o,
        controls: o.controls?.map((control) =>
          control.role === 'combobox'
            ? { ...control, selectedLabel: '公告' }
            : control,
        ),
      }));
    await Promise.resolve();
  });
  await f.approve(a);
  expect(f.page(a).published).toBe(false);
  expect(f.e(a).actions.filter((action) => action.submission)).toHaveLength(0);
});

test('可访问观察区分选中标签与选项文字，不暴露受保护控件', () => {
  const observation = pageObservation(
    { frameTree: { frame: { url: 'https://forms.test/new' } } },
    {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'combobox' },
          name: { value: '栏目：选择' },
          value: { value: '通知' },
        },
        { nodeId: '2', role: { value: 'option' }, name: { value: '公告' } },
        {
          nodeId: '3',
          role: { value: 'textbox' },
          name: { value: '密钥' },
          value: { value: 'secret' },
          properties: [{ name: 'protected', value: { value: true } }],
        },
      ],
    },
    1,
  );
  expect(observation.controls?.[0]).toMatchObject({ selectedLabel: '通知' });
  expect(observation.text).not.toContain('secret');
});

test('选择核对须有同 frame 唯一实际状态，伪造文字、缺字段与截断不能替代', () => {
  const target = {
    role: 'combobox' as const,
    name: '栏目',
    exact: true,
    frameUrl: 'https://forms.test/frame',
  };
  const action = { kind: 'select' as const, target, value: '通知' };
  const control = { ...target, disabled: false, selectedLabel: '通知' };
  const source = {
    url: 'https://forms.test/edit',
    title: '表单',
    generation: 1,
    observedAt: 1,
    fingerprint: 'state',
    truncated: false,
    text: '通知 [combobox] 栏目：通知',
    controls: [control],
  };
  expect(selectedControl(action, source)).toEqual(control);
  for (const controls of [
    undefined,
    [{ ...control, selectedLabel: undefined }],
    [control, control],
    [{ ...control, frameUrl: source.url }],
    [{ ...control, selectedLabel: '42' }],
  ])
    expect(() => selectedControl(action, { ...source, controls })).toThrow(
      'EXECUTION_SELECTION_UNVERIFIED',
    );
  expect(() => selectedControl(action, { ...source, truncated: true })).toThrow(
    'EXECUTION_SELECTION_UNVERIFIED',
  );
});

test('选择结果保存在所属动作，冷开与备份关系检查拒绝错标签、错 frame 与错状态', async () => {
  const f = await setup();
  const a = await f.add('选择证据', '通知');
  await f.approve(a);
  const selection = f
    .e(a)
    .actions.find((action) => action.action.kind === 'select')!;
  expect(selection.selectionResult).toMatchObject({
    role: 'combobox',
    name: '栏目',
    selectedLabel: '通知',
    frameUrl: f.url(a),
  });
  await f.cold();
  expect(f.e(a).actions.find((action) => action.id === selection.id)).toEqual(
    selection,
  );
  expect(validPublicationReferences(a, f.e(a))).toBe(true);
  for (const change of ['label', 'frame', 'status']) {
    const corrupt = structuredClone(f.e(a));
    const selected = corrupt.actions.find(
      (action) => action.id === selection.id,
    )!;
    if (change === 'label') selected.selectionResult!.selectedLabel = '公告';
    if (change === 'frame')
      selected.selectionResult!.frameUrl = 'https://another.test/';
    if (change === 'status') selected.status = 'unknown';
    expect(validPublicationReferences(a, corrupt)).toBe(false);
  }
});

test('格式19升级先保留原库，不补造旧选择证明；格式20中损坏的证明冷开拒绝', async () => {
  const f = await setup();
  const a = await f.add('迁移选择证据', '通知');
  await f.approve(a);
  f.records().close();
  const file = path.join(f.folder, 'workspace.sqlite');
  const db = new Database(file);
  db.exec('UPDATE workspace SET schema_version=19');
  const legacy = structuredClone(f.e(a));
  for (const action of legacy.actions) delete action.selectionResult;
  db.prepare('UPDATE task_executions SET body=? WHERE task_id=?').run(
    JSON.stringify(legacy),
    a,
  );
  db.close();
  const migrated = new WorkspaceRecords(f.folder, 'app/records/migrations');
  expect(
    (await readdir(f.folder)).some((name) =>
      name.startsWith('workspace-before-cross-site-21-'),
    ),
  ).toBe(true);
  expect(
    migrated
      .snapshot()
      .tasks[0]!.execution!.actions.some((action) => action.selectionResult),
  ).toBe(false);
  migrated.close();
  const broken = structuredClone(f.e(a));
  broken.actions.find(
    (action) => action.selectionResult,
  )!.selectionResult!.selectedLabel = '错误栏目';
  const corrupt = new Database(file);
  corrupt
    .prepare('UPDATE task_executions SET body=? WHERE task_id=?')
    .run(JSON.stringify(broken), a);
  corrupt.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});
