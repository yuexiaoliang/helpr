import { z } from 'zod';
import { observedLinkSchema, pageSourceSchema } from './model';

/** 由网页宿主给出的实际 Session 身份和 Cookie 变化代次；不含凭据。 */
export const sessionContextSchema = z.strictObject({
  id: z.string().min(1).max(200),
  epoch: z
    .string()
    .regex(/^[0-9a-f-]{36}:\d+$/)
    .max(200),
  origin: z.url().max(4096),
});
export type SessionContext = z.infer<typeof sessionContextSchema>;
/** 网站身份与权限由本次观察提出，链接必须来自结构化观察。 */
export const coordinationProposalSchema = z.strictObject({
  account: observedLinkSchema,
  target: observedLinkSchema,
  permissionEvidence: z.array(z.string().min(1).max(2000)).min(1).max(5),
});
export type CoordinationProposal = z.infer<typeof coordinationProposalSchema>;
export const coordinationSchema = z.strictObject({
  session: sessionContextSchema,
  status: z.enum(['unverified', 'ready', 'login', 'account-changed']),
  account: observedLinkSchema.optional(),
  target: observedLinkSchema.optional(),
  permissionEvidence:
    coordinationProposalSchema.shape.permissionEvidence.optional(),
  source: pageSourceSchema.optional(),
  loginId: z.string().uuid().optional(),
  loginOwner: z.string().optional(),
  checkingLogin: z.boolean().optional(),
  waitFor: z.string().optional(),
  changedBy: z.string().optional(),
  decisionQuestionId: z.string().uuid().optional(),
  refreshRequired: z.boolean().optional(),
});
export const resourceClaimSchema = z.strictObject({
  status: z.enum(['held', 'released']),
  id: z.string().uuid(),
  runId: z.string(),
  goalVersion: z.number().int().positive(),
  origin: z.url(),
  targetUrl: z.url().nullable(),
});
export function sameSession(a: SessionContext, b: SessionContext) {
  return a.id === b.id && a.origin === b.origin;
}
export function sameAccount(
  a: z.infer<typeof observedLinkSchema> | undefined,
  b: z.infer<typeof observedLinkSchema> | undefined,
) {
  return a?.url === b?.url && a?.name === b?.name;
}
