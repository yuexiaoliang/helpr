import { z } from 'zod';

const snapshotSchema = z.object({
  strings: z.array(z.string()),
  documents: z.array(
    z.object({
      documentURL: z.number().int(),
      nodes: z.object({
        backendNodeId: z.array(z.number().int()),
        parentIndex: z.array(z.number().int()),
        nodeName: z.array(z.number().int()),
        nodeValue: z.array(z.number().int()),
        attributes: z.array(z.array(z.number().int())),
      }),
      layout: z.object({ nodeIndex: z.array(z.number().int()) }),
    }),
  ),
});

/** DOM 只证明主文档编辑根及空正文；非空正文必须由 Chromium AX 给出完整值。
 * 不推算段落换行，不执行网页脚本，不把缺失的 AX 值解释为空。
 */
export function richTextObservation(snapshot: unknown, url: string) {
  const result = new Map<
    number,
    { empty: boolean; text: string; supported: boolean }
  >();
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return result;
  const { strings, documents } = parsed.data;
  const doc = documents[0];
  if (!doc || strings[doc.documentURL] !== url) return result;
  const n = doc.nodes,
    size = n.backendNodeId.length;
  if (
    [n.parentIndex, n.nodeName, n.nodeValue, n.attributes].some(
      (a) => a.length !== size,
    )
  )
    return result;
  if (!size || n.parentIndex[0] !== -1) return result;
  const counts = new Map<number, number>();
  n.backendNodeId.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const attributes = n.attributes.map((raw) => {
    if (raw.length % 2 || raw.some((v) => v < -1 || v >= strings.length))
      return null;
    const a = new Map<string, string>();
    for (let i = 0; i < raw.length; i += 2) {
      const name = strings[raw[i]!];
      if (!name || a.has(name)) return null;
      a.set(name, strings[raw[i + 1]!] ?? '');
    }
    return a;
  });
  const children: number[][] = Array.from({ length: size }, () => []);
  for (let i = 1; i < size; i++) {
    const parent = n.parentIndex[i]!;
    if (parent < 0 || parent >= i) return result;
    children[parent]!.push(i);
  }
  const visible = new Set(doc.layout.nodeIndex);
  const allowed = new Set([
    'DIV',
    'P',
    'SPAN',
    'B',
    'STRONG',
    'I',
    'EM',
    'U',
    'S',
    'BR',
    '#text',
  ]);
  for (let root = 0; root < size; root++) {
    const a = attributes[root],
      id = n.backendNodeId[root]!;
    if (
      !a ||
      !['true', '', 'plaintext-only'].includes(
        a.get('contenteditable') ?? 'false',
      ) ||
      !visible.has(root) ||
      id <= 0 ||
      counts.get(id) !== 1
    )
      continue;
    let valid = true,
      empty = true,
      text = '';
    for (
      let ancestor = n.parentIndex[root]!;
      ancestor >= 0;
      ancestor = n.parentIndex[ancestor]!
    ) {
      if (attributes[ancestor]?.has('contenteditable')) valid = false;
    }
    const visit = (index: number) => {
      const attrs = attributes[index],
        name = strings[n.nodeName[index]!];
      if (
        !attrs ||
        !name ||
        !allowed.has(name) ||
        attrs.has('hidden') ||
        attrs.get('aria-hidden') === 'true' ||
        attrs.get('aria-disabled') === 'true' ||
        attrs.get('aria-readonly') === 'true' ||
        (index !== root && attrs.has('contenteditable')) ||
        counts.get(n.backendNodeId[index]!) !== 1
      ) {
        valid = false;
        return;
      }
      // BR 与块级子节点可能代表换行；缺AX值时不能证明为空。
      if (index !== root && ['BR', 'P', 'DIV'].includes(name)) empty = false;
      if (name === '#text') {
        const valueIndex = n.nodeValue[index]!;
        if (valueIndex < -1 || valueIndex >= strings.length) {
          valid = false;
          return;
        }
        const value = strings[valueIndex] ?? '';
        text += value;
        if (value) {
          empty = false;
          if (!visible.has(index)) valid = false;
        }
      } else if (!visible.has(index)) valid = false;
      for (const child of children[index]!) visit(child);
    };
    visit(root);
    // 多个空段落/BR可能代表换行，不能仅凭无文字推为空正文。
    if (empty) {
      let index = root;
      while (children[index]!.length === 1) index = children[index]![0]!;
      if (children[index]!.length !== 0) valid = false;
    }
    result.set(id, { empty, text, supported: valid });
  }
  return result;
}
