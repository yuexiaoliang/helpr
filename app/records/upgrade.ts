import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createMachine, transition } from 'xstate';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { WorkspaceSnapshot } from '../shared/contracts';
import {
  upgradeLedgerSchema,
  upgradePhaseSchema,
  upgradeProofSchema,
  type UpgradeLedger,
} from '../shared/upgrade';
import { backupArchiveSchema } from '../shared/backup';
import { versionNumber } from '../shared/version';
import * as schema from './schema';

const commands = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('boot'), version: versionNumber }),
  z.strictObject({
    kind: z.literal('prepare'),
    requestId: z.string().min(1),
    target: versionNumber,
  }),
  z.strictObject({
    kind: z.literal('ready'),
    requestId: z.string(),
    fingerprint: z.string(),
    backup: backupArchiveSchema,
    proof: upgradeProofSchema,
  }),
  z.strictObject({ kind: z.literal('review') }),
  z.strictObject({
    kind: z.literal('block'),
    error: z.string().regex(/^[A-Z][A-Z_]+$/),
  }),
  z.strictObject({
    kind: z.literal('finish'),
    revision: z.number().int(),
    fingerprint: z.string(),
    continuity: z.enum(['retained', 'renewed', 'unrecorded']),
  }),
]);
const lifecycle = createMachine({
  id: 'manual-upgrade',
  initial: 'idle',
  states: {
    idle: {},
    preparing: {},
    ready: {},
    checking: {},
    blocked: {},
    complete: {},
  },
  on: {
    PREPARE: '.preparing',
    READY: '.ready',
    REVIEW: '.checking',
    BLOCK: '.blocked',
    FINISH: '.complete',
  },
});

/** 只由记录拥有者保存。业务备份不导出升级凭据或会话摘要。 */
export class UpgradeRecords {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly snapshot: () => WorkspaceSnapshot,
  ) {}
  get(): UpgradeLedger {
    const row = this.db
      .select()
      .from(schema.installation)
      .where(eq(schema.installation.id, 1))
      .get();
    return row
      ? upgradeLedgerSchema.parse(row.body)
      : {
          revision: 0,
          phase: 'idle',
          installedVersion: null,
          fromVersion: null,
          target: null,
          requestId: null,
          fingerprint: null,
          backup: null,
          proof: null,
          error: '',
          reopening: false,
          continuity: 'unchecked',
        };
  }
  held() {
    return !['idle', 'complete'].includes(this.get().phase);
  }
  fingerprint() {
    const s = this.snapshot();
    return createHash('sha256')
      .update(
        JSON.stringify({
          settings: s.modelSettings?.version ?? null,
          tasks: s.tasks.map((t) => ({
            id: t.id,
            goal: t.goal,
            url: t.url,
            draft: t.draft,
            messages: t.messages,
            execution: t.execution,
          })),
        }),
      )
      .digest('hex');
  }
  execute(input: unknown): UpgradeLedger {
    const c = commands.parse(input);
    if (c.kind === 'status') return this.get();
    return this.db.transaction(
      () => {
        const s = this.get();
        const move = (event: string) => {
          const prior = lifecycle.resolveState({ value: s.phase, context: {} });
          const [next] = transition(lifecycle, prior, { type: event });
          s.phase = upgradePhaseSchema.parse(next.value);
        };
        if (c.kind === 'boot') {
          if (
            s.installedVersion === c.version &&
            ['idle', 'complete'].includes(s.phase)
          )
            return s;
          const first =
            s.installedVersion === null && this.snapshot().tasks.length === 0;
          if (!s.requestId) s.fromVersion = s.installedVersion;
          s.installedVersion = c.version;
          if (!first) {
            s.reopening = true;
            move('REVIEW');
          }
        } else if (c.kind === 'prepare') {
          if (s.requestId === c.requestId) {
            if (s.target !== c.target) throw Error('REQUEST_CONTENT_CONFLICT');
            return s;
          }
          if (
            !['idle', 'complete', 'blocked'].includes(s.phase) ||
            (s.phase === 'blocked' && s.reopening)
          )
            throw Error('UPGRADE_PENDING');
          if (c.target === s.installedVersion)
            throw Error('UPGRADE_VERSION_MISMATCH');
          s.reopening = false;
          s.requestId = c.requestId;
          s.target = c.target;
          s.fromVersion = s.installedVersion;
          s.proof = null;
          s.backup = null;
          s.fingerprint = null;
          s.error = '';
          move('PREPARE');
        } else if (c.kind === 'ready') {
          if (
            s.requestId !== c.requestId ||
            !['preparing', 'blocked'].includes(s.phase)
          )
            throw Error('UPGRADE_PENDING');
          if (c.fingerprint !== this.fingerprint())
            throw Error('UPGRADE_CHANGED');
          if (c.proof.pages.some((p) => p.dirty))
            throw Error('UPGRADE_PAGE_UNSAVED');
          s.proof = c.proof;
          s.backup = c.backup;
          s.fingerprint = c.fingerprint;
          s.error = '';
          move('READY');
        } else if (c.kind === 'review') {
          s.reopening = true;
          move('REVIEW');
          s.error = '';
        } else if (c.kind === 'block') {
          move('BLOCK');
          s.error = c.error;
        } else {
          if (
            s.phase !== 'checking' ||
            c.revision !== s.revision ||
            c.fingerprint !== this.fingerprint()
          )
            throw Error('UPGRADE_CHANGED');
          s.error = '';
          s.continuity = c.continuity;
          move('FINISH');
        }
        s.revision++;
        this.db
          .insert(schema.installation)
          .values({ id: 1, body: s })
          .onConflictDoUpdate({
            target: schema.installation.id,
            set: { body: s },
          })
          .run();
        return s;
      },
      { behavior: 'immediate' },
    );
  }
}
