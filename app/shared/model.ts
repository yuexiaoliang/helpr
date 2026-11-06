import { z } from 'zod';
import { websiteURL } from './url-policy';

export const modelErrorSchema = z.enum([
  'MODEL_NOT_CONFIGURED',
  'MODEL_AUTHENTICATION',
  'MODEL_CONNECTION',
  'MODEL_TIMEOUT',
  'MODEL_FORMAT',
  'MODEL_CAPABILITY',
  'MODEL_CREDENTIAL_UNAVAILABLE',
  'MODEL_LIMIT',
  'MODEL_BUSY',
  'MODEL_CANCELLED',
  'MODEL_INTERRUPTED',
  'MODEL_PAGE_UNAVAILABLE',
  'MODEL_RECORDS_UNAVAILABLE',
  'MODEL_RESPONSE_REDACTED',
]);
export type ModelErrorCode = z.infer<typeof modelErrorSchema>;
export const modelConfigurationSchema = z.strictObject({
  protocol: z.literal('chat-completions'),
  endpoint: z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        const url = new URL(websiteURL(value));
        return (
          !url.search &&
          !url.hash &&
          (url.protocol === 'https:' ||
            ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        );
      } catch {
        return false;
      }
    }, 'INVALID_MODEL_ENDPOINT')
    .transform((value) => websiteURL(value).replace(/\/$/, '')),
  model: z.string().trim().min(1).max(200),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export const modelSettingsSchema = modelConfigurationSchema.extend({
  version: z.number().int().positive(),
  hasCredential: z.boolean(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export const pageSourceSchema = z.strictObject({
  url: z.string().max(4096),
  title: z.string().max(1000),
  fingerprint: z.string().max(100),
  generation: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type PageSource = z.infer<typeof pageSourceSchema>;
export const observedLinkSchema = z.strictObject({
  name: z.string().min(1).max(1000),
  url: z.url().max(4096),
});
export const observedControlSchema = z.strictObject({
  role: z.string().max(100),
  name: z.string().max(1000),
  frameUrl: z.url(),
  disabled: z.boolean(),
});
export type PageObservation = PageSource & {
  text: string;
  links?: z.infer<typeof observedLinkSchema>[];
  controls?: z.infer<typeof observedControlSchema>[];
};
export const modelUsageKindSchema = z.enum([
  'legacy-unspecified',
  'page-question',
  'intent-and-inputs',
  'web-planning',
  'workflow-repair',
  'material-content',
]);
export const modelCallSchema = z.strictObject({
  usageKind: modelUsageKindSchema.optional(),
  id: z.string(),
  taskId: z.string(),
  model: z.string(),
  configurationVersion: z.number().int(),
  phase: z.enum([
    'preparing',
    'sending',
    'streaming',
    'complete',
    'cancelled',
    'error',
    'interrupted',
  ]),
  source: pageSourceSchema.nullable(),
  pageChanged: z.boolean(),
  dispatched: z.boolean(),
  reservedTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  error: modelErrorSchema.nullable(),
});
export type ModelCall = z.infer<typeof modelCallSchema>;
export const archivedModelCallSchema = z.strictObject({
  call: modelCallSchema,
  output: z.string(),
  hash: z.string(),
});
export const modelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export const modelSaveSchema = modelConfigurationSchema.extend({
  kind: z.literal('model-save'),
  requestId: z.string().min(1).max(100),
  expectedVersion: z.number().int().nonnegative(),
  apiKey: z.string().min(1).max(4096).optional(),
});
export const modelTestSchema = modelSaveSchema
  .omit({ requestId: true, kind: true })
  .extend({ kind: z.literal('model-test') });
export const modelUICommandSchema = z.union([
  modelSaveSchema,
  modelTestSchema,
  z.strictObject({
    kind: z.literal('model-cancel'),
    taskId: z.string(),
    callId: z.string(),
  }),
]);
export const MODEL_LIMITS = {
  concurrent: 2,
  callsPerTask: 20,
  tokensPerTask: 200000,
  outputTokens: 2048,
  timeoutMs: 60000,
} as const;
export const activeModelCall = (call: ModelCall): boolean =>
  ['preparing', 'sending', 'streaming'].includes(call.phase);
