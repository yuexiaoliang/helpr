import { z } from 'zod';
import { materialVersionSchema } from './material';
import { pageSourceSchema } from './model';
import { websiteURL } from './url-policy';

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
export const publicationSchema = z.strictObject({
  destination: z.string().trim().min(1).max(600),
  content: z
    .string()
    .min(1)
    .max(4000)
    .refine((s) => !!s.trim()),
  attachment: attachmentBindingSchema.optional(),
});
export type Publication = z.infer<typeof publicationSchema>;
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
    a.content === b.content &&
    a.destination === b.destination &&
    JSON.stringify(a.attachment) === JSON.stringify(b.attachment)
  );
}
