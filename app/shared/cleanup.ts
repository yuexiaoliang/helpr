import { z } from 'zod';

const taskIds = z.array(z.string().min(1)).min(1).max(100);
export const cleanupCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cleanup-preview'), taskIds }),
  z.strictObject({
    kind: z.literal('cleanup-commit'),
    taskIds,
    requestId: z.string().uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export const cleanupPreviewSchema = z.strictObject({
  token: z.string(),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      reason: z.string(),
      eligible: z.boolean(),
    }),
  ),
  files: z.array(z.strictObject({ sha256: z.string(), bytes: z.number() })),
  bytes: z.number(),
});
export type CleanupPreview = z.infer<typeof cleanupPreviewSchema>;
export const cleanupReceiptSchema = z.strictObject({
  requestId: z.string(),
  phase: z.enum(['complete', 'pending']),
  removedBytes: z.number(),
  pendingFiles: z.number(),
});
export type CleanupReceipt = z.infer<typeof cleanupReceiptSchema>;
