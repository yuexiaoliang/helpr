import { actionFactSchema } from '../../app/shared/execution';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { pageObservation } from '../../app/desktop/page-observation';
import { richTextControl, verifiedRichText } from '../../app/shared/rich-text';
import { WorkspaceRecords } from '../../app/records/workspace';
import type { PageObservation } from '../../app/shared/model';
import type { WebAction } from '../../app/shared/web-action';

const url = 'https://example.com/edit';
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function observed(value?: string) {
  const strings = [
    url,
    '#document',
    'DIV',
    '#text',
    'contenteditable',
    'true',
    value ?? '',
  ];
  const dom = {
    strings,
    documents: [
      {
        documentURL: 0,
        nodes: {
          backendNodeId: [1, 2, 3],
          parentIndex: [-1, 0, 1],
          nodeName: [1, 2, 3],
          nodeValue: [-1, -1, 6],
          attributes: [[], [4, 5], []],
        },
        layout: { nodeIndex: [1, 2] },
      },
    ],
  };
  const ax = {
    nodes: [
      {
        nodeId: '2',
        backendDOMNodeId: 2,
        role: { value: 'textbox' },
        name: { value: '正文' },
        ...(value === undefined ? {} : { value: { value } }),
        properties: [
          { name: 'editable', value: { value: 'richtext' } },
          { name: 'readonly', value: { value: false } },
        ],
      },
    ],
  };
  const read = () =>
    pageObservation({ frameTree: { frame: { url } } }, ax, 1, '', dom);
  return { dom, ax, read };
}
const action: WebAction = {
  kind: 'fill',
  target: { role: 'textbox', name: '正文', exact: true },
  value: '中文\n<a>&结尾',
};
test('空富文本须有完整空DOM，非空全文来自AX并与DOM核对', () => {
  const empty = observed();
  expect(richTextControl(action, empty.read())).toMatchObject({
    textValue: '',
    richText: { valueSource: 'empty-dom' },
  });
  const full = observed(action.value);
  expect(verifiedRichText(action, full.read())).toMatchObject({
    textValue: action.value,
    richText: { valueSource: 'ax' },
  });
  expect(full.read().fingerprint).not.toBe(empty.read().fingerprint);
});
test.each([
  'missing-dom',
  'wrong-document',
  'duplicate-node',
  'hidden-text',
  'nested-editor',
  'unsupported-child',
  'wrong-value',
  'missing-ax',
  'protected',
  'readonly',
  'disabled',
  'long',
])('富文本拒绝不完整或冲突观察：%s', (variant) => {
  const f = observed('已有正文');
  const n = f.dom.documents[0]!.nodes;
  if (variant === 'missing-dom') f.dom.documents = [];
  if (variant === 'wrong-document') f.dom.documents[0]!.documentURL = 1;
  if (variant === 'duplicate-node') n.backendNodeId[2] = 2;
  if (variant === 'hidden-text') f.dom.documents[0]!.layout.nodeIndex = [1];
  if (variant === 'nested-editor') n.attributes[2] = [4, 5];
  if (variant === 'unsupported-child') f.dom.strings[3] = 'INPUT';
  if (variant === 'wrong-value') f.dom.strings[6] = '不同正文';
  if (variant === 'missing-ax') delete f.ax.nodes[0]!.value;
  if (variant === 'protected')
    f.ax.nodes[0]!.properties.push({
      name: 'protected',
      value: { value: true },
    });
  if (variant === 'readonly')
    f.ax.nodes[0]!.properties.push({
      name: 'readonly',
      value: { value: true },
    });
  if (variant === 'disabled')
    f.ax.nodes[0]!.properties.push({
      name: 'disabled',
      value: { value: true },
    });
  if (variant === 'long') {
    f.dom.strings[6] = '文'.repeat(4001);
    f.ax.nodes[0]!.value = { value: f.dom.strings[6] };
  }
  expect(() => richTextControl(action, f.read(), true)).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
});
test.each([
  'mismatch',
  'duplicate',
  'subframe',
  'within',
  'inexact',
  'truncated',
])('实际核对不接受模型或定位声明代替全文：%s', (variant) => {
  const source = observed(action.value).read(),
    a = structuredClone(action);
  if (variant === 'mismatch') source.controls![0]!.textValue = '改写';
  if (variant === 'duplicate')
    source.controls!.push({ ...source.controls![0]! });
  if (variant === 'subframe') a.target.frameUrl = 'https://example.com/frame';
  if ('richTextNodeId' in a.target) throw Error('ROLE_FIXTURE_REQUIRED');
  if (variant === 'within')
    a.target.within = { role: 'row', name: '行', exact: true };
  if (variant === 'inexact') a.target.exact = false;
  if (variant === 'truncated') source.truncated = true;
  expect(() => verifiedRichText(a, source)).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
});
function recordsFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'helpr-rich-text-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  cleanups.push(() => records.close());
  const taskId = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: '在 ' + url + ' 填写正文',
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId,
    url,
    phase: 'manual',
  });
  const post = (c: Record<string, unknown>) =>
    records.execution({ taskId, ...c });
  post({ kind: 'intent', requestId: randomUUID(), intent: 'start' });
  post({ kind: 'claim', runId: 'rich' });
  const source = observed().read(),
    binding = { targetId: 'page', generation: 1 };
  const reserve = {
    kind: 'reserve',
    runId: 'rich',
    id: 'fill',
    summary: '填写正文',
    action,
    source,
    binding,
    evidence: ['正文'],
  };
  const read = () =>
    records.snapshot().tasks.find((t) => t.id === taskId)!.execution!;
  const cold = () => {
    records.close();
    records = new WorkspaceRecords(dir, 'app/records/migrations');
    return read();
  };
  return {
    dir,
    post,
    read,
    cold,
    reserve,
    binding,
    taskId,
    records: () => records,
  };
}
test('冻结源控件；模型确认不能绕过实际全文；冷开保留核对', () => {
  const f = recordsFixture();
  f.post(f.reserve);
  f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
  f.post({ kind: 'reported', id: 'fill', returned: true });
  const resolve = {
    kind: 'resolve',
    runId: 'rich',
    id: 'fill',
    evidence: ['正文'],
    binding: f.binding,
  };
  expect(() =>
    f.post({ ...resolve, source: observed('网站改写').read() }),
  ).toThrow('EXECUTION_RICH_TEXT_UNVERIFIED');
  expect(f.read().actions[0]!.status).toBe('unknown');
  f.post({ ...resolve, source: observed(action.value).read() });
  expect(f.read().actions[0]).toMatchObject({
    status: 'confirmed',
    richTextSource: { textValue: '' },
    richTextResult: { textValue: action.value },
  });
  expect(f.cold().actions[0]!.richTextResult!.textValue).toBe(action.value);
  const saved = structuredClone(f.read().actions[0]!);
  saved.richTextResult!.textValue = '伪造';
  expect(actionFactSchema.safeParse(saved).success).toBe(false);
  delete saved.richTextResult;
  expect(actionFactSchema.safeParse(saved).success).toBe(false);
});
test('富文本不完整时不预留，不凭其它页面完成核对', () => {
  const f = recordsFixture(),
    bad = observed('正文');
  bad.dom.documents = [];
  expect(() => f.post({ ...f.reserve, source: bad.read() })).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
  expect(f.read().actions).toHaveLength(0);
  f.post(f.reserve);
  f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
  const source: PageObservation = {
    ...observed(action.value).read(),
    url: 'https://example.com/other',
  };
  expect(() =>
    f.post({
      kind: 'resolve',
      runId: 'rich',
      id: 'fill',
      source,
      binding: f.binding,
      evidence: ['正文'],
    }),
  ).toThrow('EXECUTION_RICH_TEXT_UNVERIFIED');
});
test('格式31迁移先备份；确认正文随真实备份恢复仍待复核', async () => {
  const f = recordsFixture();
  f.post(f.reserve);
  f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
  f.post({
    kind: 'resolve',
    runId: 'rich',
    id: 'fill',
    source: observed(action.value).read(),
    binding: f.binding,
    evidence: ['正文'],
  });
  const file = path.join(f.dir, 'workspace.sqlite');
  const db = new Database(file);
  db.prepare('UPDATE workspace SET schema_version = 31').run();
  db.close();
  expect(f.cold().actions[0]!.status).toBe('confirmed');
  expect(
    readdirSync(f.dir).some((n) =>
      n.startsWith('workspace-before-rich-text-23-'),
    ),
  ).toBe(true);
  const fileBackup = path.join(f.dir, 'rich.helpr-backup');
  const saved = await f
    .records()
    .backup({ kind: 'create', requestId: randomUUID(), file: fileBackup });
  const g = recordsFixture();
  await g.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: fileBackup,
    checksum: saved.archive.checksum,
  });
  expect(
    g
      .records()
      .snapshot()
      .tasks.find((t) => t.id === f.taskId)!.execution,
  ).toMatchObject({ restoreReview: 'required', actions: f.read().actions });
});

