import { z } from 'zod';
import { PAGE_OBSERVATION_TEXT_LIMIT } from '../shared/model';

const snapshotSchema = z.object({
  strings: z.array(z.string()),
  documents: z.array(
    z.object({
      documentURL: z.number().int(),
      nodes: z.object({
        nodeName: z.array(z.number()),
        attributes: z.array(z.array(z.number())),
      }),
    }),
  ),
});
/** DOM 快照仅补充文件控件和实际链接，不读取文字框、密码或隐藏字段的值。 */
export function materialObservation(snapshot: unknown): string {
  const { documents, strings } = snapshotSchema.parse(snapshot);
  const lines: string[] = [];
  for (const document of documents) {
    const url = strings[document.documentURL];
    if (!url || !/^https?:\/\//.test(url)) continue;
    let fileIndex = 0;
    for (let i = 0; i < document.nodes.nodeName.length; i++) {
      const name = strings[document.nodes.nodeName[i]!]!.toLowerCase();
      if (name !== 'a' && name !== 'input') continue;
      const raw = document.nodes.attributes[i] ?? [],
        attributes: Record<string, string> = {};
      for (let j = 0; j < raw.length; j += 2)
        attributes[strings[raw[j]!]!] = strings[raw[j + 1]!]!;
      if (name === 'input' && attributes.type?.toLowerCase() === 'file')
        lines.push(
          `[file ${fileIndex++}] ${url} label=${attributes['aria-label'] ?? ''} accept=${attributes.accept ?? ''}`,
        );
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
