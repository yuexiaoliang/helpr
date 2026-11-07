import { richTextObservation } from './rich-text-observation';
import { emptyTextObservation } from './empty-text-observation';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isInlineFrameURL, websiteURL } from '../shared/url-policy';
import type { PageObservation } from '../shared/model';

const axValue = z.object({ value: z.unknown().optional() });
const treeSchema = z.object({
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      backendDOMNodeId: z.number().int().positive().optional(),
      ignored: z.boolean().optional(),
      childIds: z.array(z.string()).optional(),
      role: axValue.optional(),
      name: axValue.optional(),
      value: axValue.optional(),
      properties: z
        .array(z.object({ name: z.string(), value: axValue }))
        .optional(),
    }),
  ),
});
/** 只使用所属页面的受控观察。排除受保护输入及其子节点，不运行网站脚本。 */
export function pageObservation(
  frame: unknown,
  accessibility: unknown,
  generation: number,
  supplements = '',
  document?: unknown,
  richDocument: unknown = document,
): PageObservation {
  const rawUrl = z
    .object({ frameTree: z.object({ frame: z.object({ url: z.string() }) }) })
    .parse(frame).frameTree.frame.url;
  // 内联子文档只接收控制拥有者已核对的独立富文本快照。
  // 不使about地址成为网站入口，不补原生字段、链接或其它动作定位。
  const inline =
    document === undefined &&
    richDocument !== undefined &&
    isInlineFrameURL(rawUrl);
  const url = inline ? rawUrl : websiteURL(rawUrl);
  const { nodes } = treeSchema.parse(accessibility);
  const empty = emptyTextObservation(document, url);
  const rich = richTextObservation(richDocument, url);
  const backendCounts = new Map<number, number>();
  for (const n of nodes)
    if (n.backendDOMNodeId)
      backendCounts.set(
        n.backendDOMNodeId,
        (backendCounts.get(n.backendDOMNodeId) ?? 0) + 1,
      );
  const excluded = new Set(
    nodes
      .filter((node) =>
        node.properties?.some(
          (p) => p.name === 'protected' && p.value.value === true,
        ),
      )
      .map((node) => node.nodeId),
  );
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const excludeChildren = (id: string) => {
    for (const child of byId.get(id)?.childIds ?? [])
      if (!excluded.has(child)) {
        excluded.add(child);
        excludeChildren(child);
      }
  };
  [...excluded].forEach(excludeChildren);
  const rootName = nodes.find((node) => node.role?.value === 'RootWebArea')
    ?.name?.value;
  const title = typeof rootName === 'string' ? rootName.slice(0, 1000) : '';
  const lines: string[] = [];
  const links: NonNullable<PageObservation['links']> = [];
  const controls: NonNullable<PageObservation['controls']> = [];
  for (const node of nodes) {
    if (node.ignored || excluded.has(node.nodeId)) continue;
    const name = typeof node.name?.value === 'string' ? node.name.value : '';
    const value = typeof node.value?.value === 'string' ? node.value.value : '';
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    const emptyNode =
      node.backendDOMNodeId && backendCounts.get(node.backendDOMNodeId) === 1
        ? empty.get(node.backendDOMNodeId)
        : undefined;
    const richNode =
      node.backendDOMNodeId && backendCounts.get(node.backendDOMNodeId) === 1
        ? rich.get(node.backendDOMNodeId)
        : undefined;
    const isRich =
      role === 'textbox' &&
      (richNode ||
        node.properties?.some(
          (p) => p.name === 'editable' && p.value.value === 'richtext',
        ));
    const richValue = richNode?.supported
      ? typeof node.value?.value === 'string' &&
        value.length <= 4000 &&
        value.replaceAll('\n', '') === richNode.text.replaceAll('\n', '')
        ? value
        : node.value === undefined && richNode.empty
          ? ''
          : undefined
      : undefined;
    if (
      [
        'button',
        'link',
        'checkbox',
        'textbox',
        'combobox',
        'radio',
        'option',
        'menuitem',
        'row',
        'tab',
        'switch',
      ].includes(role) &&
      (!inline || isRich)
    )
      controls.push({
        role,
        name: name.slice(0, 1000),
        frameUrl: url,
        disabled: !!node.properties?.some(
          (p) => p.name === 'disabled' && p.value.value === true,
        ),
        ...(role === 'textbox'
          ? {
              readOnly:
                node.properties?.some(
                  (p) => p.name === 'readonly' && p.value.value === true,
                ) ?? false,
            }
          : {}),
        ...(isRich
          ? richValue !== undefined
            ? {
                richText: {
                  rule: 'contenteditable-ax-v1' as const,
                  backendNodeId: node.backendDOMNodeId!,
                  valueSource:
                    typeof node.value?.value === 'string'
                      ? ('ax' as const)
                      : ('empty-dom' as const),
                },
                textValue: richValue,
              }
            : { richTextUnavailable: true as const }
          : {}),
        ...(role === 'combobox' &&
        typeof node.value?.value === 'string' &&
        value.length <= 500
          ? { selectedLabel: value }
          : {}),
        ...(!isRich &&
        role === 'textbox' &&
        typeof node.value?.value === 'string' &&
        value.length <= 4000
          ? { textValue: value }
          : !isRich &&
              role === 'textbox' &&
              node.value === undefined &&
              emptyNode
            ? {
                textValue: '',
                emptyValue: {
                  rule: 'native-empty-snapshot-v1' as const,
                  backendNodeId: node.backendDOMNodeId!,
                  nodeName: emptyNode,
                },
              }
            : {}),
      });
    if (isRich)
      lines.push(
        '[rich-text] ' +
          JSON.stringify({
            id: node.backendDOMNodeId,
            name,
            value: richValue,
            valueSource:
              typeof node.value?.value === 'string' ? 'ax' : 'empty-dom',
            unavailable: richValue === undefined,
          }),
      );
    if (role === 'textbox' && node.value === undefined && emptyNode)
      lines.push(
        '[native-empty] ' +
          JSON.stringify({
            id: node.backendDOMNodeId,
            name,
            nodeName: emptyNode,
          }),
      );
    const flags = (node.properties ?? [])
      .filter((p) =>
        ['checked', 'selected', 'expanded', 'disabled', 'readonly'].includes(
          p.name,
        ),
      )
      .map((p) => `${p.name}=${String(p.value.value)}`);
    const content = [name, value].filter(Boolean).join('：').trim();
    const line = content
      ? `[${role}] ${content}${flags.length ? ' (' + flags.join(', ') + ')' : ''}`
      : '';
    if (line && line !== lines.at(-1)) lines.push(line);
    const link = node.properties?.find((p) => p.name === 'url')?.value.value;
    if (!inline && role === 'link' && name && typeof link === 'string') {
      try {
        const href = websiteURL(link);
        links.push({ name: name.slice(0, 1000), url: href });
        lines.push(
          '[observed-link] ' +
            JSON.stringify({ name: name.slice(0, 1000), url: href }),
        );
      } catch {
        /* 无效链接不能成为复用依据。 */
      }
    }
  }
  const full = lines.join('\n') + (supplements ? '\n' + supplements : ''),
    text = full.slice(0, 30000);
  return {
    url,
    title,
    text,
    links: links.slice(0, 300),
    controls: controls.slice(0, 500),
    generation,
    observedAt: Date.now(),
    truncated:
      full.length !== text.length ||
      links.length > 300 ||
      controls.length > 500,
    fingerprint: createHash('sha256')
      .update(url + '\n' + full)
      .digest('hex'),
  };
}
