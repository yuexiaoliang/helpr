import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import { createMachine, transition } from 'xstate';
import {
  executionSchema,
  executionIntentSchema,
  executionPhaseSchema,
  webActionSchema,
  pageBindingSchema,
  executionPauseReasonSchema,
  pauseDescription,
  type TaskExecution,
} from '../shared/execution';
import * as schema from './schema';
import { pageSourceSchema } from '../shared/model';

const activeTransitions = {
  DISPATCH: { target: 'running', guard: 'automatic' },
  WAIT: { target: 'unknown', guard: 'automatic' },
  BLOCK: { target: 'paused', guard: 'automatic' },
  FINISH: { target: 'complete', guard: 'automatic' },
  FAIL: { target: 'failed', guard: 'automatic' },
};
const lifecycle = createMachine(
  {
    types: { context: {} as Pick<TaskExecution, 'intent'> },
    id: 'task-execution',
    initial: 'queued',
    context: { intent: 'automatic' },
    states: {
      queued: {
        on: {
          CLAIM: { target: 'checking', guard: 'automatic' },
          BLOCK: { target: 'paused', guard: 'automatic' },
        },
      },
      checking: { on: activeTransitions },
      running: { on: activeTransitions },
      stopped: {},
      unknown: {},
      paused: {},
      complete: {},
      failed: {},
    },
    on: {
      QUEUE: { target: '.queued', guard: 'automatic' },
      STOP: { target: '.stopped', guard: 'stopped' },
      SUSPEND: { target: '.paused', guard: 'automatic' },
    },
  },
  {
    guards: {
      automatic: ({ context }) => context.intent === 'automatic',
      stopped: ({ context }) => context.intent === 'stopped',
    },
  },
);
type PhaseEvent =
  | 'QUEUE'
  | 'CLAIM'
  | 'DISPATCH'
  | 'STOP'
  | 'WAIT'
  | 'BLOCK'
  | 'FINISH'
  | 'FAIL'
  | 'SUSPEND';
