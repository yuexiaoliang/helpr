import { z } from 'zod';
import { materialVersionSchema } from './material';
import { pageSourceSchema } from './model';
import { websiteURL } from './url-policy';
import type { WebAction } from './web-action';
import type { PageObservation } from './model';

// 此 schema 也发送给模型，不能包含无法序列化为 JSON Schema 的 transform。
const url = z
  .url()
  .max(4096)
  .refine((value) => {
    try {
      return websiteURL(value) === value;
    } catch {
      return false;
    }
  });
export const attachmentBindingSchema = z.strictObject({
  materialId: z.string().uuid(),
  targetUrl: url,
  url,
});
export const publicationFieldsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      name: z.string().trim().min(1).max(500),
      frameUrl: url.optional(),
      value: z.string().trim().min(1).max(4000),
    }),
  )
  .min(1)
  .max(12);
export const publicationSchema = z
  .strictObject({
    fields: publicationFieldsSchema.optional(),
    articleId: z.string().uuid().optional(),
    destination: z.string().trim().min(1).max(600),
    content: z
      .string()
      .min(1)
      .max(4000)
      .refine((s) => !!s.trim()),
    attachment: attachmentBindingSchema.optional(),
  })
  .refine(
    (p) =>
      !p.fields ||
      (p.fields.map((f) => f.value).join('\n\n') === p.content &&
        new Set(p.fields.map((f) => f.id)).size === p.fields.length &&
        new Set(
          p.fields.map((f) =>
            JSON.stringify([f.name, f.frameUrl ?? p.attachment?.targetUrl]),
          ),
        ).size === p.fields.length &&
        p.fields.every(
          (f) =>
            !f.frameUrl ||
            !p.attachment ||
            new URL(f.frameUrl).origin ===
              new URL(p.attachment.targetUrl).origin,
        )),
    'PUBLICATION_FIELDS_MISMATCH',
  );
export type Publication = z.infer<typeof publicationSchema>;
export const publicationParts = (p: Publication) =>
  p.fields?.map((f) => f.value) ?? [p.content];

export function verifyPublicationFields(
  p: Publication,
  source: PageObservation,
) {
  return p.fields?.map((field) => {
    const matches = source.controls?.filter(
      (c) =>
        c.role === 'textbox' &&
        c.name === field.name &&
        c.frameUrl === (field.frameUrl ?? source.url),
    );
    if (
      source.truncated ||
      matches?.length !== 1 ||
      matches[0]!.disabled ||
      matches[0]!.textValue !== field.value
    )
      throw Error('EXECUTION_EVIDENCE_MISSING');
    return matches[0]!;
  });
}

/** 字段和定位一起确认；相同文字不能因此获得写入另一个字段的权限。 */
export function publicationFillBinding(p: Publication, action: WebAction) {
  if (action.kind !== 'fill' && action.kind !== 'select') return undefined;
  if (action.kind === 'fill' && p.fields) {
    const field = p.fields.find(
      (f) =>
        f.value === action.value &&
        f.name === action.target.name &&
        action.target.role === 'textbox' &&
        action.target.exact &&
        !action.target.within &&
        (f.frameUrl ?? p.attachment?.targetUrl) ===
          (action.target.frameUrl ?? p.attachment?.targetUrl),
    );
    if (field)
      return {
        field: 'value' as const,
        parameter: 'content' as const,
        fieldId: field.id,
      };
    // 已声明的内容字段不能被栏目同值兜底重新授权。
    return undefined;
  }
  if (action.value === p.destination)
    return { field: 'value' as const, parameter: 'destination' as const };
  if (action.kind === 'fill' && action.value === p.content)
    return { field: 'value' as const, parameter: 'content' as const };
  return undefined;
}
// 只保存正常网页中已观察到的精确地址，不接受搜索条件、URL 模板或脚本。
export const publicationRecoverySchema = z.strictObject({
  rule: z.literal('public-attachment-v1'),
  url,
  targetUrl: url,
  attachmentUrl: url,
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
});
export type PublicationRecovery = z.infer<typeof publicationRecoverySchema>;
export const downloadCheckSchema = z.strictObject({
  url,
  sha256: materialVersionSchema.shape.sha256,
  bytes: materialVersionSchema.shape.bytes,
  checkedAt: z.number().int().nonnegative(),
});
export type DownloadCheck = z.infer<typeof downloadCheckSchema>;
export const publicationResultProposalSchema = z.strictObject({
  url,
  targetUrl: url,
  attachmentUrl: url,
  publishedEvidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
});
export type PublicationResultProposal = z.infer<
  typeof publicationResultProposalSchema
>;
export const publicationCheckSchema = z.strictObject({
  id: z.string().uuid(),
  actionId: z.string(),
  approvalId: z.string().uuid(),
  materialId: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  status: z.enum(['verified', 'unknown']),
  proposal: publicationResultProposalSchema,
  source: pageSourceSchema,
  checkedAt: z.number().int().nonnegative(),
  download: downloadCheckSchema.optional(),
  pageSha256: materialVersionSchema.shape.sha256.optional(),
  checks: z.strictObject({
    target: z.boolean(),
    published: z.boolean(),
    content: z.boolean(),
    destination: z.boolean(),
    attachment: z.boolean(),
    bytes: z.boolean(),
  }),
  failure: z.enum([
    'none',
    'evidence',
    'network',
    'content',
    'bytes',
    'material',
  ]),
  coverage: z.literal('public-page-and-attachment'),
  // 只报告实际覆盖；独立 GET 不能证明网站没有其它写入。
  extraResults: z.array(url).max(50),
  anomalies: z.array(z.string().min(1).max(2000)).max(20),
  unobservedWrites: z.literal('unknown'),
  screenshot: z.literal('not-required'),
  recovery: z.literal('public-attachment-v1').optional(),
  localMaterial: z.enum(['verified', 'unavailable']).optional(),
});
export type PublicationCheck = z.infer<typeof publicationCheckSchema>;

export function samePublication(a: Publication, b: Publication) {
  return (
    a.articleId === b.articleId &&
    a.content === b.content &&
    JSON.stringify(a.fields) === JSON.stringify(b.fields) &&
    a.destination === b.destination &&
    JSON.stringify(a.attachment) === JSON.stringify(b.attachment)
  );
}