test('旧备份中的未明富文本动作不能被模型review声明完成', async () => {
  const f = recordsFixture();
  f.post(f.reserve);
  f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
  f.post({ kind: 'reported', id: 'fill', returned: true });
  const file = path.join(f.dir, 'pending.helpr-backup');
  const saved = await f
    .records()
    .backup({ kind: 'create', requestId: randomUUID(), file });
  const g = recordsFixture();
  await g.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  const current = () =>
    g
      .records()
      .snapshot()
      .tasks.find((t) => t.id === f.taskId)!.execution!;
  g.records().execution({
    kind: 'backup-review-result',
    taskId: f.taskId,
    expectedVersion: current().version,
    source: observed(action.value).read(),
    step: {
      decision: 'complete',
      summary: '声称成功',
      evidence: ['正文'],
      previous: { id: 'fill', status: 'confirmed', evidence: ['正文'] },
      action: null,
    },
  });
  expect(current()).toMatchObject({
    restoreReview: 'unknown',
    actions: [{ status: 'unknown' }],
  });
});

test('空段落歧义、循环父节点和伪造空值来源均拒绝', () => {
  const f = observed();
  const n = f.dom.documents[0]!.nodes;
  n.backendNodeId.push(4);
  n.parentIndex.push(1);
  n.nodeName.push(2);
  n.nodeValue.push(-1);
  n.attributes.push([]);
  f.dom.documents[0]!.layout.nodeIndex.push(3);
  expect(() => richTextControl(action, f.read(), true)).toThrow();
  n.parentIndex[0] = 0;
  expect(() => richTextControl(action, f.read(), true)).toThrow();
  const full = observed(action.value).read();
  full.controls![0]!.richText!.valueSource = 'empty-dom';
  expect(() => verifiedRichText(action, full)).toThrow();
});

