import { expect, test } from 'vitest';
import { richTextFrameDocument } from '../../app/desktop/rich-text-frame';
import { pageObservation } from '../../app/desktop/page-observation';
import { richTextControl } from '../../app/shared/rich-text';

function fixture() {
  const url = 'https://example.test/edit',
    childUrl = 'https://example.test/body';
  const strings = [
    url,
    childUrl,
    'main',
    'child',
    '#document',
    'IFRAME',
    'BODY',
    '#text',
    'contenteditable',
    'true',
    '旧正文',
  ];
  const main = {
    documentURL: 0,
    frameId: 2,
    nodes: {
      backendNodeId: [1, 2],
      parentIndex: [-1, 0],
      nodeName: [4, 5],
      nodeValue: [-1, -1],
      attributes: [[], []] as number[][],
      contentDocumentIndex: { index: [1], value: [1] },
    },
    layout: { nodeIndex: [1] },
  };
  const child = {
    documentURL: 1,
    frameId: 3,
    nodes: {
      backendNodeId: [3, 4, 5],
      parentIndex: [-1, 0, 1],
      nodeName: [4, 6, 7],
      nodeValue: [-1, -1, 10],
      attributes: [[], [8, 9], []],
    },
    layout: { nodeIndex: [1, 2] },
  };
  const snapshot = { strings, documents: [main, child] };
  const tree = {
    frame: { id: 'main', url },
    childFrames: [{ frame: { id: 'child', url: childUrl } }],
  };
  const ax = {
    nodes: [
      { nodeId: 'root', role: { value: 'RootWebArea' }, frameId: 'child' },
      {
        nodeId: 'edit',
        backendDOMNodeId: 4,
        role: { value: 'textbox' },
        name: { value: '正文' },
        value: { value: '旧正文' },
        properties: [{ name: 'editable', value: { value: 'richtext' } }],
      },
    ],
  };
  const document = () => richTextFrameDocument(snapshot, tree, 'child', ax);
  const read = () => ({
    ...pageObservation(
      { frameTree: tree.childFrames[0] },
      ax,
      1,
      '',
      undefined,
      document(),
    ),
    url,
  });
  const action = {
    kind: 'fill' as const,
    target: {
      role: 'textbox' as const,
      name: '正文',
      exact: true,
      frameUrl: childUrl,
    },
    value: '中文\n第二行',
  };
  return { snapshot, main, child, tree, ax, document, read, action };
}
test('唯一同站子frame以frameId、AX根、快照父归属证明BODY编辑根', () => {
  const f = fixture();
  expect(richTextControl(f.action, f.read(), true)).toMatchObject({
    frameUrl: f.action.target.frameUrl,
    textValue: '旧正文',
    richText: { backendNodeId: 4, valueSource: 'ax' },
  });
});
test.each([
  'frame-id',
  'ax-root',
  'duplicate-url',
  'duplicate-doc',
  'missing-doc',
  'wrong-parent',
  'hidden',
  'sandbox',
  'owner-missing',
  'cross-origin',
  'url-mismatch',
  'not-iframe',
  'duplicate-owner',
  'duplicate-frame-id',
  'native-empty',
])('拒绝不完整子frame证明：%s', (mode) => {
  const f = fixture();
  if (mode === 'frame-id') f.child.frameId = 2;
  if (mode === 'ax-root') f.ax.nodes[0]!.frameId = 'other';
  if (mode === 'duplicate-url')
    f.tree.childFrames.push({
      frame: { id: 'duplicate', url: f.tree.childFrames[0]!.frame.url },
    });
  if (mode === 'duplicate-frame-id')
    f.tree.childFrames.push(f.tree.childFrames[0]!);
  if (mode === 'duplicate-doc') f.snapshot.documents.push(f.child);
  if (mode === 'missing-doc') f.snapshot.documents.pop();
  if (mode === 'wrong-parent') f.main.nodes.contentDocumentIndex.value = [0];
  if (mode === 'hidden') f.main.layout.nodeIndex = [];
  if (mode === 'sandbox') {
    f.snapshot.strings.push('sandbox', '');
    f.main.nodes.attributes[1] = [11, 12];
  }
  if (mode === 'owner-missing') f.main.nodes.contentDocumentIndex.index = [];
  if (mode === 'cross-origin') {
    f.snapshot.strings[1] = 'https://other.test/body';
    f.tree.childFrames[0]!.frame.url = f.snapshot.strings[1];
  }
  if (mode === 'url-mismatch') f.child.documentURL = 0;
  if (mode === 'not-iframe') f.main.nodes.nodeName[1] = 6;
  if (mode === 'duplicate-owner') {
    f.main.nodes.contentDocumentIndex.index.push(1);
    f.main.nodes.contentDocumentIndex.value.push(1);
  }
  if (mode === 'native-empty') {
    f.snapshot.strings[6] = 'TEXTAREA';
    f.snapshot.strings[10] = '';
  }
  expect(() => richTextControl(f.action, f.read(), true)).toThrow(
    'EXECUTION_RICH_TEXT_UNVERIFIED',
  );
});
test('有祖先归属的嵌套frame可观察；中间frame隐藏拒绝', () => {
  const f = fixture();
  const mid = structuredClone(f.main);
  mid.frameId = 11;
  mid.documentURL = 12;
  mid.nodes.contentDocumentIndex.value = [2];
  f.snapshot.strings.push('middle', 'https://example.test/middle');
  f.snapshot.documents.splice(1, 0, mid);
  const tree = {
    frame: f.tree.frame,
    childFrames: [
      {
        frame: { id: 'middle', url: 'https://example.test/middle' },
        childFrames: f.tree.childFrames,
      },
    ],
  };
  expect(richTextFrameDocument(f.snapshot, tree, 'child', f.ax)).toBeDefined();
  mid.layout.nodeIndex = [];
  expect(
    richTextFrameDocument(f.snapshot, tree, 'child', f.ax),
  ).toBeUndefined();
});
