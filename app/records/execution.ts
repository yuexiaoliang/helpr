import {
  attachmentBinding,
  submissionReady,
  recordPublicationResult,
  freezeRecovery,
  validateHistoricalCheck,
} from './publication';
import {
  downloadCheckSchema,
  publicationCheckSchema,
  samePublication,
} from '../shared/publication';
import { z } from 'zod';
import { hideTaskTab } from './task-tab';
import { endedExecution } from '../shared/task-groups';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createMachine, transition } from 'xstate';
import {
  executionSchema,
  participationReplySchema,
  participationDecisionSchema,
  publicationSchema,
  executionIntentSchema,
  executionPhaseSchema,
  webActionSchema,
  pageBindingSchema,
  nextStepSchema,
  executionPauseReasonSchema,
  pauseDescription,
  type TaskExecution,
} from '../shared/execution';
import * as schema from './schema';
import { pageSourceSchema, observedLinkSchema } from '../shared/model';
import {
  materialVersionSchema,
  preparationProposalSchema,
} from '../shared/material';
import { workflowChoiceSchema, workflowUseSchema } from '../shared/workflow';
import { workflowHash } from './workflow';
import { currentWorkflow, reboundAction } from '../shared/workflow-replay';

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
          WAIT: { target: 'unknown', guard: 'automatic' },
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
      REVIEW_COMPLETE: { target: '.complete', guard: 'automatic' },
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
  | 'REVIEW_COMPLETE'
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
const observation = pageSourceSchema.extend({
  text: z.string().max(30000),
  links: z.array(observedLinkSchema).max(300).optional(),
});
const work = { taskId: z.string(), runId: z.string() };
const intentSchema = executionIntentSchema.extend({
  kind: z.literal('intent'),
  closeAtVersion: z.number().int().nonnegative().optional(),
  loginQuestionId: z.string().uuid().optional(),
  controlSequence: z.number().int().positive().optional(),
});
const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workflow-bind'),
    ...work,
    choice: workflowChoiceSchema,
    source: observation,
  }),
  z.strictObject({
    kind: z.literal('anomaly'),
    ...work,
    source: observation,
    anomalies: z.array(z.string().min(1).max(2000)).max(20),
    extraResults: z.array(z.url()).max(50),
  }),
  z.strictObject({
    kind: z.literal('publication-recovery-result'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    check: publicationCheckSchema,
  }),
  z.strictObject({
    kind: z.literal('publication-result'),
    ...work,
    check: publicationCheckSchema,
  }),
  z.strictObject({
    kind: z.literal('material-selected'),
    ...work,
    material: materialVersionSchema,
  }),
  z.strictObject({
    kind: z.literal('preparation-observed'),
    ...work,
    source: observation,
    facts: z.array(preparationProposalSchema).min(1).max(5),
  }),
  z.strictObject({
    kind: z.literal('backup-pause'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('backup-review-result'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    source: observation,
    step: nextStepSchema,
  }),
  intentSchema,
  participationReplySchema,
  participationDecisionSchema,
  z.strictObject({
    kind: z.literal('verified-login'),
    ...work,
    source: observation,
    evidence: nextStepSchema.shape.evidence,
  }),
  z.strictObject({
    kind: z.literal('ask'),
    type: z.enum(['review', 'login']).optional(),
    publication: publicationSchema.optional(),
    ...work,
    questionId: z.string().uuid(),
    text: z.string().trim().min(1).max(1500),
    url: z.string(),
  }),
  z.strictObject({
    kind: z.literal('recover'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('system-interrupt'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
  }),
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
    workflowStep: executionSchema.shape.actions.element.shape.workflowStep,
    effect: nextStepSchema.shape.effect,
    evidence: nextStepSchema.shape.evidence.optional(),
    download: downloadCheckSchema.optional(),
    recovery: nextStepSchema.shape.recovery,
    publication: publicationSchema.optional(),
    approvalId: z.string().uuid().optional(),
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
    download: downloadCheckSchema.optional(),
    ...work,
    id: z.string(),
    source: observation,
    evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal('finish'),
    ...work,
    phase: z.enum(['complete', 'unknown', 'paused', 'failed']),
    prepared: z.boolean().optional(),
    summary: z.string().max(1500),
    source: observation.optional(),
    evidence: z.array(z.string()).max(10).optional(),
  }),
]);
function queueRecovery(e: TaskExecution, url: string, summary: string) {
  e.runId = null;
  e.version++;
  move(e, 'QUEUE');
  e.recoveryPending = true;
  e.recoverySource ??= { url, goalVersion: e.goalVersion };
  e.summary = summary;
  for (const action of e.actions) {
    if (
      action.status === 'reserved' &&
      action.dispatchState === 'not-dispatched'
    )
      action.status = 'cancelled';
    else if (action.status === 'reserved' || action.status === 'dispatched')
      action.status = 'unknown';
  }
}
export function pauseForBackup(e: TaskExecution): TaskExecution {
  const next = executionSchema.parse(structuredClone(e));
  next.version++;
  next.runId = null;
  delete next.question;
  next.restoreReview = 'required';
  delete next.recoveryPending;
  delete next.recoverySource;
  next.pauseReason ??= 'backup-restore';
  move(next, next.intent === 'stopped' ? 'STOP' : 'SUSPEND');
  for (const action of next.actions) {
    if (
      action.status === 'reserved' &&
      action.dispatchState === 'not-dispatched'
    )
      action.status = 'cancelled';
    else if (action.status === 'reserved' || action.status === 'dispatched')
      action.status = 'unknown';
  }
  next.summary =
    '资料恢复后自动工作保持暂停。先核对实际结果，再逐项选择继续；原停止与已有结果保留。';
  return next;
}
/** 唯一记录拥有者中计算纯转换；提交不执行网页或模型。 */
export class ExecutionRecords {
  // 同一控制者/记录进程生命周期的消息次序；不作为跨重启的业务事实。
  private readonly controlSequences = new Map<string, number>();
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {
    this.db.transaction(() => {
      for (const row of this.db.select().from(schema.executions).all()) {
        const e = executionSchema.parse(row.body);
        if (['queued', 'checking', 'running'].includes(e.phase)) {
          queueRecovery(
            e,
            this.db
              .select()
              .from(schema.tasks)
              .where(eq(schema.tasks.id, row.taskId))
              .get()?.url ?? '',
            '已找回原活动任务，先核对当前页面与实际结果，再续做剩余工作。',
          );
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
    let acceptedControl = false;
    const result = this.db.transaction(() => {
      const task = this.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, c.taskId))
        .get();
      if (!task) throw new Error('TASK_NOT_FOUND');
      let e = this.get(c.taskId);
      if (c.kind === 'participation-decision') {
        const receiptId = 'review:' + c.questionId;
        const hash = createHash('sha256')
          .update(JSON.stringify(c))
          .digest('hex');
        const prior = this.db
          .select()
          .from(schema.executionRequests)
          .where(eq(schema.executionRequests.id, receiptId))
          .get();
        if (prior) {
          if (prior.taskId !== task.id || prior.hash !== hash)
            throw Error('REQUEST_CONTENT_CONFLICT');
          return { created: false };
        }
        const q = e?.question,
          p = e?.publication;
        if (
          !e ||
          !p ||
          !q ||
          c.operation === 'login-check' ||
          q.type !== 'review' ||
          q.id !== c.questionId ||
          q.goalVersion !== e.goalVersion ||
          q.url !== task.url ||
          e.intent !== 'automatic' ||
          e.phase !== 'paused' ||
          e.pauseReason ||
          e.restoreReview
        )
          throw Error('PARTICIPATION_EXPIRED');
        if (c.operation === 'edit') {
          p.content = c.content;
          e.version++;
          p.revision++;
          p.approvalId = null;
          q.id = randomUUID();
        } else {
          p.approvalId = q.id;
          const use = currentWorkflow(e);
          if (use) use.approved = { id: q.id, content: p.content };
          delete e.question;
          queueRecovery(e, task.url, '已确认这版内容，先核对网页再继续。');
        }
        this.db
          .insert(schema.executionRequests)
          .values({ id: receiptId, taskId: task.id, hash })
          .run();
        this.db
          .insert(schema.messages)
          .values({
            taskId: task.id,
            role: 'user',
            text:
              (c.operation === 'edit' ? '修改为' : '确认发布') +
              '第 ' +
              p.revision +
              ' 版 · ' +
              p.destination +
              '\n' +
              p.content,
          })
          .run();
        this.save(task.id, e);
        return { created: true };
      }
      if (c.kind === 'participation-reply') {
        const previous = e?.answers?.find(
          (answer) => answer.id === c.questionId,
        );
        if (previous) {
          if (previous.answer !== c.text)
            throw Error('REQUEST_CONTENT_CONFLICT');
          return { created: false };
        }
        const question = e?.question;
        if (
          !e ||
          !question ||
          question.type ||
          question.id !== c.questionId ||
          question.goalVersion !== e.goalVersion ||
          question.url !== task.url ||
          e.intent !== 'automatic' ||
          e.phase !== 'paused' ||
          e.pauseReason ||
          e.restoreReview
        )
          throw Error('PARTICIPATION_EXPIRED');
        (e.answers ??= []).push({ ...question, answer: c.text });
        delete e.question;
        this.db
          .insert(schema.messages)
          .values({ taskId: task.id, role: 'user', text: c.text })
          .run();
        queueRecovery(e, task.url, '已收到回复，先核对当前网页再继续。');
        this.save(task.id, e);
        return { created: true };
      }
      if (c.kind === 'backup-pause') {
        if (!e) return { recorded: false };
        if (c.expectedVersion !== undefined && c.expectedVersion !== e.version)
          return { recorded: false };
        this.save(task.id, pauseForBackup(e));
        return { recorded: true };
      }
      if (c.kind === 'backup-review-result') {
        if (!e?.restoreReview || e.version !== c.expectedVersion)
          return { reviewed: false };
        if (
          c.source.url !== task.url ||
          !c.step.evidence.every((text) => c.source.text.includes(text))
        )
          throw Error('EXECUTION_EVIDENCE_MISSING');
        const pending = e.actions.find((a) =>
          ['reserved', 'dispatched', 'unknown'].includes(a.status),
        );
        if (
          pending &&
          c.step.previous?.id === pending.id &&
          c.step.previous.status === 'confirmed' &&
          c.step.previous.evidence.every((text) => c.source.text.includes(text))
        ) {
          pending.status = 'confirmed';
          pending.evidence = c.step.previous.evidence;
          pending.resultSource = pageSourceSchema.strip().parse(c.source);
        }
        const unknown = e.actions.some((a) =>
          ['reserved', 'dispatched', 'unknown'].includes(a.status),
        );
        const goalVersion = e.goalVersion;
        const materials =
          e.materials?.filter((m) => m.goalVersion === goalVersion) ?? [];
        const facts =
          e.preparation?.filter((f) => f.goalVersion === goalVersion) ?? [];
        const prepared =
          c.step.decision === 'prepared' &&
          materials.length > 0 &&
          facts.some((f) => f.kind === 'target') &&
          facts.some((f) => f.kind === 'draft') &&
          materials.every((m) =>
            facts.some((f) => f.kind === 'upload' && f.materialId === m.id),
          );
        e.restoreReview =
          unknown ||
          e.loginOrigin ||
          (e.publication && !e.publication.approvalId) ||
          (materials.length > 0 && c.step.decision === 'complete') ||
          (!prepared && !['complete', 'act'].includes(c.step.decision))
            ? 'unknown'
            : c.step.decision === 'complete'
              ? 'complete'
              : 'ready';
        if (e.restoreReview === 'complete') {
          e.result = {
            goalVersion: e.goalVersion,
            source: pageSourceSchema.strip().parse(c.source),
            evidence: c.step.evidence,
          };
          if (e.intent === 'automatic') {
            delete e.pauseReason;
            move(e, 'REVIEW_COMPLETE');
          }
        }
        e.version++;
        e.summary =
          e.restoreReview === 'unknown'
            ? '实际结果仍不明，自动工作保持暂停，不重新发送。'
            : e.restoreReview === 'complete'
              ? '网站实际结果已核对完成，无需重复操作；原停止保留。'
              : '实际进度已核对，原意图保持。由你选择是否继续本项任务。';
        this.save(task.id, e);
        return { reviewed: true };
      }
      if (c.kind === 'system-interrupt') {
        if (
          !e ||
          e.version < c.expectedVersion ||
          e.intent !== 'automatic' ||
          e.pauseReason ||
          !['queued', 'checking', 'running'].includes(e.phase)
        )
          return { interrupted: false };
        if (e.recoveryPending) return { interrupted: true };
        queueRecovery(
          e,
          task.url,
          '系统运行条件已变化，保留原任务，条件恢复后先核对再续做。',
        );
        this.save(task.id, e);
        return { interrupted: true };
      }
      if (c.kind === 'recover') {
        if (
          !e ||
          !e.recoveryPending ||
          e.version !== c.expectedVersion ||
          e.intent !== 'automatic' ||
          e.phase !== 'queued' ||
          e.pauseReason ||
          !task.url ||
          task.phase !== 'manual'
        )
          return { recovered: false };
        if (
          !e.recoverySource ||
          e.recoverySource.url !== task.url ||
          e.recoverySource.goalVersion !== e.goalVersion
        ) {
          move(e, 'BLOCK');
          e.pauseReason = 'page-change';
          e.version++;
          delete e.recoveryPending;
          delete e.recoverySource;
          e.summary =
            '重开的网页与原目标无法对应，已保留原任务并暂停。请先核对现场，再明确继续。';
          this.save(task.id, e);
          return { recovered: false };
        }
        delete e.recoveryPending;
        delete e.recoverySource;
        this.save(task.id, e);
        return { recovered: true };
      }
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
        acceptedControl = true;
        this.db
          .insert(schema.executionRequests)
          .values({ id: c.requestId, taskId: task.id, hash })
          .run();
        if (e?.restoreReview) {
          e.restoreReview = 'required';
          e.version++;
          this.save(task.id, e);
        }
        if (!e || e.intent === 'stopped' || e.phase === 'complete')
          return { recorded: true };
        e.version++;
        delete e.recoveryPending;
        delete e.recoverySource;
        e.runId = null;
        if (
          e.question?.type !== 'login' ||
          !['takeover', 'page-change'].includes(c.reason)
        )
          delete e.question;
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
        if (c.closeAtVersion !== undefined) {
          if (
            c.intent !== 'stop' ||
            task.hidden ||
            (e?.version ?? 0) !== c.closeAtVersion
          )
            throw Error('RECORD_VERSION_CONFLICT');
          hideTaskTab(this.db, task.id);
          this.db
            .update(schema.tasks)
            .set({ archived: true, version: task.version + 1 })
            .where(eq(schema.tasks.id, task.id))
            .run();
          if (endedExecution(e)) {
            this.db
              .insert(schema.executionRequests)
              .values({ id: c.requestId, hash, taskId: task.id })
              .run();
            this.save(task.id, e!);
            return { created: true };
          }
        }
        if (
          task.archived &&
          e?.result &&
          e.result.goalVersion === e.goalVersion &&
          ['start', 'continue'].includes(c.intent)
        )
          return { created: false, current: true };
        if (e?.restoreReview && ['start', 'continue'].includes(c.intent)) {
          if (e.restoreReview === 'complete')
            return { created: false, current: false };
          if (e.restoreReview !== 'ready')
            throw Error('BACKUP_REVIEW_REQUIRED');
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
        acceptedControl = true;
        e ??= {
          modelVersion: 1,
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
        if (
          c.loginQuestionId &&
          (c.intent !== 'continue' ||
            e.question?.type !== 'login' ||
            e.question.id !== c.loginQuestionId ||
            e.intent !== 'automatic' ||
            (e.pauseReason &&
              !['takeover', 'page-change'].includes(e.pauseReason)) ||
            e.restoreReview)
        )
          throw Error('PARTICIPATION_EXPIRED');
        if (
          !c.loginQuestionId &&
          e.question &&
          ['start', 'continue'].includes(c.intent)
        )
          throw Error('PARTICIPATION_REQUIRED');
        delete e.question;
        if (c.intent === 'start' && e.intent === 'stopped')
          throw new Error('EXECUTION_STOPPED');
        if (c.intent === 'start' && e.pauseReason)
          throw Error('EXECUTION_CONTINUE_REQUIRED');
        if (c.intent === 'revise') {
          if (!c.text?.trim()) throw new Error('INVALID_REQUEST');
          delete e.publication;
          delete e.loginOrigin;
          e.goal = c.text.trim();
          e.goalVersion++;
          this.db
            .update(schema.tasks)
            .set({ goal: e.goal, version: task.version + 1 })
            .where(eq(schema.tasks.id, task.id))
            .run();
        }
        e.version++;
        if (e.restoreReview && ['stop', 'revise'].includes(c.intent))
          e.restoreReview = 'required';
        else if (e.restoreReview === 'ready') delete e.restoreReview;
        delete e.recoveryPending;
        delete e.recoverySource;
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
        if (
          c.kind === 'publication-result' ||
          c.kind === 'publication-recovery-result'
        ) {
          const prior =
            e.publicationChecks?.find((r) => r.id === c.check.id) ??
            e.publicationHistory?.find((r) => r.check.id === c.check.id)?.check;
          if (prior) {
            if (JSON.stringify(prior) !== JSON.stringify(c.check))
              throw Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          const action = e.actions.find((a) => a.id === c.check.actionId);
          if (!action) throw Error('PUBLICATION_BINDING_MISMATCH');
          validateHistoricalCheck(e, c.check, action);
          const recovery = c.kind === 'publication-recovery-result';
          const currentRecovery =
            recovery &&
            c.expectedVersion === e.version &&
            e.intent === 'automatic' &&
            e.phase === 'queued' &&
            !e.pauseReason &&
            !e.question &&
            !e.restoreReview &&
            action.goalVersion === e.goalVersion;
          if (
            recovery &&
            (!c.check.recovery ||
              (c.check.status === 'verified' &&
                c.check.localMaterial !== 'verified'))
          )
            throw Error('EXECUTION_EVIDENCE_MISSING');
          if (recovery ? !currentRecovery : !active) {
            if ((e.publicationHistory?.length ?? 0) >= 60)
              throw Error('EXECUTION_LIMIT');
            (e.publicationHistory ??= []).push({
              check: c.check,
              reason: recovery ? 'changed-intent' : 'stale-worker',
            });
            this.save(task.id, e);
            return { created: true, historical: true };
          }
          if (recovery) {
            recordPublicationResult(task.id, e, c.check, action);
            move(e, c.check.status === 'verified' ? 'REVIEW_COMPLETE' : 'WAIT');
            delete e.recoveryPending;
            delete e.recoverySource;
            e.runId = null;
            e.summary =
              c.check.status === 'verified'
                ? '已从提交前保存的位置核对发布结果和附件，无需再次提交。'
                : c.check.failure === 'material'
                  ? '本机固定素材缺失或损坏，网站核对证据已保留，暂停且不重复提交。'
                  : '已只读核对原结果位置，证据仍不足；已有提交保持未知，不重复发送。';
            if (c.check.status === 'verified') e.resource = null;
            this.save(task.id, e);
            return { created: true };
          }
        }
        if (c.kind === 'reported') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a) throw new Error('ACTION_NOT_OWNED');
          if (a.status === 'confirmed' || a.status === 'cancelled')
            return { recorded: false };
          a.returned = a.returned || c.returned;
          const processing = e.materialProcessing?.find(
            (p) => p.actionId === a.id,
          );
          if (processing) processing.status = 'unknown';
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
        if (c.kind === 'workflow-bind') {
          if (
            e.observedAnomalies?.some((a) => a.goalVersion === e.goalVersion) ||
            currentWorkflow(e) ||
            e.actions.some(
              (a) =>
                a.goalVersion === e.goalVersion && a.status !== 'cancelled',
            ) ||
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('WORKFLOW_NOT_APPLICABLE');
          const row = this.db
            .select()
            .from(schema.executions)
            .where(eq(schema.executions.taskId, c.choice.taskId))
            .get();
          const source = row ? executionSchema.parse(row.body) : undefined;
          const workflow = source?.learnedWorkflows?.find(
            (w) =>
              w.version === c.choice.version && w.sha256 === c.choice.sha256,
          );
          const material = e.materials?.filter(
            (m) => m.goalVersion === e.goalVersion,
          );
          const intent = [
            e.goal,
            ...(e.answers ?? [])
              .filter((a) => a.goalVersion === e.goalVersion)
              .map((a) => a.answer),
          ].join('\n');
          if (
            !workflow?.replay ||
            workflow.sha256 !== workflowHash(workflow) ||
            !source?.publicationChecks?.some(
              (r) =>
                r.id === workflow.evidence.resultId && r.status === 'verified',
            ) ||
            material?.length !== 1 ||
            c.source.truncated ||
            c.source.url !== task.url ||
            new URL(c.source.url).origin !== workflow.applicability.origin ||
            new URL(c.source.url).pathname !==
              new URL(workflow.applicability.entryUrl).pathname ||
            !(intent.match(/https?:\/\/[^\s<>"'，。；）)]+/gu) ?? []).some(
              (url) => url === c.source.url,
            ) ||
            !intent.includes(c.choice.content) ||
            !intent.includes(c.choice.destination)
          )
            throw Error('WORKFLOW_NOT_APPLICABLE');
          const use = workflowUseSchema.parse({
            id: randomUUID(),
            goalVersion: e.goalVersion,
            workflow,
            materialId: material[0]!.id,
            targetUrl: c.source.url,
            content: c.choice.content,
            destination: c.choice.destination,
            source: pageSourceSchema.strip().parse(c.source),
          });
          // 固定完整版本，后续采用变化不影响本次执行，也不带入原任务的确认。
          (e.workflowUses ??= []).push(use);
          delete e.publication;
          e.summary =
            '已绑定本次素材和目标，按保存的做法执行；发布前仍需本次确认。';
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'anomaly') {
          if (c.source.url !== task.url) throw Error('EXECUTION_PAGE_CHANGED');
          (e.observedAnomalies ??= []).push({
            goalVersion: e.goalVersion,
            source: pageSourceSchema.strip().parse(c.source),
            anomalies: c.anomalies,
            extraResults: c.extraResults,
          });
          move(e, 'WAIT');
          e.summary = '观察到异常或多余结果，已停止后续自动动作并保留记录。';
          e.runId = null;
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'publication-result') {
          if (e.publicationChecks?.some((r) => r.id === c.check.id))
            return { created: false };
          const action = e.actions.find((a) => a.id === c.check.actionId);
          if (!action || c.check.source.url !== task.url)
            throw Error('PUBLICATION_BINDING_MISMATCH');
          recordPublicationResult(task.id, e, c.check, action);
          move(e, c.check.status === 'verified' ? 'FINISH' : 'WAIT');
          e.summary =
            c.check.status === 'verified'
              ? '已核对发布结果和附件内容。' +
                (e.workflowAdoption
                  ? '已保存本次学到的做法；新输入仍需验证。'
                  : '步骤证据不足，尚未保存可复用流程。')
              : '发布结果尚未核实，已保留目标和核对记录，不重复提交。';
          e.runId = null;
          if (c.check.status === 'verified') e.resource = null;
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'material-selected') {
          if (
            c.material.goalVersion !== e.goalVersion ||
            e.materials?.some((m) => m.goalVersion === e.goalVersion)
          )
            throw Error('MATERIAL_ALREADY_FIXED');
          if (
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('EXECUTION_RESULT_UNKNOWN');
          (e.materials ??= []).push(c.material);
          // 改变素材后不能继承旧的内容确认。
          delete e.publication;
          this.db
            .insert(schema.messages)
            .values({
              taskId: task.id,
              role: 'system',
              text: `已固定素材：${c.material.name}（${c.material.bytes} 字节）。来源：${c.material.source}。取材依据：${c.material.selection.basis}。后续上传使用这一版本。`,
            })
            .run();
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'preparation-observed') {
          if (c.source.url !== task.url) throw Error('EXECUTION_PAGE_CHANGED');
          const facts = (e.preparation ??= []);
          const actions = e.actions.filter(
            (a) =>
              a.goalVersion === e.goalVersion &&
              ['dispatched', 'unknown', 'confirmed'].includes(a.status),
          );
          for (const fact of c.facts) {
            if (
              !fact.evidence.every((v) => c.source.text.includes(v)) ||
              (fact.url !== c.source.url && !c.source.text.includes(fact.url))
            )
              throw Error('EXECUTION_EVIDENCE_MISSING');
            const target = facts.find(
              (f) => f.goalVersion === e.goalVersion && f.kind === 'target',
            );
            if (new URL(fact.url).origin !== new URL(c.source.url).origin)
              throw Error('PREPARATION_TARGET_CHANGED');
            let action = actions.at(-1);
            if (fact.kind === 'target') {
              const explicit = [
                e.goal,
                ...(e.answers ?? [])
                  .filter((a) => a.goalVersion === e.goalVersion)
                  .map((a) => a.answer),
              ].some((text) =>
                (text.match(/https?:\/\/[^\s<>"'，。；）)]+/gu) ?? []).some(
                  (url) => url === fact.url,
                ),
              );
              if (
                fact.materialId ||
                (target && target.url !== fact.url) ||
                (!target &&
                  !explicit &&
                  (!action ||
                    action.source.url === fact.url ||
                    action.observedUrls?.includes(fact.url)))
              )
                throw Error('PREPARATION_TARGET_CHANGED');
            } else if (fact.kind === 'upload') {
              const material = e.materials?.find(
                (m) =>
                  m.id === fact.materialId && m.goalVersion === e.goalVersion,
              );
              action = actions.find(
                (a) =>
                  a.action.kind === 'upload' &&
                  a.action.materialId === material?.id,
              );
              if (
                !material ||
                !action ||
                action.observedUrls?.includes(fact.url) ||
                new URL(action.source.url).origin !== new URL(fact.url).origin
              )
                throw Error('MATERIAL_NOT_AUTHORIZED');
            } else if (
              !target ||
              fact.url !== target.url ||
              fact.materialId ||
              !action
            )
              throw Error('PREPARATION_TARGET_CHANGED');
            if (
              !facts.some(
                (f) =>
                  f.goalVersion === e.goalVersion &&
                  f.kind === fact.kind &&
                  f.url === fact.url &&
                  f.materialId === fact.materialId,
              )
            )
              facts.push({
                ...fact,
                id: randomUUID(),
                goalVersion: e.goalVersion,
                actionId: action?.id ?? null,
                source: pageSourceSchema.strip().parse(c.source),
                verification: 'page-observed',
              });
          }
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'verified-login') {
          if (
            !e.loginOrigin ||
            c.source.url !== task.url ||
            new URL(task.url).origin !== e.loginOrigin ||
            !c.evidence.every((v) => c.source.text.includes(v))
          )
            throw Error('EXECUTION_EVIDENCE_MISSING');
          this.db
            .insert(schema.messages)
            .values({
              taskId: task.id,
              role: 'system',
              text: '已核对网站登录：' + c.evidence.join('；'),
            })
            .run();
          delete e.loginOrigin;
          e.summary = '已在所属网站核对登录，继续核对原任务。';
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'ask') {
          if (task.url !== c.url) throw Error('EXECUTION_PAGE_CHANGED');
          if (
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('EXECUTION_RESULT_UNKNOWN');
          if (c.type === 'login')
            e.loginOrigin ??= e.publication?.origin ?? new URL(c.url).origin;
          if (c.type === 'review') {
            if (!c.publication) throw Error('INVALID_REQUEST');
            if (e.materials?.some((m) => m.goalVersion === e.goalVersion))
              attachmentBinding(e, c.publication);
            const old = e.publication;
            e.publication = {
              ...c.publication,
              origin: new URL(c.url).origin,
              approvalId: null,
              revision: (old?.revision ?? 0) + 1,
            };
          }
          if (task.archived)
            this.db
              .update(schema.tasks)
              .set({ archived: false })
              .where(eq(schema.tasks.id, task.id))
              .run();
          e.question = {
            type: c.type,
            runId: c.runId,
            id: c.questionId,
            goalVersion: e.goalVersion,
            text: c.text,
            url: c.url,
          };
          e.version++;
          e.runId = null;
          e.resource = null;
          move(e, 'BLOCK');
          e.summary = c.text;
          // 提问原文已随本轮模型回复进入所属会话。这里只保存待答事实。
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'dispatch') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a || a.runId !== c.runId || a.status !== 'reserved')
            return { permitted: false };
          if (
            a.effect === 'publication' &&
            e.materials?.some((m) => m.goalVersion === e.goalVersion)
          ) {
            if (
              !a.submission ||
              !e.publication?.approvalId ||
              a.publicationApprovalId !== e.publication.approvalId ||
              !samePublication(a.submission.publication, e.publication) ||
              a.source.url !== task.url ||
              Date.now() - a.submission.download.checkedAt > 30000
            )
              throw Error('PARTICIPATION_REQUIRED');
          }
          a.status = 'dispatched';
          a.dispatchState = 'possible';
          move(e, 'DISPATCH');
          e.summary = a.summary;
          this.save(task.id, e);
          return { permitted: true };
        }
        if (c.kind === 'reserve') {
          const recorded = e.actions.find((a) => a.id === c.id);
          if (recorded) {
            if (
              JSON.stringify(recorded.action) !== JSON.stringify(c.action) ||
              JSON.stringify(recorded.workflowStep) !==
                JSON.stringify(c.workflowStep)
            )
              throw Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          const use = currentWorkflow(e);
          if (use || c.workflowStep) {
            const index = e.actions.filter(
              (a) =>
                a.goalVersion === e.goalVersion && a.status !== 'cancelled',
            ).length;
            const step = use?.workflow.steps[index];
            if (
              !use ||
              !step ||
              c.workflowStep?.useId !== use.id ||
              c.workflowStep.index !== index ||
              c.source.url !== use.targetUrl ||
              c.source.truncated ||
              c.effect !== step.effect ||
              !step.before.evidence.every((s) => c.source.text.includes(s)) ||
              JSON.stringify(c.action) !==
                JSON.stringify(reboundAction(use, index))
            )
              throw Error('WORKFLOW_NOT_APPLICABLE');
          }
          if (e.loginOrigin) throw Error('PARTICIPATION_REQUIRED');
          if (e.observedAnomalies?.some((o) => o.goalVersion === e.goalVersion))
            throw Error('EXECUTION_RESULT_UNKNOWN');
          if (c.action.kind === 'upload') {
            const id = c.action.materialId;
            if (
              !e.materials?.some(
                (m) => m.id === id && m.goalVersion === e.goalVersion,
              )
            )
              throw Error('MATERIAL_NOT_AUTHORIZED');
            if (
              e.actions.some(
                (a) =>
                  a.action.kind === 'upload' &&
                  a.action.materialId === id &&
                  a.status !== 'cancelled',
              )
            )
              throw Error('MATERIAL_ALREADY_UPLOADED');
            const frame = c.action.target.frameUrl ?? c.source.url;
            if (
              !c.source.text.includes(
                `[file ${c.action.target.fileIndex}] ${frame}`,
              )
            )
              throw Error('EXECUTION_EVIDENCE_MISSING');
          }
          const preparationTarget = e.preparation?.find(
            (f) => f.kind === 'target' && f.goalVersion === e.goalVersion,
          );
          if (
            preparationTarget &&
            new URL(c.source.url).origin !==
              new URL(preparationTarget.url).origin
          )
            throw Error('PREPARATION_TARGET_CHANGED');
          const p = e.publication;
          const hasMaterial = e.materials?.some(
            (m) => m.goalVersion === e.goalVersion,
          );
          const effect =
            c.effect ??
            (c.action.kind === 'upload'
              ? 'upload'
              : p && c.action.kind === 'click'
                ? 'publication'
                : 'interaction');
          if (hasMaterial && effect === 'publication') {
            if (!p || !c.publication || c.action.kind !== 'click')
              throw Error('PARTICIPATION_REQUIRED');
            submissionReady(e, c.publication, c.source, c.download);
          }
          if (
            hasMaterial &&
            p?.approvalId &&
            c.action.kind === 'click' &&
            effect !== 'publication'
          )
            throw Error('PARTICIPATION_REQUIRED');
          if (p || c.publication || c.approvalId) {
            if (
              !p?.approvalId ||
              !c.publication ||
              p.approvalId !== c.approvalId ||
              p.origin !== new URL(c.source.url).origin ||
              !samePublication(p, c.publication)
            )
              throw Error('PARTICIPATION_REQUIRED');
            if (
              (c.action.kind === 'fill' &&
                ![p.content, p.destination].includes(c.action.value)) ||
              (c.action.kind === 'select' &&
                c.action.value !== p.destination) ||
              c.action.kind === 'check'
            )
              throw Error('PARTICIPATION_REQUIRED');
          }
          // 首版窄发布只允许一次提交点击，且派发前必须能在所属网页核对去向和全文。
          if (p && c.action.kind === 'click') {
            if (
              !c.source.text.includes(p.content) ||
              !c.source.text.includes(p.destination)
            )
              throw Error('EXECUTION_EVIDENCE_MISSING');
            if (
              e.actions.some(
                (a) =>
                  a.id !== c.id &&
                  a.publicationApprovalId === p.approvalId &&
                  a.action.kind === 'click' &&
                  a.status !== 'cancelled',
              )
            )
              throw Error('PARTICIPATION_REQUIRED');
          }
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
          if (task.archived)
            this.db
              .update(schema.tasks)
              .set({ archived: false })
              .where(eq(schema.tasks.id, task.id))
              .run();
          if (c.evidence && !c.evidence.every((v) => c.source.text.includes(v)))
            throw Error('EXECUTION_EVIDENCE_MISSING');
          e.actions.push({
            ...(c.workflowStep ? { workflowStep: c.workflowStep } : {}),
            observedLinks: c.source.links ?? [],
            effect,
            preconditions: c.evidence,
            ...(hasMaterial && effect === 'publication' && p && c.download
              ? {
                  submission: {
                    publication: c.publication!,
                    download: c.download,
                    recovery: freezeRecovery(
                      e,
                      c.publication!,
                      c.source,
                      c.recovery,
                    ),
                  },
                }
              : {}),
            id: c.id,
            runId: c.runId,
            goalVersion: e.goalVersion,
            status: 'reserved',
            summary: c.summary,
            action: c.action,
            ...(p?.approvalId && c.action.kind === 'click'
              ? { publicationApprovalId: p.approvalId }
              : {}),
            source: pageSourceSchema.strip().parse(c.source),
            observedUrls: [
              ...new Set([
                c.source.url,
                ...[
                  ...c.source.text.matchAll(
                    /^\[link-url\] (https?:\/\/\S+)$/gm,
                  ),
                ].map((m) => m[1]!),
              ]),
            ].slice(0, 300),
            binding: c.binding,
            evidence: [],
            returned: false,
            dispatchState: 'not-dispatched',
          });
          if (hasMaterial && effect === 'publication') {
            const work = (e.materialProcessing ??= []);
            const pending = work.find(
              (m) =>
                m.goalVersion === e.goalVersion &&
                m.materialId === p!.attachment!.materialId &&
                m.targetUrl === p!.attachment!.targetUrl &&
                m.approvalId === p!.approvalId &&
                m.status === 'pending' &&
                m.resultId === null &&
                e.actions.some(
                  (a) =>
                    a.id === m.actionId &&
                    a.status === 'cancelled' &&
                    a.dispatchState === 'not-dispatched',
                ),
            );
            // 尚未派发的旧预留留在动作历史；同一份待处理工作关联新的剩余动作。
            if (pending) pending.actionId = c.id;
            else
              work.push({
                materialId: p!.attachment!.materialId,
                goalVersion: e.goalVersion,
                targetUrl: p!.attachment!.targetUrl,
                approvalId: p!.approvalId!,
                actionId: c.id,
                status: 'pending',
                resultId: null,
              });
          }
          e.summary = c.summary;
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'resolve') {
          const a = e.actions.find((a) => a.id === c.id);
          if (!a) throw new Error('ACTION_NOT_OWNED');
          if (a.submission) throw Error('PUBLICATION_RESULT_REQUIRED');
          if (
            a.runId !== c.runId &&
            e.materials?.some((m) => m.goalVersion === e.goalVersion)
          ) {
            const target = e.preparation?.find(
              (f) => f.kind === 'target' && f.goalVersion === a.goalVersion,
            );
            if (!target || target.url !== c.source.url)
              throw Error('EXECUTION_RESULT_UNKNOWN');
            if (a.action.kind === 'upload') {
              const materialId = a.action.materialId;
              const m = e.materials.find((m) => m.id === materialId);
              const upload = e.preparation?.find(
                (f) =>
                  f.kind === 'upload' &&
                  f.actionId === a.id &&
                  f.materialId === materialId,
              );
              if (
                !m ||
                !upload ||
                !c.download ||
                c.download.url !== upload.url ||
                c.download.sha256 !== m.sha256 ||
                c.download.bytes !== m.bytes ||
                c.download.checkedAt < c.source.observedAt
              )
                throw Error('EXECUTION_RESULT_UNKNOWN');
            } else if (
              !e.preparation?.some(
                (f) =>
                  f.kind === 'draft' &&
                  f.actionId === a.id &&
                  f.url === target.url,
              )
            )
              throw Error('EXECUTION_RESULT_UNKNOWN');
          }
          if (!['dispatched', 'unknown'].includes(a.status))
            throw new Error('EXECUTION_RESULT_UNKNOWN');
          if (!c.evidence.every((v) => c.source.text.includes(v)))
            throw new Error('EXECUTION_EVIDENCE_MISSING');
          a.status = 'confirmed';
          a.evidence = c.evidence;
          a.resultSource = pageSourceSchema.strip().parse(c.source);
          a.resultLinks = c.source.links ?? [];
          this.save(task.id, e);
          return { resolved: true };
        }
        if (c.prepared) {
          const materials =
            e.materials?.filter((m) => m.goalVersion === e.goalVersion) ?? [];
          const facts =
            e.preparation?.filter((f) => f.goalVersion === e.goalVersion) ?? [];
          if (
            c.phase !== 'paused' ||
            !materials.length ||
            !facts.some((f) => f.kind === 'target') ||
            !facts.some((f) => f.kind === 'draft') ||
            !materials.every((m) =>
              facts.some((f) => f.kind === 'upload' && f.materialId === m.id),
            ) ||
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('PREPARATION_INCOMPLETE');
          if (
            !c.source ||
            c.source.url !== task.url ||
            !c.evidence?.length ||
            !c.evidence.every((v) => c.source!.text.includes(v))
          )
            throw Error('EXECUTION_EVIDENCE_MISSING');
          e.prepared = {
            goalVersion: e.goalVersion,
            source: pageSourceSchema.strip().parse(c.source),
            evidence: c.evidence,
          };
        }
        if (c.phase === 'complete') {
          if (e.materials?.some((m) => m.goalVersion === e.goalVersion))
            throw Error('PUBLICATION_RESULT_REQUIRED');
          if (e.loginOrigin || (e.publication && !e.publication.approvalId))
            throw Error('PARTICIPATION_REQUIRED');
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
      if (
        !e ||
        e.intent !== 'automatic' ||
        e.phase !== 'queued' ||
        e.recoveryPending ||
        e.restoreReview
      )
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
      acceptedControl &&
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