test('实际段落改写后的富文本不符必须保存暂停，不能误判为记录故障而停在running', async () => {
  const { ExecutionService } =
    await import('../../app/desktop/execution-service');
  const { default: sample } =
    await import('./fixtures/rich-text-observation.json');
  const f = recordsFixture();
  f.post({ kind: 'intent', requestId: randomUUID(), intent: 'stop' });
  let state = f.records().snapshot(),
    writes = 0;
  const service = new ExecutionService({
    current: () => state,
    publish: (next) => {
      state = next;
    },
    records: (c) => Promise.resolve(f.records().execution(c)),
    observe: () =>
      Promise.resolve({
        binding: f.binding,
        observation: observed(writes ? sample.input.actual : undefined).read(),
      }),
    propose: (input) =>
      Promise.resolve({
        decision: input.pending ? 'complete' : 'act',
        summary: '核对正文',
        evidence: ['正文'],
        previous: input.pending
          ? { id: input.pending.id, status: 'confirmed', evidence: ['正文'] }
          : null,
        action: input.pending
          ? null
          : { ...action, value: sample.input.sent.replace('\n\n', '\n') },
      }),
    perform: () => {
      writes++;
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
  });
  try {
    await service.intent({
      kind: 'execution-intent',
      requestId: randomUUID(),
      taskId: f.taskId,
      intent: 'continue',
    });
    await service.settled();
    expect(writes).toBe(1);
    expect(f.read()).toMatchObject({
      phase: 'paused',
      actions: [{ status: 'unknown' }],
    });
    expect(f.read().summary).toContain('富文本');
  } finally {
    service.disable();
  }
});

test('真实Chromium占位段落的AX换行必须原样保留，不当成空正文', async () => {
  const { default: sample } =
    await import('./fixtures/rich-text-observation.json');
  const source = pageObservation(
    { frameTree: { frame: { url: sample.url } } },
    sample.ax,
    1,
    '',
    sample.dom,
  );
  expect(source.controls!.find((c) => c.name === '正文')).toMatchObject({
    textValue: '\n',
    richText: { valueSource: 'ax' },
  });
  expect(sample.input.actual).toContain('\n\n');
});

test('真实占位BR在AX缺值时仍不能冒充空正文', async () => {
  const { default: sample } =
    await import('./fixtures/rich-text-observation.json');
  const ax = structuredClone(sample.ax);
  for (const node of ax.nodes)
    if (node.role?.value === 'textbox') delete node.value;
  const source = pageObservation(
    { frameTree: { frame: { url: sample.url } } },
    ax,
    1,
    '',
    sample.dom,
  );
  expect(source.controls!.find((c) => c.name === '正文')).toMatchObject({
    richTextUnavailable: true,
  });
  expect(
    source.controls!.find((c) => c.name === '正文')?.textValue,
  ).toBeUndefined();
});

test.each(['about:blank', 'about:srcdoc'])(
  '内联正文%s可靠保存并冷开，来源变化不确认',
  (frameUrl) => {
    const f = recordsFixture();
    const read = (value?: string) => {
      const source = observed(value).read();
      source.controls![0]!.frameUrl = frameUrl;
      return source;
    };
    f.post({
      ...f.reserve,
      action: { ...action, target: { ...action.target, frameUrl } },
      source: read(),
    });
    f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
    f.post({ kind: 'reported', id: 'fill', returned: true });
    const resolve = {
      kind: 'resolve',
      runId: 'rich',
      id: 'fill',
      evidence: ['正文'],
      binding: f.binding,
    };
    const wrong = read(action.value);
    wrong.controls![0]!.frameUrl = 'about:blank#changed';
    expect(() => f.post({ ...resolve, source: wrong })).toThrow(
      'EXECUTION_RICH_TEXT_UNVERIFIED',
    );
    f.post({ ...resolve, source: read(action.value) });
    const saved = f.cold().actions[0]!;
    expect(saved.status).toBe('confirmed');
    expect(saved.richTextResult!.frameUrl).toBe(frameUrl);
    expect(actionFactSchema.safeParse(saved).success).toBe(true);
  },
);

test('结构定位随格式33保存、冷开和备份；32迁移先留副本', async () => {
  const f = recordsFixture();
  const source = f.reserve.source,
    control = source.controls![0]!;
  const locator = {
    richTextNodeId: control.richText!.backendNodeId,
    path: 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)',
    frameUrl: url,
  };
  control.role = 'generic';
  control.name = '';
  control.richText!.locator = locator;
  const proposal = { kind: 'fill' as const, target: locator, value: '新正文' };
  f.post({ ...f.reserve, action: proposal });
  f.post({ kind: 'dispatch', runId: 'rich', id: 'fill' });
  const result = structuredClone(source);
  result.controls![0]!.textValue = proposal.value;
  result.controls![0]!.richText!.valueSource = 'ax';
  f.post({
    kind: 'resolve',
    runId: 'rich',
    id: 'fill',
    source: result,
    binding: f.binding,
    evidence: ['正文'],
  });
  expect(f.cold().actions[0]!.action).toEqual(proposal);
  const backup = path.join(f.dir, 'locator.helpr-backup');
  const saved = await f
    .records()
    .backup({ kind: 'create', requestId: randomUUID(), file: backup });
  const g = recordsFixture();
  await g.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: backup,
    checksum: saved.archive.checksum,
  });
  expect(
    g
      .records()
      .snapshot()
      .tasks.find((t) => t.id === f.taskId)!.execution,
  ).toMatchObject({ restoreReview: 'required', actions: f.read().actions });
  // 使用另一份旧角色记录模拟32输入，不能把33新定位冒充旧数据。
  const old = recordsFixture();
  const db = new Database(path.join(old.dir, 'workspace.sqlite'));
  db.prepare('UPDATE workspace SET schema_version=32').run();
  db.close();
  old.cold();
  expect(
    readdirSync(old.dir).some((n) =>
      n.startsWith('workspace-before-rich-text-locator-23-'),
    ),
  ).toBe(true);
});
