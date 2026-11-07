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
    childFrames: [
      {
        frame: {
          id: 'child',
          url: childUrl,
          securityOrigin: 'https://example.test' as string | undefined,
        },
      },
    ],
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
  const origins = {
    targetId: 'page',
    generation: 1,
    frames: [
      {
        id: 1,
        parentId: null as number | null,
        token: 'main',
        processId: 1,
        url,
        origin: 'https://example.test',
        detached: false,
      },
      {
        id: 2,
        parentId: 1 as number | null,
        token: 'child',
        processId: 1,
        url: childUrl,
        origin: 'https://example.test',
        detached: false,
      },
    ],
  };
  const document = () =>
    richTextFrameDocument(snapshot, tree, 'child', ax, origins);
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
  return { snapshot, main, child, tree, ax, document, read, action, origins };
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
      frame: { ...f.tree.childFrames[0]!.frame, id: 'duplicate' },
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

function inlineFixture(url: 'about:blank' | 'about:srcdoc') {
  const f = fixture();
  f.snapshot.strings[1] = url;
  f.tree.childFrames[0]!.frame.url = url;
  f.action.target.frameUrl = url;
  f.origins.frames[1]!.url = url;
  if (url === 'about:srcdoc') {
    f.snapshot.strings.push(
      'srcdoc',
      '<body contenteditable="true">旧正文</body>',
    );
    f.main.nodes.attributes[1] = [11, 12];
  }
  return f;
}
test.each(['about:blank', 'about:srcdoc'] as const)(
  '%s由安全来源及父DOM证明归属，不能作为主网站地址',
  (url) => {
    const f = inlineFixture(url);
    expect(richTextControl(f.action, f.read(), true)).toMatchObject({
      frameUrl: url,
      textValue: '旧正文',
    });
    expect(() =>
      pageObservation(
        { frameTree: { frame: { url } } },
        f.ax,
        1,
        '',
        f.snapshot,
      ),
    ).toThrow('URL_DENIED');
    const withoutProof = () =>
      pageObservation({ frameTree: { frame: { url } } }, f.ax, 1);
    expect(withoutProof).toThrow('URL_DENIED');
  },
);
test.each([
  'origin-missing',
  'origin-cross-site',
  'opaque',
  'sandbox',
  'duplicate',
  'srcdoc-missing',
  'blank-srcdoc',
  'script-src',
  'fragment',
  'owner',
  'ax-root',
])('内联frame拒绝%s', (mode) => {
  const f = inlineFixture(
    mode === 'srcdoc-missing' ? 'about:srcdoc' : 'about:blank',
  );
  const frame = f.tree.childFrames[0]!.frame;
  if (mode === 'origin-missing') frame.securityOrigin = undefined;
  if (mode === 'origin-cross-site') frame.securityOrigin = 'https://other.test';
  if (mode === 'opaque') {
    frame.securityOrigin = '://';
    f.origins.frames[1]!.origin = 'null';
  }
  if (mode === 'sandbox') {
    f.snapshot.strings.push('sandbox', 'allow-same-origin');
    f.main.nodes.attributes[1] = [11, 12];
  }
  if (mode === 'duplicate')
    f.tree.childFrames.push({ frame: { ...frame, id: 'second' } });
  if (mode === 'srcdoc-missing') f.main.nodes.attributes[1] = [];
  if (mode === 'blank-srcdoc') {
    f.snapshot.strings.push('srcdoc', '');
    f.main.nodes.attributes[1] = [11, 12];
  }
  if (mode === 'script-src') {
    f.snapshot.strings.push('src', 'javascript:""');
    f.main.nodes.attributes[1] = [11, 12];
  }
  if (mode === 'fragment') {
    f.snapshot.strings[1] = 'about:blank#editor';
    frame.url = f.snapshot.strings[1];
  }
  if (mode === 'owner') f.main.nodes.contentDocumentIndex.value = [];
  if (mode === 'ax-root') f.ax.nodes[0]!.frameId = 'other';
  expect(f.document()).toBeUndefined();
});
test('内联frame只提供富文本，不扩原生控件或结果链接', () => {
  const f = inlineFixture('about:srcdoc');
  const ax = {
    nodes: [
      ...f.ax.nodes,
      {
        nodeId: 'native',
        role: { value: 'textbox' },
        name: { value: '原生字段' },
        value: { value: '值' },
      },
      {
        nodeId: 'link',
        role: { value: 'link' },
        name: { value: '结果' },
        properties: [
          { name: 'url', value: { value: 'https://example.test/result' } },
        ],
      },
    ],
  };
  const read = pageObservation(
    { frameTree: f.tree.childFrames[0] },
    ax,
    1,
    '',
    undefined,
    f.document(),
  );
  expect(read.controls).toHaveLength(1);
  expect(read.links).toEqual([]);
});

