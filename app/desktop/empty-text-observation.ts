import { z } from 'zod';

const rare = z.object({
  index: z.array(z.number().int().nonnegative()),
  value: z.array(z.number().int()),
});
const snapshotSchema = z.object({
  strings: z.array(z.string()),
  documents: z.array(
    z.object({
      documentURL: z.number().int().nonnegative(),
      nodes: z.object({
        backendNodeId: z.array(z.number().int().positive()),
        nodeName: z.array(z.number().int().nonnegative()),
        attributes: z.array(z.array(z.number().int())),
        textValue: rare.optional(),
        inputValue: rare.optional(),
      }),
    }),
  ),
});

/** 只补同一主文档原生文本控件的显式空值。缺少rare条目绝不等同空值。 */
export function emptyTextObservation(snapshot: unknown, url: string) {
  const result = new Map<number, 'INPUT' | 'TEXTAREA'>();
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return result;
  const { strings, documents } = parsed.data;
  const document = documents[0];
  if (!document || strings[document.documentURL] !== url) return result;
  const nodes = document.nodes;
  const counts = new Map<number, number>();
  for (const id of nodes.backendNodeId)
    counts.set(id, (counts.get(id) ?? 0) + 1);
  for (let index = 0; index < nodes.backendNodeId.length; index++) {
    const id = nodes.backendNodeId[index]!;
    if (counts.get(id) !== 1) continue;
    const name = strings[nodes.nodeName[index]!];
    if (name !== 'INPUT' && name !== 'TEXTAREA') continue;
    const attributes = nodes.attributes[index];
    if (
      !attributes ||
      attributes.length % 2 ||
      attributes.some((v) => v < -1 || v >= strings.length)
    )
      continue;
    const types: string[] = [];
    for (let a = 0; a < attributes.length; a += 2) {
      if (strings[attributes[a]!] === 'type')
        types.push(strings[attributes[a + 1]!] ?? '');
    }
    if (
      name === 'INPUT' &&
      (types.length > 1 ||
        !['', 'text', 'search', 'email', 'url', 'tel'].includes(
          (types[0] ?? '').toLowerCase(),
        ))
    )
      continue;
    const values = name === 'INPUT' ? nodes.inputValue : nodes.textValue;
    if (
      !values ||
      values.index.length !== values.value.length ||
      values.index.filter((v) => v === index).length !== 1
    )
      continue;
    const value = values.value[values.index.indexOf(index)];
    // Chromium AddString 对空字符串返回 -1；必须是该控件实际存在的值条目。
    if (
      value === -1 ||
      (value !== undefined && value >= 0 && strings[value] === '')
    )
      result.set(id, name);
  }
  return result;
}
