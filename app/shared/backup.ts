import { z } from 'zod';

export const backupArchiveSchema = z.strictObject({
  id: z.string().min(1).max(100),
  created: z.number().int().nonnegative(),
  file: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.number().int().nonnegative(),
});
export type BackupArchive = z.infer<typeof backupArchiveSchema>;
export const backupStatusSchema = z.strictObject({
  location: z.string(),
  selection: z
    .strictObject({ token: z.string().uuid(), archive: backupArchiveSchema })
    .nullable(),
  phase: z.enum([
    'idle',
    'working',
    'complete',
    'restored',
    'uncertain',
    'error',
  ]),
  operation: z.enum(['create', 'restore']).nullable(),
  requestId: z.string().nullable(),
  message: z.string(),
  archive: backupArchiveSchema.optional(),
  safety: backupArchiveSchema.optional(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;
export const backupUICommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('backup-status') }),
  z.strictObject({ kind: z.literal('backup-location') }),
  z.strictObject({ kind: z.literal('backup-open') }),
  z.strictObject({
    kind: z.literal('backup-create'),
    requestId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal('backup-restore'),
    requestId: z.string().uuid(),
    selection: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal('backup-review'),
    taskId: z.string().min(1),
  }),
]);
