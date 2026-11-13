import { z } from 'zod';
import {
  PAGE_OBSERVATION_TEXT_LIMIT,
  type PageObservation,
} from '../shared/model';
import { websiteURL } from '../shared/url-policy';

const snapshotSchema = z.object({
  strings: z.array(z.string()),
  documents: z.array(
    z.object({
      documentURL: z.number().int(),
      nodes: z.object({
        nodeName: z.array(z.number()),
        attributes: z.array(z.array(z.number())),
        backendNodeId: z.array(z.number()).optional(),
      }),
      layout: z.object({ nodeIndex: z.array(z.number()) }).optional(),
    }),
  ),
});
/** 编辑器可把可见链接呈现为文本框，href 仍来自同一节点的 DOM。 */
export function editableFrameLinks(snapshot: unknown, frameUrl: string) {
  const { documents, strings } = snapshotSchema.parse(snapshot);
  const doc = documents.find((item) => strings[item.documentURL] === frameUrl);
  const result = new Map<number, string>();
  if (!doc?.layout || !doc.nodes.backendNodeId) return result;
  const origin = new URL(frameUrl).origin;
  for (const i of new Set(doc.layout.nodeIndex)) {
    if (strings[doc.nodes.nodeName[i]!] !== 'A') continue;
    const id = doc.nodes.backendNodeId[i];
    const pairs = doc.nodes.attributes[i] ?? [];
    const attributes = new Map<string, string>();
    for (let j = 0; j < pairs.length; j += 2)
      attributes.set(strings[pairs[j]!]!, strings[pairs[j + 1]!] ?? '');
    const href = attributes.get('href');
    if (
      !id ||
      !href ||
      attributes.has('hidden') ||
      attributes.get('aria-hidden') === 'true' ||
      !['true', '', 'plaintext-only'].includes(
        attributes.get('contenteditable') ?? 'false',
      )
    )
      continue;
    try {
      const url = websiteURL(href);
      if (new URL(url).origin === origin && !new URL(url).hash)
        result.set(id, url);
    } catch {
      /* 无效地址不进入附件观察。 */
    }
  }
  return result;
}
/** DOM 快照仅补充文件控件和实际链接，不读取文字框、密码或隐藏字段的值。 */
export function materialObservation(
  snapshot: unknown,
  verifiedBlob?: string,
  inputs?: NonNullable<PageObservation['fileInputs']>,
): string {
  const { documents, strings } = snapshotSchema.parse(snapshot);
  const lines: string[] = [];
  for (const document of documents) {
    const url = strings[document.documentURL];
    if (!url || (url !== verifiedBlob && !/^https?:\/\//.test(url))) continue;
    let fileIndex = 0;
    for (let i = 0; i < document.nodes.nodeName.length; i++) {
      const name = strings[document.nodes.nodeName[i]!]!.toLowerCase();
      if (name !== 'a' && name !== 'input') continue;
      const raw = document.nodes.attributes[i] ?? [],
        attributes: Record<string, string> = {};
      for (let j = 0; j < raw.length; j += 2)
        attributes[strings[raw[j]!]!] = strings[raw[j + 1]!]!;
      if (name === 'input' && attributes.type?.toLowerCase() === 'file') {
        if (fileIndex <= 100) inputs?.push({ fileIndex, frameUrl: url });
        lines.push(
          `[file ${fileIndex++}] ${url} label=${attributes['aria-label'] ?? ''} accept=${attributes.accept ?? ''}`,
        );
      }
      if (name === 'a' && attributes.href) {
        try {
          const link = new URL(attributes.href, url);
          if (['http:', 'https:'].includes(link.protocol))
            lines.push(`[link-url] ${link.href}`);
        } catch {
          /* 无效地址不是恢复入口。 */
        }
      }
    }
  }
  // 多保留一个字符，让合并后的页面观察能标记超限。
  return [...new Set(lines)]
    .join('\n')
    .slice(0, PAGE_OBSERVATION_TEXT_LIMIT + 1);
}
