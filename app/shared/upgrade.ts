import { z } from 'zod';
import { backupArchiveSchema } from './backup';
import { versionNumber } from './version';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const upgradeSiteSchema = z.strictObject({
  taskId: z.string().min(1).max(100),
  generation: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  dirty: z.boolean(),
});
export const upgradeProofSchema = z.strictObject({
  nativeReady: z.boolean(),
  credential: digest.nullable(),
  profile: digest,
  cookies: z
    .array(
      z.strictObject({
        id: digest,
        value: digest,
        expires: z.number().nullable(),
      }),
    )
    .max(10000),
  pages: z.array(upgradeSiteSchema),
});
export type UpgradeProof = z.infer<typeof upgradeProofSchema>;
export type UpgradeSite = z.infer<typeof upgradeSiteSchema>;
export const upgradePhaseSchema = z.enum([
  'idle',
  'preparing',
  'ready',
  'checking',
  'blocked',
  'complete',
]);
export const upgradeLedgerSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  phase: upgradePhaseSchema,
  installedVersion: versionNumber.nullable(),
  fromVersion: versionNumber.nullable(),
  target: versionNumber.nullable(),
  requestId: z.string().nullable(),
  fingerprint: digest.nullable(),
  backup: backupArchiveSchema.nullable(),
  proof: upgradeProofSchema.nullable(),
  error: z.string(),
  reopening: z.boolean(),
  continuity: z.enum(['unchecked', 'retained', 'renewed', 'unrecorded']),
});
export type UpgradeLedger = z.infer<typeof upgradeLedgerSchema>;
export const upgradeStatusSchema = upgradeLedgerSchema
  .omit({ proof: true })
  .extend({
    dirtyTasks: z.array(z.string()),
    message: z.string(),
    working: z.boolean(),
    recordRevision: z.number().int().nonnegative(),
    pages: z.array(upgradeSiteSchema),
  });
export type UpgradeStatus = z.infer<typeof upgradeStatusSchema>;
export const upgradeUICommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upgrade-status') }),
  z.strictObject({
    kind: z.literal('upgrade-prepare'),
    requestId: z.string().uuid(),
    versionRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('upgrade-cancel') }),
  z.strictObject({ kind: z.literal('upgrade-check') }),
  z.strictObject({
    kind: z.literal('upgrade-page-saved'),
    taskId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('upgrade-exit'),
    revision: z.number().int().nonnegative(),
  }),
]);
