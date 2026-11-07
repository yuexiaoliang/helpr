import { z } from 'zod';
import { isInlineFrameURL, websiteURL } from '../shared/url-policy';
import { frameOriginMatches } from './frame-origins';

const treeNode = z.object({
  frame: z.object({
    id: z.string(),
    url: z.string(),
    securityOrigin: z.string().optional(),
  }),
  childFrames: z.array(z.unknown()).optional(),
});
const documentSchema = z
  .object({
    documentURL: z.number().int(),
    frameId: z.number().int(),
    nodes: z
      .object({
        nodeName: z.array(z.number().int()),
        parentIndex: z.array(z.number().int()),
        attributes: z.array(z.array(z.number().int())),
        contentDocumentIndex: z
          .object({
            index: z.array(z.number().int()),
            value: z.array(z.number().int()),
          })
          .optional(),
      })
      .passthrough(),
    layout: z.object({ nodeIndex: z.array(z.number().int()) }).passthrough(),
  })
  .passthrough();

/** 只把同一快照内可追溯到主文档的唯一同站 frame 交给富文本观察。
 * URL 不是文档身份：同时检查 frameId、AX 根及父文档的 iframe 所有权。
 * 跨进程快照缺失、隐藏、同址歧义或脱离 frame tree 均不补造 DOM 证明。
 */
export function richTextFrameDocument(
  snapshot: unknown,
  frameTree: unknown,
  frameId: string,
  accessibility: unknown,
  nativeOrigins?: unknown,
): unknown {
  const parsed = z
    .object({
      strings: z.array(z.string()),
      documents: z.array(documentSchema),
    })
    .safeParse(snapshot);
  if (!parsed.success) return undefined;
  const { strings, documents } = parsed.data;
  const frames: {
    id: string;
    url: string;
    securityOrigin?: string;
    parent?: string;
  }[] = [];
  const collect = (raw: unknown, parent?: string): boolean => {
    const item = treeNode.safeParse(raw);
    if (!item.success) return false;
    frames.push({ ...item.data.frame, parent });
    return (item.data.childFrames ?? []).every((child) =>
      collect(child, item.data.frame.id),
    );
  };
  if (!collect(frameTree)) return undefined;
  const frame = frames.find((f) => f.id === frameId),
    root = frames[0];
  if (
    !frame?.parent ||
    !root ||
    new Set(frames.map((f) => f.id)).size !== frames.length
  )
    return undefined;
  const ax = z
    .object({
      nodes: z.array(
        z.object({
          role: z.object({ value: z.unknown() }).optional(),
          frameId: z.string().optional(),
        }),
      ),
    })
    .safeParse(accessibility);
  const roots = ax.success
    ? ax.data.nodes.filter((n) => n.role?.value === 'RootWebArea')
    : [];
  if (roots.length !== 1 || roots[0]!.frameId !== frameId) return undefined;
  const docIndex = (id: string, url: string) => {
    const indices = documents.flatMap((doc, i) =>
      strings[doc.frameId] === id ? [i] : [],
    );
    return indices.length === 1 &&
      strings[documents[indices[0]!]!.documentURL] === url
      ? indices[0]!
      : -1;
  };
  let current: typeof frame | undefined = frame;
  while (current) {
    try {
      const origin = new URL(websiteURL(root.url)).origin;
      if (
        nativeOrigins !== undefined &&
        !frameOriginMatches(
          nativeOrigins,
          current.url,
          frames.find((f) => f.id === current!.parent)?.url,
          origin,
        )
      )
        return undefined;
      if (isInlineFrameURL(current.url)) {
        if (
          !current.parent ||
          !nativeOrigins ||
          ![origin, '://'].includes(current.securityOrigin ?? '')
        )
          return undefined;
      } else if (new URL(websiteURL(current.url)).origin !== origin)
        return undefined;
    } catch {
      return undefined;
    }
    if (frames.filter((f) => f.url === current!.url).length !== 1)
      return undefined;
    const index = docIndex(current.id, current.url);
    if (index < 0) return undefined;
    if (!current.parent) {
      if (index !== 0) return undefined;
      break;
    }
    const parent = frames.find((f) => f.id === current!.parent);
    if (!parent) return undefined;
    const parentIndex = docIndex(parent.id, parent.url);
    if (parentIndex < 0) return undefined;
    const parentDoc = documents[parentIndex]!;
    const owners = documents.flatMap((doc, di) => {
      const entries = doc.nodes.contentDocumentIndex;
      if (!entries || entries.index.length !== entries.value.length) return [];
      return entries.value.flatMap((value, i) =>
        value === index ? [{ di, node: entries.index[i]! }] : [],
      );
    });
    if (owners.length !== 1 || owners[0]!.di !== parentIndex) return undefined;
    const owner = owners[0]!.node;
    if (
      strings[parentDoc.nodes.nodeName[owner]!] !== 'IFRAME' ||
      !parentDoc.layout.nodeIndex.includes(owner)
    )
      return undefined;
    const nodes = parentDoc.nodes;
    if (
      nodes.parentIndex.length !== nodes.nodeName.length ||
      nodes.attributes.length !== nodes.nodeName.length ||
      nodes.parentIndex[0] !== -1
    )
      return undefined;
    for (let index = owner; index >= 0; index = nodes.parentIndex[index]!) {
      if (
        index > 0 &&
        (nodes.parentIndex[index]! < 0 || nodes.parentIndex[index]! >= index)
      )
        return undefined;
      const attrs = nodes.attributes[index];
      if (!attrs || attrs.length % 2) return undefined;
      const attributes = new Map<string, string>();
      for (let i = 0; i < attrs.length; i += 2) {
        const name = strings[attrs[i]!],
          value = strings[attrs[i + 1]!];
        if (!name || value === undefined || attributes.has(name))
          return undefined;
        attributes.set(name, value);
      }
      if (index === owner && isInlineFrameURL(current.url)) {
        // URL 只能用当前文档事实；不接受脚本URL、片段或srcdoc/blank矛盾。
        const src = attributes.get('src');
        if (
          current.url === 'about:srcdoc'
            ? !attributes.has('srcdoc')
            : attributes.has('srcdoc') ||
              (src !== undefined && src !== '' && src !== 'about:blank')
        )
          return undefined;
      }
      if (
        attributes.has('hidden') ||
        attributes.has('sandbox') ||
        attributes.get('aria-hidden') === 'true' ||
        attributes.get('aria-disabled') === 'true'
      )
        return undefined;
    }
    current = parent;
  }
  return { strings, documents: [documents[docIndex(frame.id, frame.url)]] };
}
