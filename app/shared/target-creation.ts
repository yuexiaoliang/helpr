import { z } from 'zod';
import {
  pageSourceSchema,
  observedLinkSchema,
  observedControlSchema,
  type PageObservation,
} from './model';
import { websiteURL } from './url-policy';
import { actionNavigationSchema } from './action-navigation';

// 创建前冻结已经填写的主文档字段；不包含结果地址或网站专用规则。
export const targetCreationSchema = z.strictObject({
  rule: z.literal('same-site-editor-v1'),
  fields: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(500),
        value: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(12),
  destination: z.string().trim().min(1).max(600),
});
export const discoveredTargetSchema = z.strictObject({
  source: pageSourceSchema,
  binding: z.strictObject({
    targetId: z.string().min(1),
    generation: z.number().int().nonnegative(),
  }),
  links: z.array(observedLinkSchema).max(300),
  controls: z.array(observedControlSchema).max(300),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
  targetFactId: z.string().uuid(),
  draftFactId: z.string().uuid(),
});
export function creationFieldsMatch(
  creation: z.infer<typeof targetCreationSchema>,
  source: PageObservation,
) {
  return (
    !source.truncated &&
    new Set(creation.fields.map((f) => f.name)).size ===
      creation.fields.length &&
    source.text.includes(creation.destination) &&
    creation.fields.every((f) => {
      const matches = source.controls?.filter(
        (c) =>
          c.role === 'textbox' &&
          c.name === f.name &&
          c.frameUrl === source.url,
      );
      return (
        matches?.length === 1 &&
        !matches[0]!.disabled &&
        matches[0]!.textValue === f.value
      );
    })
  );
}
export function validDiscoveredTarget(a: {
  discoveredTarget?: z.infer<typeof discoveredTargetSchema>;
  targetCreation?: z.infer<typeof targetCreationSchema>;
  navigation?: z.infer<typeof actionNavigationSchema>;
  effect?: string;
  action: { kind: string };
  submission?: unknown;
  publicationApprovalId?: string;
  workflowStep?: unknown;
  dispatchState?: string;
  status: string;
  binding: { targetId: string };
  source: z.infer<typeof pageSourceSchema>;
  observedUrls?: string[];
  observedLinks?: z.infer<typeof observedLinkSchema>[];
  resultSource?: z.infer<typeof pageSourceSchema>;
}): boolean {
  const d = a.discoveredTarget,
    n = a.navigation,
    c = a.targetCreation;
  if (!d) return true;
  try {
    return (
      !!c &&
      !!n &&
      a.effect === 'draft' &&
      a.action.kind === 'click' &&
      !a.submission &&
      !a.publicationApprovalId &&
      !a.workflowStep &&
      a.dispatchState === 'possible' &&
      a.status === 'confirmed' &&
      n.mainFrame &&
      !n.sameDocument &&
      d.binding.targetId === a.binding.targetId &&
      d.binding.generation === d.source.generation &&
      d.source.generation >= n.generation &&
      d.source.observedAt >= n.observedAt &&
      websiteURL(d.source.url) === d.source.url &&
      !new URL(d.source.url).hash &&
      d.source.url !== a.source.url &&
      new URL(d.source.url).origin === new URL(a.source.url).origin &&
      !a.observedUrls?.includes(d.source.url) &&
      !a.observedLinks?.some((l) => l.url === d.source.url) &&
      d.links.filter((l) => l.url === a.source.url).length === 1 &&
      d.links.filter((l) => l.url === d.source.url).length === 1 &&
      creationFieldsMatch(c, {
        ...d.source,
        text: d.evidence.join('\n'),
        controls: d.controls,
      }) &&
      JSON.stringify(a.resultSource) === JSON.stringify(d.source)
    );
  } catch {
    return false;
  }
}
