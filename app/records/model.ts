import { z } from 'zod';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import { createMachine, transition } from 'xstate';
import {
  modelCallSchema,
  modelConfigurationSchema,
  modelErrorSchema,
  modelUsageSchema,
  pageSourceSchema,
  MODEL_LIMITS,
} from '../shared/model';
import * as schema from './schema';

const active = ['preparing', 'sending', 'streaming'];
const key = z.string().min(1).max(100);
const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('private-settings') }),
  modelConfigurationSchema.extend({
    kind: z.literal('configuration'),
    requestId: key,
    hash: z.string(),
    expectedVersion: z.number().int().nonnegative(),
    ciphertext: z.string().min(1).max(65536).optional(),
  }),
  z.strictObject({
    kind: z.literal('begin'),
    purpose: z.literal('execution').optional(),
    id: key,
    taskId: key,
    text: z.string().trim().min(1).max(20000),
    expectedVersion: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('dispatch'),
    id: key,
    source: pageSourceSchema,
    reservedTokens: z.number().int().min(1).max(MODEL_LIMITS.tokensPerTask),
  }),
  z.strictObject({
    kind: z.literal('progress'),
    id: key,
    output: z.string().max(100000),
  }),
  z.strictObject({
    kind: z.literal('finish'),
    id: key,
    phase: z.enum(['complete', 'cancelled', 'error']),
    error: modelErrorSchema.nullable(),
    usage: modelUsageSchema.nullable(),
    pageChanged: z.boolean().default(false),
  }),
]);
const lifecycle = createMachine({
  id: 'model-call',
  initial: 'preparing',
  states: {
    preparing: {
      on: { DISPATCH: 'sending', CANCEL: 'cancelled', FAIL: 'error' },
    },
    sending: {
      on: {
        PROGRESS: 'streaming',
        COMPLETE: 'complete',
        CANCEL: 'cancelled',
        FAIL: 'error',
      },
    },
    streaming: {
      on: {
        PROGRESS: 'streaming',
        COMPLETE: 'complete',
        CANCEL: 'cancelled',
        FAIL: 'error',
      },
    },
    complete: {},
    cancelled: {},
    error: {},
    interrupted: {},
  },
});
/** 仅由唯一记录拥有者持有，所有请求预留、进度与配置修改均在短事务内。 */
export class ModelRecords {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {
    db.transaction(
      () => {
        const interrupted = db
          .update(schema.modelCalls)
          .set({ phase: 'interrupted', error: 'MODEL_INTERRUPTED' })
          .where(inArray(schema.modelCalls.phase, active))
          .run();
        if (interrupted.changes) this.bump();
      },
      { behavior: 'immediate' },
    );
  }
  private bump() {
    this.db
      .update(schema.workspace)
      .set({ revision: sql`${schema.workspace.revision} + 1` })
      .where(eq(schema.workspace.id, 1))
      .run();
  }
  settings() {
    const row = this.db
      .select()
      .from(schema.modelSettings)
      .orderBy(desc(schema.modelSettings.version))
      .get();
    return row
      ? {
          protocol: 'chat-completions' as const,
          endpoint: row.endpoint,
          model: row.model,
          version: row.version,
          hasCredential: true,
        }
      : null;
  }
  messages(taskId: string) {
    const calls = new Map(
      this.db
        .select()
        .from(schema.modelCalls)
        .where(eq(schema.modelCalls.taskId, taskId))
        .all()
        .map((call) => [call.id, call]),
    );
    return this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.taskId, taskId))
      .orderBy(schema.messages.id)
      .all()
      .map((message) => {
        const call = message.callId ? calls.get(message.callId) : undefined;
        return {
          role: message.role,
          text: call ? call.output : message.text,
          ...(call ? { call: modelCallSchema.parse(callView(call)) } : {}),
        };
      });
  }
  execute(input: unknown): Record<string, unknown> {
    const command = commandSchema.parse(input);
    return this.db.transaction(
      () => {
        if (command.kind === 'private-settings') {
          const row = this.db
            .select()
            .from(schema.modelSettings)
            .orderBy(desc(schema.modelSettings.version))
            .get();
          return {
            configuration: row
              ? {
                  protocol: 'chat-completions',
                  endpoint: row.endpoint,
                  model: row.model,
                  version: row.version,
                  ciphertext: row.ciphertext,
                }
              : null,
          };
        }
        if (command.kind === 'configuration') {
          const previous = this.db
            .select()
            .from(schema.modelSettings)
            .where(eq(schema.modelSettings.requestId, command.requestId))
            .get();
          if (previous) {
            if (previous.hash !== command.hash)
              throw new Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          const current = this.db
            .select()
            .from(schema.modelSettings)
            .orderBy(desc(schema.modelSettings.version))
            .get();
          if ((current?.version ?? 0) !== command.expectedVersion)
            throw new Error('RECORD_VERSION_CONFLICT');
          const ciphertext = command.ciphertext ?? current?.ciphertext;
          if (!ciphertext) throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
          this.db
            .insert(schema.modelSettings)
            .values({
              requestId: command.requestId,
              hash: command.hash,
              endpoint: command.endpoint,
              model: command.model,
              ciphertext,
            })
            .run();
          this.bump();
          return { created: true };
        }
        if (command.kind === 'begin') {
          const hash = createHash('sha256')
            .update(
              JSON.stringify([
                command.taskId,
                command.text,
                command.expectedVersion ?? null,
                ...(command.purpose ? [command.purpose] : []),
              ]),
            )
            .digest('hex');
          const previous = this.db
            .select()
            .from(schema.modelCalls)
            .where(eq(schema.modelCalls.id, command.id))
            .get();
          if (previous) {
            if (previous.hash !== hash)
              throw new Error('REQUEST_CONTENT_CONFLICT');
            return { created: false, call: callView(previous) };
          }
          const task = this.db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, command.taskId))
            .get();
          if (!task) throw new Error('TASK_NOT_FOUND');
          if (
            command.expectedVersion !== undefined &&
            command.expectedVersion !== task.version
          )
            throw new Error('RECORD_VERSION_CONFLICT');
          const settings = this.db
            .select()
            .from(schema.modelSettings)
            .orderBy(desc(schema.modelSettings.version))
            .get();
          if (!settings) throw new Error('MODEL_NOT_CONFIGURED');
          const running = this.db
            .select()
            .from(schema.modelCalls)
            .where(inArray(schema.modelCalls.phase, active))
            .all();
          if (running.some((call) => call.taskId === command.taskId))
            throw new Error('MODEL_BUSY');
          if (running.length >= MODEL_LIMITS.concurrent)
            throw new Error('MODEL_LIMIT');
          this.db
            .insert(schema.modelCalls)
            .values({
              id: command.id,
              taskId: command.taskId,
              hash,
              configurationVersion: settings.version,
              model: settings.model,
              phase: 'preparing',
            })
            .run();
          this.db
            .insert(schema.messages)
            .values([
              ...(command.purpose
                ? []
                : [
                    {
                      taskId: command.taskId,
                      role: 'user',
                      text: command.text,
                    },
                  ]),
              {
                taskId: command.taskId,
                role: 'assistant',
                text: '',
                callId: command.id,
              },
            ])
            .run();
          this.db
            .update(schema.tasks)
            .set({
              ...(command.purpose ? {} : { draft: '' }),
              version: task.version + 1,
            })
            .where(eq(schema.tasks.id, task.id))
            .run();
          this.bump();
          return {
            created: true,
            configuration: {
              protocol: 'chat-completions',
              endpoint: settings.endpoint,
              model: settings.model,
              version: settings.version,
              ciphertext: settings.ciphertext,
            },
            call: callView(
              this.db
                .select()
                .from(schema.modelCalls)
                .where(eq(schema.modelCalls.id, command.id))
                .get()!,
            ),
          };
        }
        const call = this.db
          .select()
          .from(schema.modelCalls)
          .where(eq(schema.modelCalls.id, command.id))
          .get();
        if (!call) throw new Error('MODEL_NOT_FOUND');
        if (!active.includes(call.phase))
          return { created: false, call: callView(call) };
        const event =
          command.kind === 'dispatch'
            ? 'DISPATCH'
            : command.kind === 'progress'
              ? 'PROGRESS'
              : command.phase === 'complete'
                ? 'COMPLETE'
                : command.phase === 'cancelled'
                  ? 'CANCEL'
                  : 'FAIL';
        const current = lifecycle.resolveState({
          value: call.phase,
          context: {},
        });
        if (!current.can({ type: event }))
          throw new Error('MODEL_STATE_CONFLICT');
        const [next] = transition(lifecycle, current, { type: event });
        const update: Partial<typeof schema.modelCalls.$inferInsert> = {
          phase: modelCallSchema.shape.phase.parse(next.value),
        };
        if (command.kind === 'dispatch') {
          const history = this.db
            .select()
            .from(schema.modelCalls)
            .where(
              and(
                eq(schema.modelCalls.taskId, call.taskId),
                eq(schema.modelCalls.dispatched, true),
              ),
            )
            .all();
          const consumed = history.reduce(
            (sum, row) => sum + (row.totalTokens ?? row.reservedTokens),
            0,
          );
          if (
            history.length >= MODEL_LIMITS.callsPerTask ||
            consumed + command.reservedTokens > MODEL_LIMITS.tokensPerTask
          )
            throw new Error('MODEL_LIMIT');
          Object.assign(update, {
            source: command.source,
            dispatched: true,
            reservedTokens: command.reservedTokens,
          });
        } else if (command.kind === 'progress') {
          if (!command.output.startsWith(call.output))
            throw new Error('REQUEST_CONTENT_CONFLICT');
          update.output = command.output;
        } else {
          if (command.phase === 'complete' && !call.output.trim())
            throw new Error('MODEL_FORMAT');
          Object.assign(update, {
            error: command.error,
            pageChanged: command.pageChanged,
          });
          if (command.phase === 'complete' && command.usage)
            Object.assign(update, command.usage);
        }
        this.db
          .update(schema.modelCalls)
          .set(update)
          .where(eq(schema.modelCalls.id, call.id))
          .run();
        this.bump();
        return { created: true, call: callView({ ...call, ...update }) };
      },
      { behavior: 'immediate' },
    );
  }
}
function callView(row: typeof schema.modelCalls.$inferSelect) {
  const {
    id,
    taskId,
    model,
    configurationVersion,
    phase,
    source,
    pageChanged,
    dispatched,
    reservedTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    error,
  } = row;
  return {
    id,
    taskId,
    model,
    configurationVersion,
    phase,
    source,
    pageChanged,
    dispatched,
    reservedTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    error,
  };
}
