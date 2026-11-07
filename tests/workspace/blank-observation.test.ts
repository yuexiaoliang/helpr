import { expect, test } from 'vitest';
import sample from './fixtures/blank-creation-observation.json';
import { pageObservation } from '../../app/desktop/page-observation';

test('真实Chromium省略空textarea AX值时，仅同节点快照的显式空值可补足', () => {
  const o = pageObservation(
    { frameTree: { frame: { url: sample.url } } },
    sample.ax,
    1,
    '',
    sample.dom,
  );
  expect(o.controls!.find((c) => c.name === '正文')).toMatchObject({
    textValue: '',
    emptyValue: {
      rule: 'native-empty-snapshot-v1',
      backendNodeId: 17,
      nodeName: 'TEXTAREA',
    },
  });
  expect(
    pageObservation(
      { frameTree: { frame: { url: sample.url } } },
      sample.ax,
      1,
    ).controls!.find((c) => c.name === '正文')?.textValue,
  ).toBeUndefined();
});

test.each([
  'missing-entry',
  'wrong-value',
  'duplicate-entry',
  'wrong-node',
  'duplicate-node',
  'wrong-document',
  'password',
  'protected',
  'ax-value',
])('空值补充拒绝不完整或冲突证据：%s', (variant) => {
  const dom = structuredClone(sample.dom),
    nodes = dom.documents[0]!.nodes;
  let ax: unknown = sample.ax;
  if (variant === 'missing-entry') nodes.textValue = { index: [], value: [] };
  if (variant === 'wrong-value') nodes.textValue.value = [1];
  if (variant === 'duplicate-entry')
    nodes.textValue = { index: [16, 16], value: [-1, -1] };
  if (variant === 'wrong-node') nodes.backendNodeId[16] = 900;
  if (variant === 'duplicate-node') nodes.backendNodeId[15] = 17;
  if (variant === 'wrong-document') dom.documents[0]!.documentURL = 1;
  if (variant === 'password') {
    nodes.nodeName[16] = 23;
    const start = dom.strings.length;
    dom.strings.push('type', 'password');
    nodes.attributes[16] = [start, start + 1];
    nodes.inputValue.index.push(16);
    nodes.inputValue.value.push(-1);
  }
  if (variant === 'protected')
    ax = {
      nodes: sample.ax.nodes.map((n) =>
        n.nodeId === '17'
          ? {
              ...n,
              properties: [
                ...(n.properties ?? []),
                { name: 'protected', value: { value: true } },
              ],
            }
          : n,
      ),
    };
  if (variant === 'ax-value')
    ax = {
      nodes: sample.ax.nodes.map((n) =>
        n.nodeId === '17' ? { ...n, value: { value: '已有正文' } } : n,
      ),
    };
  const o = pageObservation(
    { frameTree: { frame: { url: sample.url } } },
    ax,
    1,
    '',
    dom,
  );
  const field = o.controls!.find((c) => c.name === '正文');
  expect(field?.emptyValue).toBeUndefined();
  expect(field?.textValue).toBe(
    variant === 'ax-value' ? '已有正文' : undefined,
  );
});
