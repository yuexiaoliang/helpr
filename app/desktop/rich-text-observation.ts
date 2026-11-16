import { z } from 'zod';

const snapshotSchema = z.object({
  strings: z.array(z.string()),
  documents: z.array(
    z.object({
      documentURL: z.number().int(),
      nodes: z.object({
        backendNodeId: z.array(z.number().int()),
        parentIndex: z.array(z.number().int()),
        nodeType: z.array(z.number().int()).optional(),
        shadowRootType: z
          .object({
            index: z.array(z.number().int()),
            value: z.array(z.number().int()),
          })
          .optional(),
        pseudoType: z.object({ index: z.array(z.number().int()) }).optional(),
        nodeName: z.array(z.number().int()),
        nodeValue: z.array(z.number().int()),
        attributes: z.array(z.array(z.number().int())),
      }),
      layout: z.object({ nodeIndex: z.array(z.number().int()) }),
    }),
  ),
});

/** DOM 只证明已归属文档编辑根及空正文；非空正文必须由 Chromium AX 给出完整值。
 * 不推算段落换行，不执行网页脚本，不把缺失的 AX 值解释为空。
 */
export function richTextObservation(snapshot: unknown, url: string) {
  const result = new Map<
    number,
    {
      empty: boolean;
      text: string;
      supported: boolean;
      path?: string;
      pathWithPseudo?: string;
      caretPlaceholder?: true;
    }
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
  const pseudo = new Set(n.pseudoType?.index);
  const allowed = new Set([
    'BODY',
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
      id = n.backendNodeId[root]!,
      rootTag = strings[n.nodeName[root]!];
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
    // 只接受纯文本段落末尾的空 CSS 占位装饰。输入后装饰仍可能存在，
    // 此时正文仍须完整匹配 AX。只有单个零宽填充字符表示空值。
    const paragraphChildren = children[root]!;
    const placeholder =
      rootTag === 'P' && a.get('role') === 'document'
        ? paragraphChildren.at(-1)
        : undefined;
    const textNodes = paragraphChildren.slice(0, -1);
    const decoration =
      placeholder === undefined
        ? undefined
        : children[placeholder]!.length === 1
          ? children[placeholder]![0]
          : undefined;
    const placeholderAttrs =
      placeholder === undefined ? undefined : attributes[placeholder];
    const style = placeholderAttrs
      ?.get('style')
      ?.split(';')
      .map((rule) => rule.replace(/\s/g, ''));
    const hasPlaceholderDecoration =
      placeholder !== undefined &&
      strings[n.nodeName[placeholder]!] === 'SPAN' &&
      n.nodeValue[placeholder] === -1 &&
      !!placeholderAttrs?.get('data-rich-text-placeholder') &&
      style?.includes('pointer-events:none') &&
      style.includes('user-select:none') &&
      decoration !== undefined &&
      strings[n.nodeName[decoration]!] === '::after' &&
      n.nodeValue[decoration] === -1 &&
      !children[decoration]!.length &&
      (textNodes.length === 1 || textNodes.length === 2) &&
      textNodes.every(
        (index, position) =>
          strings[n.nodeName[index]!] === '#text' &&
          !children[index]!.length &&
          (position === textNodes.length - 1 ||
            (strings[n.nodeValue[index]!] ?? '') === ''),
      );
    let valid = true,
      empty = true,
      text = '';
    for (
      let ancestor = n.parentIndex[root]!;
      ancestor >= 0;
      ancestor = n.parentIndex[ancestor]!
    ) {
      const attrs = attributes[ancestor];
      if (
        !attrs ||
        (attrs.has('contenteditable') &&
          attrs.get('contenteditable') !== 'false') ||
        attrs.has('hidden') ||
        attrs.get('aria-hidden') === 'true' ||
        attrs.get('aria-disabled') === 'true' ||
        attrs.get('aria-readonly') === 'true'
      )
        valid = false;
    }
    const visit = (index: number) => {
      const attrs = attributes[index],
        name = strings[n.nodeName[index]!];
      if (
        !attrs ||
        !name ||
        (!allowed.has(name) &&
          !(index === root && /^(?:A|H[1-6])$/.test(rootTag ?? '')) &&
          !(hasPlaceholderDecoration && index === decoration)) ||
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
    // 只沿真实元素父链形成位置；shadow/document-fragment不转换成普通CSS路径。
    const parts: string[] = [];
    const partsWithPseudo: string[] = [];
    for (let index = root; index > 0; index = n.parentIndex[index]!) {
      const name = strings[n.nodeName[index]!] ?? '';
      if (
        n.nodeType?.length !== size ||
        n.nodeType[index] !== 1 ||
        n.shadowRootType?.index.includes(index) ||
        !/^[A-Z][A-Z0-9-]*$/.test(name) ||
        parts.length >= 33
      ) {
        parts.length = 0;
        break;
      }
      const snapshotSiblings = children[n.parentIndex[index]!]!.filter(
        (i) => n.nodeType![i] === 1,
      );
      const siblings = snapshotSiblings.filter(
        (i) => !pseudo.has(i) && !strings[n.nodeName[i]!]?.startsWith('::'),
      );
      if (!siblings.includes(index)) {
        parts.length = 0;
        break;
      }
      const part = (ordinal: number) =>
        `${name.toLowerCase()}:nth-child(${ordinal})`;
      parts.unshift(part(siblings.indexOf(index) + 1));
      partsWithPseudo.unshift(part(snapshotSiblings.indexOf(index) + 1));
    }
    const path = parts.join(' > ');
    const pathWithPseudo = partsWithPseudo.join(' > ');
    result.set(id, {
      empty,
      text,
      supported: valid,
      ...(hasPlaceholderDecoration &&
        text === '\uFEFF' && { caretPlaceholder: true }),
      ...(path.startsWith('html:nth-child(1) > ') && path.length <= 2000
        ? {
            path,
            ...(path !== pathWithPseudo && pathWithPseudo.length <= 2000
              ? { pathWithPseudo }
              : {}),
          }
        : {}),
    });
  }
  return result;
}
