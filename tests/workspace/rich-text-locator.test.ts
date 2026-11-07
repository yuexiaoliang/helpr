import { reboundAction } from '../../app/shared/workflow-replay';
import type { WorkflowUse } from '../../app/shared/workflow';
import { expect, test } from 'vitest';
import { pageObservation } from '../../app/desktop/page-observation';
import { richTextControl, validRichTextFact } from '../../app/shared/rich-text';
import { webActionSchema } from '../../app/shared/web-action';
import raw from './fixtures/rich-text-observation.json';

// 原始快照派生契约夹具：不冒称无角色版本的实机AX证据。
function fixture() {
  const sample = structuredClone(raw);
  const root = sample.ax.nodes.find((n) => n.role.value === 'textbox')!;
  root.role.value = 'generic';
  root.name!.value = '';
  const read = () =>
    pageObservation(
      { frameTree: { frame: { url: sample.url } } },
      sample.ax,
      1,
      '',
      sample.dom,
    );
  const source = read();
  const control = source.controls!.find((c) => c.richText)!;
  const action = webActionSchema.parse({
    kind: 'fill',
    target: control.richText!.locator,
    value: '甲\n乙',
  });
  return { sample, root, read, source, control, action };
}
test('普通无角色/名称编辑根保留实际AX值，结构定位不伪造名称', () => {
  const f = fixture();
  expect(f.control.role).toBe('generic');
  expect(f.control.name).toBe('');
  expect(f.control.richText!.locator!.path).toMatch(
    /^html:nth-child\(1\) > body:nth-child\(2\) > div:nth-child\(/,
  );
  expect(richTextControl(f.action, f.source)).toEqual(f.control);
});
test.each([
  'node',
  'path',
  'frame',
  'missing',
  'duplicate',
  'value',
  'readonly',
  'truncated',
])('%s不符拒绝结构定位', (mode) => {
  const f = fixture();
  if (!('richTextNodeId' in f.action.target)) throw Error('FIXTURE');
  if (mode === 'node') f.action.target.richTextNodeId++;
  if (mode === 'path') f.action.target.path += ' > span:nth-child(1)';
  if (mode === 'frame') f.action.target.frameUrl += 'wrong';
  if (mode === 'missing') delete f.control.richText!.locator;
  if (mode === 'duplicate') f.source.controls!.push(f.control);
  if (mode === 'value') delete f.control.textValue;
  if (mode === 'readonly') f.control.readOnly = true;
  if (mode === 'truncated') f.source.truncated = true;
  expect(() => richTextControl(f.action, f.source)).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
});
test.each(['ignored', 'protected', 'incomplete', 'ancestor'])(
  '%s不提供可写定位',
  (mode) => {
    const f = fixture();
    if (mode === 'ignored') f.root.ignored = true;
    if (mode === 'protected')
      f.root.properties!.push({
        name: 'protected',
        value: { type: 'boolean', value: true },
      } as never);
    if (mode === 'incomplete') f.sample.dom.documents = [];
    if (mode === 'ancestor') {
      const doc = f.sample.dom.documents[0]!,
        index = doc.nodes.backendNodeId.indexOf(f.root.backendDOMNodeId!);
      const parent = doc.nodes.parentIndex[index]!;
      const key = f.sample.dom.strings.push('aria-readonly') - 1,
        value = f.sample.dom.strings.push('true') - 1;
      doc.nodes.attributes[parent]!.push(key, value);
    }
    expect(() => richTextControl(f.action, f.read())).toThrow(
      'EXECUTION_RICH_TEXT_UNVERIFIED',
    );
  },
);
test('结构定位只属于fill，拒绝任意CSS和混合角色定位', () => {
  const f = fixture();
  for (const kind of ['click', 'select', 'check'])
    expect(webActionSchema.safeParse({ ...f.action, kind }).success).toBe(
      false,
    );
  expect(
    webActionSchema.safeParse({
      ...f.action,
      target: { ...f.action.target, path: 'div, input' },
    }).success,
  ).toBe(false);
  expect(
    webActionSchema.safeParse({
      ...f.action,
      target: { ...f.action.target, role: 'textbox', name: '伪造' },
    }).success,
  ).toBe(false);
});

test('持久化结构定位不能删除源证明，定位中的节点身份必须一致', () => {
  const f = fixture();
  expect(
    validRichTextFact({
      action: f.action,
      source: f.source,
      status: 'unknown',
    }),
  ).toBe(false);
  f.control.richText!.locator!.richTextNodeId++;
  expect(() => richTextControl(f.action, f.source)).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
});

test('结构序号按nodeType计数，SVG等小写元素同样占据兄弟位置', () => {
  const f = fixture(),
    doc = f.sample.dom.documents[0]!,
    n = doc.nodes;
  const root = n.backendNodeId.indexOf(f.root.backendDOMNodeId!),
    parent = n.parentIndex[root]!;
  const before = n.parentIndex.findIndex(
    (p, i) => p === parent && i < root && n.nodeType[i] === 1,
  );
  expect(before).toBeGreaterThan(0);
  n.nodeName[before] = f.sample.dom.strings.push('svg') - 1;
  expect(f.read().controls!.find((c) => c.richText)?.richText?.locator).toEqual(
    f.control.richText!.locator,
  );
});
test.each(['missing-type', 'shadow'])(
  '不完整或shadow父链不生成定位：%s',
  (mode) => {
    const f = fixture(),
      n = f.sample.dom.documents[0]!.nodes;
    if (mode === 'missing-type') n.nodeType = [];
    else
      (n.shadowRootType.index as number[]).push(
        n.backendNodeId.indexOf(f.root.backendDOMNodeId!),
      );
    expect(() => richTextControl(f.action, f.read())).toThrow(
      'EXECUTION_RICH_TEXT_UNVERIFIED',
    );
  },
);

test('已有命名textbox保留角色定位，不引导既有发布改用一次性节点', () => {
  const f = fixture();
  f.root.role.value = 'textbox';
  f.root.name!.value = '正文';
  expect(
    f.read().controls!.find((c) => c.richText)?.richText?.locator,
  ).toBeUndefined();
});
test('保存或导入的工作流不能重放一次性节点定位', () => {
  const f = fixture();
  const use = {
    workflow: { steps: [{ action: f.action }] },
  } as unknown as WorkflowUse;
  expect(() => reboundAction(use, 0)).toThrow('WORKFLOW_NOT_APPLICABLE');
});