function move(e: TaskExecution, event: PhaseEvent) {
  const state = lifecycle.resolveState({
    value: e.phase,
    context: { intent: e.intent },
  });
  if (!state.can({ type: event })) throw Error('EXECUTION_STATE_CONFLICT');
  const [next] = transition(lifecycle, state, { type: event });
  e.phase = executionPhaseSchema.parse(next.value);
}
const observation = pageSourceSchema.extend({ text: z.string().max(30000) });
const work = { taskId: z.string(), runId: z.string() };
const intentSchema = executionIntentSchema.extend({
  kind: z.literal('intent'),
  controlSequence: z.number().int().positive().optional(),
});
const commandSchema = z.discriminatedUnion('kind', [
  intentSchema,
  z.strictObject({
    kind: z.literal('suspend'),
    controlSequence: z.number().int().positive().optional(),
    taskId: z.string(),
    requestId: z.string().min(1).max(100),
    reason: executionPauseReasonSchema,
  }),
  z.strictObject({
    kind: z.literal('claim'),
    taskId: z.string(),
    runId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('reserve'),
    ...work,
    id: z.string(),
    summary: z.string().min(1).max(1500),
    action: webActionSchema,
    source: observation,
    binding: pageBindingSchema,
  }),
  z.strictObject({ kind: z.literal('dispatch'), ...work, id: z.string() }),
  z.strictObject({
    kind: z.literal('reported'),
    taskId: z.string(),
    id: z.string(),
    returned: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('resolve'),
    ...work,
    id: z.string(),
    source: observation,
    evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal('finish'),
    ...work,
    phase: z.enum(['complete', 'unknown', 'paused', 'failed']),
    summary: z.string().max(1500),
    source: observation.optional(),
    evidence: z.array(z.string()).max(10).optional(),
  }),
]);
/** 唯一记录拥有者中计算纯转换；提交不执行网页或模型。 */
export class ExecutionRecords {
  // 同一控制者/记录进程生命周期的消息次序；不作为跨重启的业务事实。
  private readonly controlSequences = new Map<string, number>();
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {
    this.db.transaction(() => {
      for (const row of this.db.select().from(schema.executions).all()) {
        const e = executionSchema.parse(row.body);
        if (['queued', 'checking', 'running'].includes(e.phase)) {
          e.runId = null;
          move(e, 'BLOCK');
          e.summary = '上次执行已中断。请先核对页面与已有结果，再明确继续。';
          for (const a of e.actions) {
            if (a.status === 'reserved') a.status = 'cancelled';
            else if (a.status === 'dispatched') a.status = 'unknown';
          }
          this.save(row.taskId, e);
        }
      }
    });
  }
  get(taskId: string): TaskExecution | null {
    const row = this.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.taskId, taskId))
      .get();
    return row ? executionSchema.parse(row.body) : null;
  }
  private save(taskId: string, e: TaskExecution) {
    this.db
      .insert(schema.executions)
      .values({ taskId, body: e })
      .onConflictDoUpdate({
        target: schema.executions.taskId,
        set: { body: e },
      })
      .run();
    this.db
      .update(schema.workspace)
      .set({ revision: sql`${schema.workspace.revision}+1` })
      .run();
  }
  execute(input: unknown): Record<string, unknown> {
    const c = commandSchema.parse(input);
    const result = this.db.transaction(() => {
      const task = this.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, c.taskId))
        .get();
      if (!task) throw new Error('TASK_NOT_FOUND');
      let e = this.get(c.taskId);
      if (c.kind === 'suspend') {
        const { controlSequence, ...request } = c;
        const hash = createHash('sha256')
          .update(JSON.stringify(request))
          .digest('hex');
        const prior = this.db
          .select()
          .from(schema.executionRequests)
          .where(eq(schema.executionRequests.id, c.requestId))
          .get();
        if (prior) {
          if (prior.hash !== hash) throw Error('REQUEST_CONTENT_CONFLICT');
          return { recorded: false };
        }
        if (
          controlSequence !== undefined &&
          controlSequence <= (this.controlSequences.get(c.taskId) ?? 0)
        )
          throw Error('RECORD_VERSION_CONFLICT');
        this.db
          .insert(schema.executionRequests)
          .values({ id: c.requestId, taskId: task.id, hash })
          .run();
        if (!e || e.intent === 'stopped' || e.phase === 'complete')
          return { recorded: true };
        e.version++;
        e.runId = null;
        e.pauseReason = c.reason;
        for (const action of e.actions) {
          if (action.status === 'reserved') action.status = 'cancelled';
          else if (action.status === 'dispatched') action.status = 'unknown';
        }
        if (
          !e.actions.some((a) => ['dispatched', 'unknown'].includes(a.status))
        )
          e.resource = null;
        move(e, 'SUSPEND');
        e.summary = pauseDescription[c.reason].message;
        this.save(task.id, e);
        return { recorded: true };
      }
      if (c.kind === 'intent') {
        // 传输前提不是用户意图内容；重送回执不能因重新取样而改变指纹。
        const { controlSequence, ...request } = c;
        const hash = createHash('sha256')
          .update(JSON.stringify(request))
          .digest('hex');
        const prior = this.db
          .select()
          .from(schema.executionRequests)
          .where(eq(schema.executionRequests.id, c.requestId))
          .get();
        if (prior) {
          if (prior.hash !== hash) throw new Error('REQUEST_CONTENT_CONFLICT');
          return {
            created: false,
            current: e?.intentId === c.requestId && !e.pauseReason,
          };
        }
        if (
          controlSequence !== undefined &&
          controlSequence <= (this.controlSequences.get(c.taskId) ?? 0)
        )
          throw Error('RECORD_VERSION_CONFLICT');
        if (
          c.expectedVersion !== undefined &&
          c.expectedVersion !== (e?.version ?? 1)
        )
          throw Error('RECORD_VERSION_CONFLICT');
        e ??= {
          intent: 'automatic',
          phase: 'queued',
          version: 1,
          intentId: c.requestId,
          goalVersion: 1,
          goal: task.goal,
          runId: null,
          resource: null,
          summary: '',
          actions: [],
        };
        if (c.intent === 'start' && e.intent === 'stopped')
          throw new Error('EXECUTION_STOPPED');
        if (c.intent === 'start' && e.pauseReason)
          throw Error('EXECUTION_CONTINUE_REQUIRED');
        if (c.intent === 'revise') {
          if (!c.text?.trim()) throw new Error('INVALID_REQUEST');
          e.goal = c.text.trim();
          e.goalVersion++;
          this.db
            .update(schema.tasks)
            .set({ goal: e.goal, version: task.version + 1 })
            .where(eq(schema.tasks.id, task.id))
            .run();
        }
        e.version++;
        e.intentId = c.requestId;
        e.runId = null;
        for (const a of e.actions)
          if (a.status === 'reserved') a.status = 'cancelled';
        if (
          c.intent === 'stop' ||
          (c.intent === 'revise' && e.intent === 'stopped')
        ) {
          e.intent = 'stopped';
          move(e, 'STOP');
          e.summary =
            c.intent === 'stop'
              ? '任务已停止，页面与已有结果保留。'
              : '要求已更新，任务保持停止。明确继续后再核对。';
        } else {
          e.intent = 'automatic';
          if (c.intent === 'revise' && e.pauseReason) {
            move(e, 'SUSPEND');
            e.summary = '要求已更新，仍等待明确继续。';
          } else {
            delete e.pauseReason;
            move(e, 'QUEUE');
            e.summary = '等待容量，轮到本任务后先核对当前页面与已有结果。';
          }
        }
        this.db
          .insert(schema.executionRequests)
          .values({ id: c.requestId, hash, taskId: task.id })
          .run();
        this.db
          .insert(schema.messages)
          .values({
            taskId: task.id,
            role: 'user',
            text:
              c.text ??
              {
                start: '开始执行',
                stop: '停止',
                continue: '继续',
                revise: '修改要求',
              }[c.intent],
          })
          .run();
        if (c.text && task.draft.trim() === c.text.trim())
          this.db
            .update(schema.tasks)
            .set({ draft: '' })
            .where(eq(schema.tasks.id, task.id))
            .run();
        this.save(task.id, e);
        return { created: true };
      }
      if (c.kind !== 'claim') {
        if (!e) throw new Error('EXECUTION_NOT_FOUND');
        const active =
          'runId' in c &&
          e.intent === 'automatic' &&
          e.runId === c.runId &&
          ['checking', 'running'].includes(e.phase);
        if (c.kind === 'reported') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a) throw new Error('ACTION_NOT_OWNED');
          if (a.status === 'confirmed' || a.status === 'cancelled')
            return { recorded: false };
          a.returned = a.returned || c.returned;
          a.status = 'unknown';
          if (e.intent === 'stopped')
            e.summary =
              '任务保持停止。先前送出的操作已有返回，实际结果仍需核对。';
          this.save(task.id, e);
          return { recorded: true };
        }
        if (!active)
          return c.kind === 'dispatch'
            ? { permitted: false }
            : { created: false };
        if (c.kind === 'dispatch') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a || a.runId !== c.runId || a.status !== 'reserved')
            return { permitted: false };
          a.status = 'dispatched';
          move(e, 'DISPATCH');
          e.summary = a.summary;
          this.save(task.id, e);
          return { permitted: true };
        }
        if (c.kind === 'reserve') {
          const prior = e.actions.find((a) => a.id === c.id);
          if (prior) {
            if (JSON.stringify(prior.action) !== JSON.stringify(c.action))
              throw new Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          if (
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw new Error('EXECUTION_RESULT_UNKNOWN');
          if (e.actions.length >= 60) throw new Error('EXECUTION_LIMIT');
          if (
            c.source.url !== task.url ||
            c.binding.generation !== c.source.generation
          )
            throw new Error('EXECUTION_PAGE_CHANGED');
          e.actions.push({
            id: c.id,
            runId: c.runId,
            goalVersion: e.goalVersion,
            status: 'reserved',
            summary: c.summary,
            action: c.action,
            source: pageSourceSchema.strip().parse(c.source),
            binding: c.binding,
            evidence: [],
            returned: false,
          });
          e.summary = c.summary;
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'resolve') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a) throw new Error('ACTION_NOT_OWNED');
          if (!['dispatched', 'unknown'].includes(a.status))
            throw new Error('EXECUTION_RESULT_UNKNOWN');
          if (!c.evidence.every((v) => c.source.text.includes(v)))
            throw new Error('EXECUTION_EVIDENCE_MISSING');
          a.status = 'confirmed';
          a.evidence = c.evidence;
          a.resultSource = pageSourceSchema.strip().parse(c.source);
          this.save(task.id, e);
          return { resolved: true };
        }
        if (c.phase === 'complete') {
          if (
            !c.source ||
            !c.evidence?.length ||
            !c.evidence.every((v) => c.source!.text.includes(v))
          )
            throw new Error('EXECUTION_EVIDENCE_MISSING');
          if (
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw new Error('EXECUTION_RESULT_UNKNOWN');
          e.result = {
            goalVersion: e.goalVersion,
            source: pageSourceSchema.strip().parse(c.source),
            evidence: c.evidence,
          };
        }
        move(
          e,
          (
            {
              complete: 'FINISH',
              unknown: 'WAIT',
              paused: 'BLOCK',
              failed: 'FAIL',
            } as const
          )[c.phase],
        );
        e.summary = c.summary;
        e.runId = null;
        if (
          !e.actions.some((a) =>
            ['reserved', 'dispatched', 'unknown'].includes(a.status),
          )
        )
          e.resource = null;
        this.save(task.id, e);
        return { finished: true };
      }
      if (!e || e.intent !== 'automatic' || e.phase !== 'queued')
        return { claimed: false };
      if (!task.url || task.phase === 'loading' || task.phase === 'error')
        return { claimed: false };
      const u = new URL(task.url),
        resource = u.origin + u.pathname;
      const others = this.db
        .select()
        .from(schema.executions)
        .all()
        .filter((r) => r.taskId !== task.id)
        .map((r) => executionSchema.parse(r.body));
      if (
        others.filter((x) => ['checking', 'running'].includes(x.phase))
          .length >= 2
      )
        return { claimed: false };
      if (
        others.some(
          (x) =>
            x.resource === resource &&
            (['checking', 'running'].includes(x.phase) ||
              x.actions.some((a) =>
                ['reserved', 'dispatched', 'unknown'].includes(a.status),
              )),
        )
      )
        return { claimed: false };
      e.runId = c.runId;
      e.resource = resource;
      move(e, 'CLAIM');
      e.summary = '正在核对当前页面与已有结果。';
      this.save(task.id, e);
      return { claimed: true, execution: e };
    });
    if (
      (c.kind === 'intent' || c.kind === 'suspend') &&
      c.controlSequence !== undefined
    )
      this.controlSequences.set(
        c.taskId,
        Math.max(c.controlSequence, this.controlSequences.get(c.taskId) ?? 0),
      );
    return result;
  }
}
