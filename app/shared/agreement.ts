import { z } from 'zod';
import { materialSelectionSchema } from './material';

export const agreementTermsSchema = z.strictObject({
  selection: materialSelectionSchema.omit({ basis: true }),
  entryUrl: z.url().max(4096),
  destination: z.string().trim().min(1).max(600),
  contentRules: z.string().trim().min(1).max(2000),
  changedBytes: z.enum(['new-publication', 'ask']),
  period: z.enum(['once-per-material', 'per-period']),
});
export type AgreementTerms = z.infer<typeof agreementTermsSchema>;
export const agreementVersionSchema = z.strictObject({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  terms: agreementTermsSchema,
  requestId: z.string().min(1).max(100),
  request: z.string().min(1).max(4000),
  createdAt: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  revocation: z.string().nullable(),
});
export type AgreementVersion = z.infer<typeof agreementVersionSchema>;
export const agreementBindingSchema = z.strictObject({
  ownerTaskId: z.string(),
  agreementId: z.string().uuid(),
  versionId: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  periodKey: z.string().trim().max(100),
  repeatIntent: z.string().max(100),
  repeatOf: z.string().uuid().nullable(),
});
export const materialWorkSchema = z.strictObject({
  id: z.string().uuid(),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  binding: agreementBindingSchema,
  materialId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requiresReview: z.boolean(),
  status: z.enum(['pending', 'unknown', 'complete']),
  actionId: z.string().nullable(),
  resultId: z.string().uuid().nullable(),
});
export type MaterialWork = z.infer<typeof materialWorkSchema>;
const command = {
  taskId: z.string(),
  requestId: z.string().min(1).max(100),
};
export const agreementUICommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...command,
    kind: z.literal('agreement-prepare'),
    expectedVersion: z.number().int().positive(),
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    ...command,
    kind: z.literal('agreement-accept'),
    versionId: z.string().uuid(),
  }),
  z.strictObject({
    ...command,
    kind: z.literal('agreement-revoke'),
    versionId: z.string().uuid(),
  }),
  z.strictObject({
    ...command,
    kind: z.literal('agreement-use'),
    versionId: z.string().uuid(),
    periodKey: z.string().trim().max(100).default(''),
    repeatOf: z.string().uuid().nullable().default(null),
  }),
]);
export type AgreementUICommand = z.infer<typeof agreementUICommandSchema>;
export function agreementSummary(t: AgreementTerms) {
  const rule = {
    exact: '指定文件',
    only: '唯一符合的文件',
    latest: '最新文件',
    'latest-unprocessed': '最新且未完成的文件',
    'all-unprocessed': '所有未完成的文件',
    date: `按预定日期取文件（${t.selection.dateName ?? '待明确日期文件名'}，{date} 为 YYYY-MM-DD）`,
  };
  return `从“${t.selection.scope}”取${rule[t.selection.rule]}${t.selection.name ? `“${t.selection.name}”` : ''}${t.selection.extension ? `（${t.selection.extension}）` : ''}，读取 Excel 并按“${t.contentRules}”生成文章，附上原始文件，发布到 ${t.entryUrl} 的“${t.destination}”。${t.changedBytes === 'new-publication' ? '新的素材内容另发一篇。' : '素材字节变化后先确认再发布。'}${t.period === 'per-period' ? '每个明确期次分别处理。' : '同一内容只处理一次。'}符合约定时自动发布；结果不明先核对，明确要求再发才另建工作。`;
}
export function agreementGoal(t: AgreementTerms, periodKey = '') {
  return `${agreementSummary(t)}${periodKey ? `本次期次：${periodKey}。` : ''}`;
}
