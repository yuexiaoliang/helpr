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
const filledCreationSchema = z.strictObject({
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
// 空白字段自身不是身份。只接受页面已提供的唯一只读文本框标识，
// 保留旧规则的非空限制，模型不能通过空数组获得创建许可。
const blankCreationSchema = z.strictObject({
  rule: z.literal('readonly-identity-editor-v1'),
  identity: z.strictObject({
    name: z.string().trim().min(1).max(500),
    value: z
      .string()
      .min(1)
      .max(2000)
      .refine((v) => v.trim().length > 0),
  }),
  fields: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(500),
        value: z.literal(''),
      }),
    )
    .min(1)
    .max(12),
  destination: z.string().trim().min(1).max(600),
});
export const targetCreationSchema = z.discriminatedUnion('rule', [
  filledCreationSchema,
  blankCreationSchema,
]);
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
  if (creation.rule === 'readonly-identity-editor-v1') {
    const controls = source.controls ?? [];
    const identity = controls.filter((c) => c.name === creation.identity.name);
    if (
      identity.length !== 1 ||
      identity[0]!.role !== 'textbox' ||
      identity[0]!.frameUrl !== source.url ||
      identity[0]!.disabled ||
      identity[0]!.readOnly !== true ||
      identity[0]!.textValue !== creation.identity.value ||
      creation.fields.some((f) => f.name === creation.identity.name)
    )
      return false;
    const editable = controls.filter(
      (c) =>
        c.role === 'textbox' &&
        c.frameUrl === source.url &&
        c.readOnly !== true,
    );
    if (
      editable.length !== creation.fields.length ||
      editable.some(
        (c) =>
          c.readOnly !== false ||
          !creation.fields.some((f) => f.name === c.name),
      )
    )
      return false;
  }
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