test('srcdoc经blank父文档逐层继承来源，中间来源或owner不完整仍拒绝', () => {
  const f = inlineFixture('about:srcdoc');
  const middle = structuredClone(f.main);
  middle.frameId = f.snapshot.strings.push('middle') - 1;
  middle.documentURL = f.snapshot.strings.push('about:blank') - 1;
  middle.nodes.contentDocumentIndex.value = [2];
  f.main.nodes.attributes[1] = [];
  f.snapshot.documents.splice(1, 0, middle);
  const middleFrame = {
    id: 'middle',
    url: 'about:blank',
    securityOrigin: 'https://example.test',
  };
  const tree = {
    frame: f.tree.frame,
    childFrames: [{ frame: middleFrame, childFrames: f.tree.childFrames }],
  };
  f.origins.frames[1]!.parentId = 3;
  f.origins.frames.push({
    id: 3,
    parentId: 1,
    token: 'middle',
    processId: 1,
    url: 'about:blank',
    origin: 'https://example.test',
    detached: false,
  });
  expect(
    richTextFrameDocument(f.snapshot, tree, 'child', f.ax, f.origins),
  ).toBeDefined();
  middleFrame.securityOrigin = 'https://other.test';
  expect(
    richTextFrameDocument(f.snapshot, tree, 'child', f.ax, f.origins),
  ).toBeUndefined();
  middleFrame.securityOrigin = 'https://example.test';
  middle.nodes.attributes[1] = [];
  expect(
    richTextFrameDocument(f.snapshot, tree, 'child', f.ax, f.origins),
  ).toBeUndefined();
});

test('274真实快照的://不作为来源证明，额外宿主来源及父归属齐备才可核对', async () => {
  const { default: sample } =
    await import('./fixtures/inline-frame-observation.json');
  const child = sample.tree.childFrames[0]!.frame;
  expect(
    richTextFrameDocument(sample.dom, sample.tree, child.id, sample.ax),
  ).toBeUndefined();
  // 这里是宿主契约夹具；实际WebFrameMain读数另由新候选采集，不能补造274来源。
  const origin = sample.tree.frame.securityOrigin;
  const native = {
    targetId: 'page',
    generation: 2,
    frames: [
      {
        id: 1,
        parentId: null,
        token: 'main',
        processId: 1,
        url: sample.tree.frame.url,
        origin,
        detached: false,
      },
      {
        id: 2,
        parentId: 1,
        token: 'child',
        processId: 1,
        url: child.url,
        origin,
        detached: false,
      },
    ],
  };
  expect(
    richTextFrameDocument(sample.dom, sample.tree, child.id, sample.ax, native),
  ).toBeDefined();
  native.frames[1]!.origin = 'null';
  expect(
    richTextFrameDocument(sample.dom, sample.tree, child.id, sample.ax, native),
  ).toBeUndefined();
});

test.each([
  'missing',
  'origin',
  'parent',
  'duplicate-url',
  'duplicate-id',
  'duplicate-token',
  'detached',
  'root-origin',
  'root-parent',
])('内联宿主来源%s不能被CDP同站字符串替代', (mode) => {
  const f = inlineFixture('about:blank');
  const n = f.origins.frames;
  if (mode === 'origin') n[1]!.origin = 'https://other.test';
  if (mode === 'parent') n[1]!.parentId = null;
  if (mode === 'duplicate-url') n.push({ ...n[1]!, id: 3, token: 'other' });
  if (mode === 'duplicate-id') n[1]!.id = 1;
  if (mode === 'duplicate-token') n[1]!.token = 'main';
  if (mode === 'detached') n[1]!.detached = true;
  if (mode === 'root-origin') n[0]!.origin = 'null';
  if (mode === 'root-parent') n[0]!.parentId = 2;
  expect(
    richTextFrameDocument(
      f.snapshot,
      f.tree,
      'child',
      f.ax,
      mode === 'missing' ? undefined : f.origins,
    ),
  ).toBeUndefined();
});
