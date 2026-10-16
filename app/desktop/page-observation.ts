import { z } from 'zod';
import { createHash } from 'node:crypto';
import { websiteURL } from '../shared/url-policy';
import type { PageObservation } from '../shared/model';

const axValue = z.object({ value: z.unknown().optional() });
const treeSchema = z.object({
  nodes: z.array(
    z.object({
      nodeId: z.string(),
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
): PageObservation {
  const url = websiteURL(
    z
      .object({ frameTree: z.object({ frame: z.object({ url: z.string() }) }) })
      .parse(frame).frameTree.frame.url,
  );
  const { nodes } = treeSchema.parse(accessibility);
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
  for (const node of nodes) {
    if (node.ignored || excluded.has(node.nodeId)) continue;
    const name = typeof node.name?.value === 'string' ? node.name.value : '';
    const value = typeof node.value?.value === 'string' ? node.value.value : '';
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    const flags = (node.properties ?? [])
      .filter((p) =>
        ['checked', 'selected', 'expanded', 'disabled'].includes(p.name),
      )
      .map((p) => `${p.name}=${String(p.value.value)}`);
    const content = [name, value].filter(Boolean).join('：').trim();
    const line = content
      ? `[${role}] ${content}${flags.length ? ' (' + flags.join(', ') + ')' : ''}`
      : '';
    if (line && line !== lines.at(-1)) lines.push(line);
  }
  const full = lines.join('\n'),
    text = full.slice(0, 16000);
  return {
    url,
    title,
    text,
    generation,
    observedAt: Date.now(),
    truncated: full.length !== text.length,
    fingerprint: createHash('sha256')
      .update(url + '\n' + full)
      .digest('hex'),
  };
}
