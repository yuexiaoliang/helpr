import {
  creationFieldsMatch,
  validDiscoveredTarget,
} from '../shared/target-creation';
import {
  actionNavigationEventSchema,
  linkNavigationResolutionSchema,
} from '../shared/action-navigation';
import {
  agreementUICommandSchema,
  agreementTermsSchema,
  agreementGoal,
  agreementSummary,
  type AgreementVersion,
} from '../shared/agreement';
import {
  agreementApplies,
  boundAgreement,
  activeAgreement,
  validateAgreementTerms,
  workKey,
  canAutoApprove,
  assertAgreementAuthority,
  syncMaterialWorks,
} from './agreement';
import { contentSourceSchema, articleDraftSchema } from '../shared/article';
import {
  contentRequirements,
  contentSourceHash,
  generatedArticle,
  editArticle,
  publicationArticle,
  contentCallHash,
} from './article';
import {
  attachmentBinding,
  submissionReady,
  recordPublicationResult,
  freezeRecovery,
  discoverRecovery,
  validateHistoricalCheck,
} from './publication';
import {
  downloadCheckSchema,
  publicationCheckSchema,
  samePublication,
  publicationFillBinding,
  publicationParts,
  verifyPublicationFields,
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
import {
  pageSourceSchema,
  observedLinkSchema,
  observedControlSchema,
} from '../shared/model';
import {
  materialVersionSchema,
  preparationProposalSchema,
} from '../shared/material';
import { workflowChoiceSchema, workflowUseSchema } from '../shared/workflow';
import { selectedControl, verifyCurrentSelections } from '../shared/selection';
import { workflowHash, adoptWorkflow } from './workflow';
import {
  currentWorkflow,
  reboundAction,
  observedControl,
  replayStep,
} from '../shared/workflow-replay';
import {
  currentRepair,
  sameWorkflowOperation,
  withinWorkflowScope,
} from '../shared/workflow-repair';
import { availableWorkflows } from '../shared/workflow-catalog';
import {
  sessionContextSchema,
  coordinationProposalSchema,
  sameSession,
  sameAccount,
} from '../shared/coordination';
import {
  acquireResource,
  invalidateRun,
  observeRelation,
  releaseUnusedClaims,
  resourceConflict,
} from './coordination';

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
  controls: z.array(observedControlSchema).max(500).optional(),
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
    kind: z.literal('agreement-material'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    material: materialVersionSchema.optional(),
    failure: z.string().min(1).max(1500).optional(),
  }),
  agreementUICommandSchema.options[1],
  agreementUICommandSchema.options[2],
  agreementUICommandSchema.options[3],
  z.strictObject({
    kind: z.literal('agreement-propose'),
    taskId: z.string(),
    requestId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    text: z.string().min(1).max(4000),
    terms: agreementTermsSchema,
  }),
  z.strictObject({
    kind: z.literal('workflow-repair'),
    ...work,
    id: z.string().uuid(),
    useId: z.string().uuid(),
    reason: z.enum(['WORKFLOW_CONDITION_CHANGED', 'WORKFLOW_CONTROL_CHANGED']),
    source: observation,
  }),
  z.strictObject({
    kind: z.literal('session-invalidated'),
    taskId: z.string(),
    session: sessionContextSchema,
  }),
  z.strictObject({
    kind: z.literal('coordination-observed'),
    ...work,
    session: sessionContextSchema,
    source: observation,
    proposal: coordinationProposalSchema.optional(),
    authenticated: z.boolean().optional(),
  }),
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
    kind: z.literal('created-target-observed'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    actionId: z.string(),
    source: observation,
    binding: pageBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('publication-result-entry'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    actionId: z.string(),
    source: observation,
    binding: pageBindingSchema,
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
    kind: z.literal('content-source'),
    ...work,
    source: contentSourceSchema,
  }),
  z.strictObject({
    kind: z.literal('article-generated'),
    ...work,
    sourceId: z.string().uuid(),
    draft: articleDraftSchema,
    modelCallId: z.string(),
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
    workflowScopeChange: z.boolean().optional(),
    coordinationDecision: z.boolean().optional(),
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
    session: sessionContextSchema.optional(),
    taskId: z.string(),
    runId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('reserve'),
    workflowStep: executionSchema.shape.actions.element.shape.workflowStep,
    effect: nextStepSchema.shape.effect,
    evidence: nextStepSchema.shape.evidence.optional(),
    download: downloadCheckSchema.optional(),
    targetCreation: nextStepSchema.shape.targetCreation,
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
  actionNavigationEventSchema.extend({ kind: z.literal('action-navigation') }),
  z.strictObject({
    kind: z.literal('navigation-resolved'),
    taskId: z.string(),
    expectedVersion: z.number().int().positive(),
    resolution: linkNavigationResolutionSchema,
  }),
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
  if (next.historyCleanup) return next;
  next.runId = null;
  if (next.coordination) {
    next.coordination.status = 'unverified';
    delete next.coordination.loginId;
    delete next.coordination.loginOwner;
    delete next.coordination.checkingLogin;
  }
  delete next.question;
  next.restoreReview = 'required';
  if (next.schedule) {
    next.schedule.restoreReview = true;
    next.schedule.revision++;
  }
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
    syncMaterialWorks(e);
    releaseUnusedClaims(e);
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
  private claimMaterialWork(
    taskId: string,
    e: TaskExecution,
    material: import('../shared/material').MaterialVersion,
  ) {
    if (e.agreementBinding?.goalVersion === e.goalVersion) {
      const rows = [{ taskId: taskId, execution: e }, ...this.others(taskId)];
      const a = boundAgreement(e, rows);
      if (!a || !agreementApplies(e, rows))
        throw Error('AGREEMENT_SCOPE_INVALID');
      const all = rows.flatMap((r) =>
        (r.execution.materialWorks ?? []).map((w) => ({
          taskId: r.taskId,
          work: w,
        })),
      );
      const binding = e.agreementBinding;
      const key = workKey(a, { binding, sha256: material.sha256 });
      const old = all.find((r) => r.work.key === key);
      if (old) {
        e.duplicateWork = {
          taskId: old.taskId,
          workId: old.work.id,
          goalVersion: e.goalVersion,
        };
        e.runId = null;
        e.version++;
        move(e, 'BLOCK');
        e.summary =
          old.work.status === 'complete'
            ? '这份素材在相同约定、目标和期次下已完成，未重复发布。'
            : '这份工作已有所属任务，保留其等待、停止或结果核对状态，未另开一份重做。';
      } else {
        if (
          binding.repeatOf &&
          !all.some(
            (r) =>
              r.work.id === binding.repeatOf &&
              r.work.sha256 === material.sha256 &&
              r.work.status === 'complete',
          )
        )
          throw Error('MATERIAL_REPEAT_CHANGED');
        (e.materialWorks ??= []).push({
          id: randomUUID(),
          key,
          binding: structuredClone(binding),
          materialId: material.id,
          sha256: material.sha256,
          requiresReview:
            a.terms.changedBytes === 'ask' &&
            all.some(
              (r) =>
                r.work.binding.agreementId === a.id &&
                r.work.sha256 !== material.sha256,
            ),
          status: 'pending',
          actionId: null,
          resultId: null,
        });
      }
    }
  }
  private others(taskId: string) {
    return this.db
      .select()
      .from(schema.executions)
      .all()
      .filter((r) => r.taskId !== taskId)
      .map((r) => ({
        taskId: r.taskId,
        execution: executionSchema.parse(r.body),
      }));
  }
  /** 一个登录障碍只保留一个可操作入口；停止拥有者后转给仍自动等待的任务。 */
  private reconcileLogins() {
    const rows = this.db
      .select()
      .from(schema.executions)
      .all()
      .map((r) => ({
        taskId: r.taskId,
        execution: executionSchema.parse(r.body),
      }));
    const ids = new Set(
      rows.map((r) => r.execution.coordination?.loginId).filter(Boolean),
    );
    for (const id of ids) {
      const group = rows.filter(
        (r) => r.execution.coordination?.loginId === id,
      );
      const owner =
        group.find(
          (r) =>
            r.execution.coordination?.checkingLogin &&
            r.execution.intent === 'automatic',
        ) ??
        group.find(
          (r) =>
            r.execution.question?.type === 'login' &&
            r.execution.intent === 'automatic',
        ) ??
        group.find(
          (r) =>
            r.execution.intent === 'automatic' &&
            !r.execution.pauseReason &&
            !r.execution.question &&
            !r.execution.coordination?.checkingLogin &&
            !['complete', 'failed'].includes(r.execution.phase),
        );
      for (const row of group) {
        const e = row.execution,
          c = e.coordination!;
        const before = JSON.stringify(e);
        c.loginOwner = owner?.taskId;
        if (row !== owner && e.question?.type === 'login') delete e.question;
        if (row === owner && !e.question && !c.checkingLogin) {
          const url = this.db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, row.taskId))
            .get()!.url;
          e.question = {
            type: 'login',
            id: randomUUID(),
            goalVersion: e.goalVersion,
            text: '这些任务共用网站登录。请在此网页登录，完成后核对。',
            url,
          };
          e.loginOrigin = c.session.origin;
          invalidateRun(e);
          move(e, 'SUSPEND');
        }
        if (JSON.stringify(e) !== before) this.save(row.taskId, e);
      }
    }
  }
  execute(input: unknown): Record<string, unknown> {
    const c = commandSchema.parse(input);
    let acceptedControl = false;
    const apply = (): Record<string, unknown> => {
      const task = this.db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, c.taskId))
        .get();
      if (!task) throw new Error('TASK_NOT_FOUND');
      let e = this.get(c.taskId);
      if (
        c.kind === 'agreement-propose' ||
        c.kind === 'agreement-accept' ||
        c.kind === 'agreement-revoke' ||
        c.kind === 'agreement-use'
      ) {
        const hash = createHash('sha256')
          .update(JSON.stringify(c))
          .digest('hex');
        const prior = this.db
          .select()
          .from(schema.executionRequests)
          .where(eq(schema.executionRequests.id, c.requestId))
          .get();
        if (prior) {
          if (prior.hash !== hash) throw Error('REQUEST_CONTENT_CONFLICT');
          return { created: false, taskId: prior.taskId };
        }
        if (!e) throw Error('EXECUTION_NOT_FOUND');
        const rows = [
          { taskId: task.id, execution: e },
          ...this.others(task.id),
        ];
        const versions = (e.agreements ??= []);
        const a =
          c.kind === 'agreement-propose'
            ? versions.at(-1)
            : versions.find((a) => a.versionId === c.versionId);
        let resultTaskId = task.id;
        const invalidate = (old: AgreementVersion) => {
          if (old.revokedAt !== null) return;
          old.revokedAt = Date.now();
          old.revocation =
            c.kind === 'agreement-propose' ? c.text : '撤销发布约定';
          for (const row of rows) {
            const other = row.execution;
            if (
              other.agreementBinding?.versionId !== old.versionId ||
              other.phase === 'complete'
            )
              continue;
            invalidateRun(other);
            const possible = other.actions.some(
              (v) =>
                v.goalVersion === other.goalVersion &&
                v.dispatchState === 'possible' &&
                ['unknown', 'dispatched'].includes(v.status),
            );
            if (!possible && other.publication?.agreementVersionId) {
              other.publication.approvalId = null;
              delete other.publication.agreementVersionId;
              delete other.publication.workId;
              other.question = {
                id: randomUUID(),
                type: 'review',
                goalVersion: other.goalVersion,
                url: this.db
                  .select()
                  .from(schema.tasks)
                  .where(eq(schema.tasks.id, row.taskId))
                  .get()!.url,
                text: '发布约定已变更或撤销，请核对本次内容后单独确认。',
              };
            }
            if (other.intent !== 'stopped') move(other, 'SUSPEND');
            other.summary = possible
              ? '约定已撤销；已送出的效果只核对，不回滚或重发。'
              : '约定已变更或撤销，自动工作暂停。';
            this.save(row.taskId, other);
          }
        };
        if (c.kind === 'agreement-propose') {
          if (e.version !== c.expectedVersion)
            throw Error('RECORD_VERSION_CONFLICT');
          validateAgreementTerms(c.terms);
          if (versions.length >= 60) throw Error('EXECUTION_LIMIT');
          if (a) invalidate(a);
          versions.push({
            id: a?.id ?? randomUUID(),
            versionId: randomUUID(),
            version: (a?.version ?? 0) + 1,
            terms: c.terms,
            requestId: c.requestId,
            request: c.text,
            createdAt: Date.now(),
            acceptedAt: null,
            revokedAt: null,
            revocation: null,
          });
          this.db
            .insert(schema.messages)
            .values({
              taskId: task.id,
              role: 'system',
              text: '待接受的发布约定：' + agreementSummary(c.terms),
            })
            .run();
        } else {
          if (a && c.kind === 'agreement-revoke' && a.revokedAt !== null) {
            this.db
              .insert(schema.executionRequests)
              .values({ id: c.requestId, hash, taskId: task.id })
              .run();
            return { created: false, taskId: task.id };
          }
          if (!a || a !== versions.at(-1) || a.revokedAt !== null)
            throw Error('AGREEMENT_EXPIRED');
          if (c.kind === 'agreement-accept') {
            if (a.acceptedAt !== null) throw Error('AGREEMENT_EXPIRED');
            a.acceptedAt = Date.now();
          } else if (c.kind === 'agreement-revoke') invalidate(a);
          else {
            if (!activeAgreement(a)) throw Error('AGREEMENT_EXPIRED');
            if ((a.terms.period === 'per-period') !== !!c.periodKey.trim())
              throw Error('AGREEMENT_PERIOD_REQUIRED');
            const previous = c.repeatOf
              ? rows
                  .flatMap((r) => r.execution.materialWorks ?? [])
                  .find((w) => w.id === c.repeatOf)
              : undefined;
            if (
              c.repeatOf &&
              (!previous ||
                previous.status !== 'complete' ||
                previous.binding.agreementId !== a.id ||
                previous.binding.periodKey !== c.periodKey)
            )
              throw Error('MATERIAL_WORK_UNSETTLED');
            resultTaskId = randomUUID();
            const goal = agreementGoal(a.terms, c.periodKey);
            // 从接受的条款生成委托；模型不能自行选择其它约定或换规则。
            this.db
              .insert(schema.tasks)
              .values({
                id: resultTaskId,
                goal,
                created: Date.now(),
                url: a.terms.entryUrl,
                draft: '',
                hidden: false,
                minimized: false,
                phase: 'loading',
                error: '',
                version: 1,
              })
              .run();
            const next: TaskExecution = {
              modelVersion: 1,
              intent: 'automatic',
              phase: 'queued',
              version: 1,
              intentId: c.requestId,
              goalVersion: 1,
              goal,
              runId: null,
              resource: null,
              recoveryPending: true,
              recoverySource: { url: a.terms.entryUrl, goalVersion: 1 },
              summary: '按已接受的约定取材，先核对已有工作。',
              actions: [],
              agreementBinding: {
                ownerTaskId: task.id,
                agreementId: a.id,
                versionId: a.versionId,
                goalVersion: 1,
                periodKey: c.periodKey,
                repeatIntent: c.repeatOf ? c.requestId : '',
                repeatOf: c.repeatOf,
              },
            };
            if (previous) {
              const original = rows
                .flatMap((r) => r.execution.materials ?? [])
                .find((m) => m.id === previous.materialId);
              if (!original) throw Error('MATERIAL_NOT_AUTHORIZED');
              const material = {
                ...original,
                id: randomUUID(),
                goalVersion: 1,
                selectedAt: Date.now(),
              };
              next.materials = [material];
              if (!agreementApplies(next, rows))
                throw Error('AGREEMENT_SCOPE_INVALID');
              next.materialWorks = [
                {
                  id: randomUUID(),
                  key: workKey(a, {
                    binding: next.agreementBinding!,
                    sha256: material.sha256,
                  }),
                  binding: structuredClone(next.agreementBinding!),
                  materialId: material.id,
                  sha256: material.sha256,
                  requiresReview: false,
                  status: 'pending',
                  actionId: null,
                  resultId: null,
                },
              ];
            }
            this.save(resultTaskId, next);
            this.db
              .insert(schema.messages)
              .values({ taskId: resultTaskId, role: 'user', text: goal })
              .run();
          }
          this.db
            .insert(schema.messages)
            .values({
              taskId: task.id,
              role: 'user',
              text:
                c.kind === 'agreement-accept'
                  ? `接受第 ${a.version} 版发布约定：${agreementSummary(a.terms)}`
                  : c.kind === 'agreement-revoke'
                    ? `撤销第 ${a.version} 版发布约定`
                    : c.repeatOf
                      ? '按约定明确再发一次'
                      : '按约定处理新素材',
            })
            .run();
        }
        e.version++;
        this.save(task.id, e);
        this.db
          .insert(schema.executionRequests)
          .values({ id: c.requestId, hash, taskId: resultTaskId })
          .run();
        return { created: true, taskId: resultTaskId };
      }
      if (c.kind === 'agreement-material') {
        if (
          !e ||
          e.version !== c.expectedVersion ||
          e.intent !== 'automatic' ||
          e.phase !== 'queued' ||
          e.pauseReason ||
          e.restoreReview ||
          !e.agreementBinding ||
          e.materials?.some((m) => m.goalVersion === e!.goalVersion)
        )
          return { created: false };
        if (c.material && !c.failure) {
          if (c.material.goalVersion !== e.goalVersion)
            throw Error('MATERIAL_NOT_AUTHORIZED');
          (e.materials ??= []).push(c.material);
          this.claimMaterialWork(task.id, e, c.material);
        } else if (c.failure && !c.material) {
          move(e, 'BLOCK');
          e.question = {
            id: randomUUID(),
            goalVersion: e.goalVersion,
            text: c.failure,
            url: task.url,
          };
          e.summary = c.failure;
        } else throw Error('INVALID_REQUEST');
        e.version++;
        this.save(task.id, e);
        return { created: true };
      }
      if (c.kind === 'session-invalidated') {
        if (!e?.coordination || !sameSession(e.coordination.session, c.session))
          return { invalidated: false };
        const [oldBoot, oldEpoch] = e.coordination.session.epoch.split(':');
        const [newBoot, newEpoch] = c.session.epoch.split(':');
        if (oldBoot === newBoot && Number(newEpoch) <= Number(oldEpoch))
          return { invalidated: false };
        e.coordination.session = c.session;
        if (e.coordination.status !== 'login')
          e.coordination.status = 'unverified';
        e.coordination.refreshRequired = true;
        if (
          e.intent === 'automatic' &&
          ['queued', 'checking', 'running'].includes(e.phase) &&
          !e.pauseReason &&
          !e.question
        )
          queueRecovery(
            e,
            task.url,
            '网站会话发生变化，先重新核对账号、目标权限和已有结果。',
          );
        else invalidateRun(e);
        this.save(task.id, e);
        return { invalidated: true };
      }
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
          if (
            JSON.stringify(
              c.fields?.map(({ id, name, frameUrl }) => ({
                id,
                name,
                frameUrl,
              })),
            ) !==
            JSON.stringify(
              p.fields?.map(({ id, name, frameUrl }) => ({
                id,
                name,
                frameUrl,
              })),
            )
          )
            throw Error('PARTICIPATION_EXPIRED');
          publicationSchema.strip().parse({
            ...p,
            content: c.content,
            fields: c.fields,
          });
          editArticle(e, c.content);
          p.content = c.content;
          if (c.fields) p.fields = c.fields;
          e.version++;
          p.revision++;
          p.approvalId = null;
          delete p.agreementVersionId;
          delete p.workId;
          q.id = randomUUID();
        } else {
          publicationArticle(e, p);
          p.approvalId = q.id;
          delete p.agreementVersionId;
          delete p.workId;
          const use = currentWorkflow(e);
          if (use)
            use.approved = {
              id: q.id,
              content: p.content,
              ...(p.fields ? { fields: p.fields } : {}),
            };
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
        if (e.coordination?.decisionQuestionId === question.id) {
          delete e.coordination.changedBy;
          delete e.coordination.decisionQuestionId;
        }
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
          !pending.targetCreation &&
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
        const agreement = boundAgreement(e, [
          { taskId: task.id, execution: e },
          ...this.others(task.id),
        ]);
        // 刚建立的约定任务尚无网页效果或固定目标，允许入口正常跳转到同站编辑页。
        // 一旦已有动作或准备事实，继续采用原有精确 URL 恢复边界。
        const initialAgreementPage = !!(
          agreement &&
          activeAgreement(agreement) &&
          e.agreementBinding?.goalVersion === e.goalVersion &&
          !e.actions.length &&
          !e.preparation?.length &&
          e.recoverySource?.url === agreement.terms.entryUrl &&
          new URL(task.url).origin === new URL(agreement.terms.entryUrl).origin
        );
        if (
          !e.recoverySource ||
          (e.recoverySource.url !== task.url && !initialAgreementPage) ||
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
          delete e.agreementBinding;
          delete e.duplicateWork;
          if (!c.text?.trim()) throw new Error('INVALID_REQUEST');
          delete e.publication;
          delete e.loginOrigin;
          if (e.coordination) {
            e.coordination = {
              session: e.coordination.session,
              status: 'unverified',
            };
          }
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
        if (e.coordination) e.coordination.checkingLogin = !!c.loginQuestionId;
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
        if (c.kind === 'created-target-observed') {
          const action = e.actions.find((a) => a.id === c.actionId);
          if (
            e.version !== c.expectedVersion ||
            e.intent !== 'automatic' ||
            e.phase !== 'paused' ||
            e.pauseReason !== 'page-change' ||
            e.question ||
            e.restoreReview ||
            e.loginOrigin ||
            e.publication ||
            task.url !== c.source.url ||
            task.phase !== 'manual' ||
            !action?.targetCreation ||
            action.discoveredTarget ||
            action.goalVersion !== e.goalVersion ||
            action.status !== 'unknown' ||
            e.preparation?.some(
              (f) => f.goalVersion === e.goalVersion && f.kind === 'target',
            ) ||
            e.observedAnomalies?.some((o) => o.goalVersion === e.goalVersion) ||
            e.actions.some(
              (a) =>
                a !== action &&
                ['reserved', 'unknown', 'dispatched'].includes(a.status),
            )
          )
            return { created: false };
          if (!creationFieldsMatch(action.targetCreation, c.source))
            throw Error('EXECUTION_EVIDENCE_MISSING');
          const source = pageSourceSchema.strip().parse(c.source);
          const targetFactId = randomUUID(),
            draftFactId = randomUUID();
          action.discoveredTarget = {
            source,
            binding: c.binding,
            links: c.source.links ?? [],
            controls: c.source.controls ?? [],
            evidence: [action.targetCreation.destination],
            targetFactId,
            draftFactId,
          };
          action.status = 'confirmed';
          action.resultSource = source;
          action.resultLinks = c.source.links ?? [];
          action.evidence = ['已只读核对创建后的编辑目标和冻结字段'];
          if (!validDiscoveredTarget(action))
            throw Error('PREPARATION_TARGET_CHANGED');
          executionSchema.parse(e);
          for (const [kind, id] of [
            ['target', targetFactId],
            ['draft', draftFactId],
          ] as const)
            (e.preparation ??= []).push({
              kind,
              id,
              url: source.url,
              materialId: null,
              goalVersion: e.goalVersion,
              actionId: action.id,
              source,
              verification: 'page-observed',
              evidence: action.evidence,
            });
          e.summary =
            '已核对新建草稿并保存目标，未重复创建。页面仍暂停；明确继续后核对现场并续做剩余工作。';
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'publication-result-entry') {
          const action = e.actions.find((a) => a.id === c.actionId);
          if (
            e.version !== c.expectedVersion ||
            e.intent !== 'automatic' ||
            e.phase !== 'paused' ||
            e.pauseReason !== 'page-change' ||
            e.question ||
            e.restoreReview ||
            e.loginOrigin ||
            task.url !== c.source.url ||
            task.phase !== 'manual' ||
            !action ||
            action.goalVersion !== e.goalVersion ||
            action.status !== 'unknown' ||
            action.dispatchState !== 'possible' ||
            action.effect !== 'publication' ||
            !action.submission ||
            action.submission.recovery ||
            !e.publication ||
            !samePublication(e.publication, action.submission.publication) ||
            e.publication.approvalId !== action.publicationApprovalId ||
            e.observedAnomalies?.some((o) => o.goalVersion === e.goalVersion) ||
            e.actions.some(
              (a) =>
                a !== action &&
                ['reserved', 'unknown', 'dispatched'].includes(a.status),
            )
          )
            return { created: false };
          const checkpoint = discoverRecovery(e, action, c.source, c.binding);
          if (action.discoveredRecovery) {
            if (
              JSON.stringify(action.discoveredRecovery) !==
              JSON.stringify(checkpoint)
            )
              throw Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          action.discoveredRecovery = checkpoint;
          executionSchema.parse(e);
          this.save(task.id, e);
          return { created: true };
        }
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
            ((e.phase === 'queued' && !e.pauseReason) ||
              (e.phase === 'paused' &&
                e.pauseReason === 'page-change' &&
                !!action.discoveredRecovery)) &&
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
            const processing = e.materialProcessing?.find(
              (p) => p.actionId === action.id && p.workId,
            );
            if (processing && processing.status !== 'complete') {
              processing.status =
                c.check.status === 'verified' &&
                !e.observedAnomalies?.some(
                  (o) => o.goalVersion === action.goalVersion,
                )
                  ? 'complete'
                  : 'unknown';
              processing.resultId = c.check.id;
            }
            this.save(task.id, e);
            return { created: true, historical: true };
          }
          if (recovery) {
            recordPublicationResult(task.id, e, c.check, action);
            if (c.check.status === 'verified')
              adoptWorkflow(e, this.others(task.id));
            if (c.check.status === 'verified') {
              move(e, 'REVIEW_COMPLETE');
              delete e.pauseReason;
            } else if (e.phase !== 'paused') move(e, 'WAIT');
            delete e.recoveryPending;
            delete e.recoverySource;
            e.runId = null;
            e.summary =
              c.check.status === 'verified'
                ? '已从可靠保存的位置核对发布结果和附件，无需再次提交。'
                : c.check.failure === 'material'
                  ? '本机固定素材缺失或损坏，网站核对证据已保留，暂停且不重复提交。'
                  : '已只读核对原结果位置，证据仍不足；已有提交保持未知，不重复发送。';
            if (c.check.status === 'verified') e.resource = null;
            this.save(task.id, e);
            return { created: true };
          }
        }
        if (c.kind === 'navigation-resolved') {
          const r = c.resolution;
          const a = e.actions.find((a) => a.id === r.proof.actionId);
          if (
            e.version !== c.expectedVersion ||
            e.intent !== 'automatic' ||
            e.pauseReason !== 'page-change' ||
            e.phase !== 'paused' ||
            e.question ||
            e.restoreReview ||
            e.loginOrigin ||
            e.recoveryPending ||
            e.publication ||
            e.preparation?.length ||
            (e.coordination &&
              (e.coordination.status !== 'ready' ||
                e.coordination.refreshRequired)) ||
            e.observedAnomalies?.some((a) => a.goalVersion === e.goalVersion) ||
            !a ||
            a.goalVersion !== e.goalVersion ||
            a.status !== 'unknown' ||
            r.proof.taskId !== task.id ||
            task.url !== r.source.url ||
            task.phase !== 'manual' ||
            e.actions.some(
              (other) =>
                other !== a &&
                ['reserved', 'unknown', 'dispatched'].includes(other.status),
            )
          )
            return { recovered: false };
          a.status = 'confirmed';
          a.navigationResolution = r;
          a.resultSource = r.source;
          a.evidence = [r.source.url];
          // schema验证完整链接、原生代次和新页面关联；任何缺失保持事务回滚。
          executionSchema.parse(e);
          delete e.pauseReason;
          e.version++;
          e.runId = null;
          move(e, 'QUEUE');
          e.summary = '已核对链接到达的新页面，继续剩余工作。';
          this.save(task.id, e);
          return { recovered: true };
        }
        if (c.kind === 'action-navigation') {
          const a = e.actions.find((a) => a.id === c.actionId);
          if (
            !a ||
            a.runId !== c.runId ||
            a.dispatchState !== 'possible' ||
            a.status === 'cancelled' ||
            a.status === 'reserved' ||
            a.binding.targetId !== c.navigation.targetId ||
            a.binding.generation !== c.navigation.sourceGeneration
          )
            throw Error('ACTION_NOT_OWNED');
          if (a.navigation) {
            if (JSON.stringify(a.navigation) !== JSON.stringify(c.navigation))
              throw Error('REQUEST_CONTENT_CONFLICT');
            return { recorded: false };
          }
          a.navigation = c.navigation;
          // 迟到证据只补事实，不改意图、状态、确认或结果，也不代表点击成功。
          this.save(task.id, e);
          return { recorded: true };
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
        if (c.kind === 'workflow-repair') {
          if (
            e.coordination &&
            (e.coordination.status !== 'ready' ||
              e.coordination.refreshRequired)
          )
            throw Error('COORDINATION_STALE');
          const use = currentWorkflow(e);
          const prior = currentRepair(e);
          if (prior) {
            if (prior.useId !== c.useId)
              throw Error('REQUEST_CONTENT_CONFLICT');
            if (
              prior.id === c.id &&
              (prior.runId !== c.runId ||
                prior.reason !== c.reason ||
                JSON.stringify(prior.source) !==
                  JSON.stringify(pageSourceSchema.strip().parse(c.source)))
            )
              throw Error('REQUEST_CONTENT_CONFLICT');
            return { created: false };
          }
          if (
            !use ||
            use.id !== c.useId ||
            c.source.truncated ||
            c.source.url !== use.targetUrl ||
            c.source.url !== task.url ||
            e.loginOrigin ||
            e.observedAnomalies?.some((a) => a.goalVersion === e.goalVersion) ||
            e.actions.some(
              (a) =>
                ['reserved', 'dispatched', 'unknown'].includes(a.status) &&
                !a.returned,
            )
          )
            throw Error('WORKFLOW_NOT_APPLICABLE');
          let reason: string | undefined;
          try {
            replayStep(e, c.source);
          } catch (error) {
            reason = error instanceof Error ? error.message : '';
          }
          if (reason !== c.reason) throw Error('WORKFLOW_REPAIR_NOT_NEEDED');
          (e.workflowRepairs ??= []).push({
            id: c.id,
            useId: use.id,
            goalVersion: e.goalVersion,
            runId: c.runId,
            fromIndex: e.actions.filter(
              (a) =>
                a.goalVersion === e.goalVersion && a.status !== 'cancelled',
            ).length,
            source: pageSourceSchema.strip().parse(c.source),
            reason: c.reason,
          });
          e.summary =
            '网页做法已变化，正在按本次目标和确认重新观察；核对成功后才记住新做法。';
          this.save(task.id, e);
          return { created: true };
        }
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
            !availableWorkflows([
              ...this.others(task.id),
              { execution: e },
            ]).some(
              (w) =>
                w.version === c.choice.version && w.sha256 === c.choice.sha256,
            ) ||
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
          if (
            !publicationSchema.safeParse({
              content: c.choice.content,
              destination: c.choice.destination,
              fields: c.choice.fields,
            }).success ||
            JSON.stringify(
              c.choice.fields?.map(({ id, name, frameUrl }) => ({
                id,
                name,
                frameUrl,
              })),
            ) !==
              JSON.stringify(
                workflow.fields?.map(({ id, name, frameUrl }) => ({
                  id,
                  name,
                  frameUrl,
                  ...(frameUrl === workflow.recovery.targetUrl
                    ? { frameUrl: c.source.url }
                    : {}),
                })),
              )
          )
            throw Error('WORKFLOW_NOT_APPLICABLE');
          const use = workflowUseSchema.parse({
            id: randomUUID(),
            goalVersion: e.goalVersion,
            workflow,
            materialId: material[0]!.id,
            targetUrl: c.source.url,
            content: c.choice.content,
            ...(c.choice.fields ? { fields: c.choice.fields } : {}),
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
          if (c.check.status === 'verified')
            adoptWorkflow(e, this.others(task.id));
          move(e, c.check.status === 'verified' ? 'FINISH' : 'WAIT');
          e.summary =
            c.check.status === 'verified'
              ? '已核对发布结果和附件内容。' +
                (e.workflowDecisions?.at(-1)?.status === 'conflict'
                  ? '本次做法已保存；已有另一份更新，兼容性需在后续任务重新验证。'
                  : e.workflowDecisions?.at(-1)?.status === 'adopted'
                    ? currentRepair(e)
                      ? '已适应网页变化并记住验证过的新做法。'
                      : '已保存本次学到的做法；新输入仍需验证。'
                    : '步骤证据不足，尚未保存可复用流程。')
              : '发布结果尚未核实，已保留目标和核对记录，不重复提交。';
          e.runId = null;
          if (c.check.status === 'verified') e.resource = null;
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'content-source') {
          if (
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('EXECUTION_RESULT_UNKNOWN');
          if (
            e.publication?.approvalId ||
            c.source.goalVersion !== e.goalVersion ||
            !e.materials?.some(
              (m) =>
                m.id === c.source.materialId &&
                m.sha256 === c.source.materialSha256 &&
                m.goalVersion === e.goalVersion,
            ) ||
            contentSourceHash(c.source) !== c.source.sha256 ||
            JSON.stringify({
              goal: c.source.requirements.goal,
              answers: c.source.requirements.answers,
            }) !== JSON.stringify(contentRequirements(e))
          )
            throw Error('ARTICLE_BINDING_MISMATCH');
          if ((e.contentSources?.length ?? 0) >= 60)
            throw Error('EXECUTION_LIMIT');
          (e.contentSources ??= []).push(c.source);
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'article-generated') {
          const source = e.contentSources?.find(
            (s) => s.id === c.sourceId && s.goalVersion === e.goalVersion,
          );
          const call = this.db
            .select()
            .from(schema.modelCalls)
            .where(eq(schema.modelCalls.id, c.modelCallId))
            .get();
          if (
            !source ||
            e.publication ||
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            ) ||
            !call ||
            call.taskId !== task.id ||
            call.phase !== 'complete' ||
            call.usageKind !== 'material-content' ||
            call.hash !== contentCallHash(task.id, source) ||
            JSON.stringify(
              z
                .object({ article: articleDraftSchema })
                .parse(JSON.parse(call.output)).article,
            ) !== JSON.stringify(c.draft)
          )
            throw Error('ARTICLE_BINDING_MISMATCH');
          if ((e.articles?.length ?? 0) >= 60) throw Error('EXECUTION_LIMIT');
          const article = generatedArticle(e, source, c.draft, c.modelCallId);
          (e.articles ??= []).push(article);
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
          this.claimMaterialWork(task.id, e, c.material);
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
          const use = currentWorkflow(e);
          if (
            use &&
            c.facts.some((f) =>
              f.kind === 'upload'
                ? f.materialId !== use.materialId
                : f.url !== use.targetUrl,
            )
          )
            throw Error('WORKFLOW_SCOPE_CHANGE');
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
            if (action?.targetCreation && !action.discoveredTarget)
              throw Error('EXECUTION_RESULT_UNKNOWN');
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
                (use &&
                  (c.source.links?.filter((l) => l.url === fact.url).length !==
                    1 ||
                    c.source.links?.filter(
                      (l) =>
                        l.name ===
                        c.source.links?.find((l) => l.url === fact.url)?.name,
                    ).length !== 1)) ||
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
        if (c.kind === 'coordination-observed') {
          if (c.source.url !== task.url) throw Error('EXECUTION_PAGE_CHANGED');
          if (
            e.coordination?.refreshRequired &&
            e.coordination.source?.generation === c.source.generation
          )
            throw Error('COORDINATION_STALE');
          const accepted = observeRelation(
            e,
            c.session,
            c.source,
            c.proposal,
            c.authenticated,
          );
          if (c.proposal)
            for (const row of this.others(task.id)) {
              const other = row.execution,
                relation = other.coordination;
              if (
                !relation?.account ||
                !sameSession(relation.session, c.session) ||
                sameAccount(relation.account, c.proposal.account) ||
                ['complete', 'failed'].includes(other.phase)
              )
                continue;
              relation.status = 'unverified';
              relation.refreshRequired = true;
              if (
                other.intent === 'automatic' &&
                !other.pauseReason &&
                !other.question &&
                ['queued', 'checking', 'running'].includes(other.phase)
              )
                queueRecovery(
                  other,
                  this.db
                    .select()
                    .from(schema.tasks)
                    .where(eq(schema.tasks.id, row.taskId))
                    .get()!.url,
                  '共享网站的账号依据已改变，先重新核对原账号和目标。',
                );
              else invalidateRun(other);
              this.save(row.taskId, other);
            }
          if (!accepted) {
            if (e.coordination) e.coordination.checkingLogin = false;
            invalidateRun(e);
            move(e, 'BLOCK');
            e.summary =
              '当前账号或目标权限与原依据不一致，已暂停。请切回原账号并明确继续，或修改委托明确新的账号与目标。';
          }
          if (e.coordination) delete e.coordination.refreshRequired;
          this.save(task.id, e);
          return { observed: true };
        }
        if (c.kind === 'verified-login') {
          if (
            !e.loginOrigin ||
            c.source.url !== task.url ||
            new URL(task.url).origin !== e.loginOrigin ||
            !c.evidence.every((v) => c.source.text.includes(v))
          )
            throw Error('EXECUTION_EVIDENCE_MISSING');
          if (e.coordination) {
            if (e.coordination.status !== 'ready' || !e.coordination.account)
              throw Error('COORDINATION_EVIDENCE_MISSING');
            const loginId = e.coordination.loginId;
            for (const row of this.others(task.id)) {
              const other = row.execution;
              if (!loginId || other.coordination?.loginId !== loginId) continue;
              delete other.coordination.loginId;
              delete other.coordination.loginOwner;
              delete other.coordination.checkingLogin;
              other.coordination.status = 'unverified';
              delete other.coordination.source;
              delete other.loginOrigin;
              if (other.question?.type === 'login') delete other.question;
              if (
                other.intent === 'automatic' &&
                !other.pauseReason &&
                !other.question &&
                !['complete', 'failed'].includes(other.phase)
              )
                queueRecovery(
                  other,
                  this.db
                    .select()
                    .from(schema.tasks)
                    .where(eq(schema.tasks.id, row.taskId))
                    .get()!.url,
                  '共享登录已恢复；分别核对原任务和已有结果后再安排，原确认仍须有效。',
                );
              this.save(row.taskId, other);
            }
            delete e.coordination.loginId;
            delete e.coordination.loginOwner;
            delete e.coordination.checkingLogin;
          }
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
            c.workflowScopeChange &&
            (!currentRepair(e) || c.type || c.publication)
          )
            throw Error('WORKFLOW_NOT_APPLICABLE');
          if (
            currentWorkflow(e) &&
            c.publication &&
            !withinWorkflowScope(e, {
              decision: 'review',
              summary: c.text,
              action: null,
              evidence: [],
              previous: null,
              publication: c.publication,
            })
          )
            throw Error('WORKFLOW_SCOPE_CHANGE');
          if (
            c.type !== 'login' &&
            !c.workflowScopeChange &&
            e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            throw Error('EXECUTION_RESULT_UNKNOWN');
          if (c.type === 'login')
            e.loginOrigin ??= e.publication?.origin ?? new URL(c.url).origin;
          if (c.type === 'login' && e.coordination) {
            const related = this.others(task.id).filter(
              (r) =>
                r.execution.coordination &&
                sameSession(
                  r.execution.coordination.session,
                  e.coordination!.session,
                ),
            );
            const id =
              related.find((r) => r.execution.coordination?.loginId)?.execution
                .coordination?.loginId ?? c.questionId;
            e.coordination.status = 'login';
            e.coordination.loginId = id;
            e.coordination.checkingLogin = false;
            for (const row of related) {
              const other = row.execution;
              if (['complete', 'failed'].includes(other.phase)) continue;
              other.coordination!.status = 'login';
              other.coordination!.loginId = id;
              other.loginOrigin = e.loginOrigin;
              invalidateRun(other);
              if (
                other.intent === 'automatic' &&
                !other.pauseReason &&
                !other.question
              ) {
                move(other, 'QUEUE');
                other.recoveryPending = true;
                other.recoverySource = {
                  url: this.db
                    .select()
                    .from(schema.tasks)
                    .where(eq(schema.tasks.id, row.taskId))
                    .get()!.url,
                  goalVersion: other.goalVersion,
                };
                other.summary = '等待共享网站登录；可在同一个登录提示中处理。';
              }
              this.save(row.taskId, other);
            }
          }
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
            if (
              canAutoApprove(e, [
                { taskId: task.id, execution: e },
                ...this.others(task.id),
              ])
            ) {
              e.publication.approvalId = randomUUID();
              e.publication.agreementVersionId = e.agreementBinding!.versionId;
              e.publication.workId = e.materialWorks!.find(
                (w) => w.binding.goalVersion === e.goalVersion,
              )!.id;
              const use = currentWorkflow(e);
              if (use)
                use.approved = {
                  id: e.publication.approvalId,
                  content: e.publication.content,
                  ...(e.publication.fields
                    ? { fields: e.publication.fields }
                    : {}),
                };
              e.summary =
                '本次素材、目标和内容要求符合已接受的发布约定，继续核对后发布。';
              this.save(task.id, e);
              return { created: true, autoApproved: true };
            }
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
          if (c.coordinationDecision && e.coordination?.changedBy && !c.type)
            e.coordination.decisionQuestionId = e.question.id;
          e.version++;
          e.runId = null;
          if (
            !e.actions.some((a) =>
              ['reserved', 'dispatched', 'unknown'].includes(a.status),
            )
          )
            e.resource = null;
          move(e, 'BLOCK');
          e.summary = c.text;
          // 提问原文已随本轮模型回复进入所属会话。这里只保存待答事实。
          this.save(task.id, e);
          return { created: true };
        }
        if (c.kind === 'dispatch') {
          assertAgreementAuthority(e, [
            { taskId: task.id, execution: e },
            ...this.others(task.id),
          ]);
          const a = e.actions.find((a) => a.id === c.id);
          if (!a || a.runId !== c.runId || a.status !== 'reserved')
            return { permitted: false };
          if (
            e.coordination &&
            (!a.coordination ||
              e.coordination.status !== 'ready' ||
              e.coordination.session.epoch !== a.coordination.session.epoch ||
              !sameSession(e.coordination.session, a.coordination.session) ||
              !e.resourceClaims?.some(
                (r) =>
                  r.status === 'held' &&
                  r.id === a.coordination!.claimId &&
                  r.runId === c.runId,
              ) ||
              resourceConflict(e, this.others(task.id)))
          )
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
          if (e.duplicateWork?.goalVersion === e.goalVersion)
            throw Error('MATERIAL_WORK_EXISTS');
          if (
            e.agreementBinding?.goalVersion === e.goalVersion &&
            !activeAgreement(
              boundAgreement(e, [
                { taskId: task.id, execution: e },
                ...this.others(task.id),
              ]),
            ) &&
            (!e.publication?.approvalId || e.publication.agreementVersionId)
          )
            throw Error('AGREEMENT_EXPIRED');
          assertAgreementAuthority(e, [
            { taskId: task.id, execution: e },
            ...this.others(task.id),
          ]);
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
            const repair = currentRepair(e);
            if (
              !use ||
              !step ||
              c.workflowStep?.useId !== use.id ||
              c.workflowStep.index !== index ||
              c.source.url !== use.targetUrl ||
              c.source.truncated ||
              c.effect !== step.effect ||
              (repair
                ? c.workflowStep.repairId !== repair.id ||
                  !sameWorkflowOperation(use, index, c.action, c.effect) ||
                  !observedControl(c.action, c.source) ||
                  !c.evidence?.length
                : c.workflowStep.repairId ||
                  !step.before.evidence.every((s) =>
                    c.source.text.includes(s),
                  ) ||
                  JSON.stringify(c.action) !==
                    JSON.stringify(reboundAction(use, index)) ||
                  (c.source.controls && !observedControl(c.action, c.source)))
            )
              throw Error('WORKFLOW_NOT_APPLICABLE');
          }
          if (e.loginOrigin) throw Error('PARTICIPATION_REQUIRED');
          if (e.coordination?.changedBy) throw Error('PARTICIPATION_REQUIRED');
          if (e.coordination) {
            if (
              e.coordination.status !== 'ready' ||
              e.coordination.source?.fingerprint !== c.source.fingerprint ||
              e.coordination.source.url !== c.source.url ||
              e.coordination.source.generation !== c.source.generation
            )
              throw Error('COORDINATION_STALE');
            const conflict = resourceConflict(e, this.others(task.id));
            if (conflict) {
              e.coordination.waitFor = conflict;
              e.coordination.refreshRequired = true;
              invalidateRun(e);
              move(e, 'QUEUE');
              e.summary =
                '另一项任务正在使用同一目标，或尚不能确认目标独立。等待后会重新核对，不覆盖已有内容。';
              this.save(task.id, e);
              return { created: false };
            }
          }
          if (e.observedAnomalies?.some((o) => o.goalVersion === e.goalVersion))
            throw Error('EXECUTION_RESULT_UNKNOWN');
          if (
            c.action.kind === 'select' &&
            (c.action.target.role !== 'combobox' ||
              c.action.target.within ||
              !c.source.controls ||
              c.source.truncated ||
              !observedControl(c.action, c.source))
          )
            throw Error('EXECUTION_SELECTION_UNVERIFIED');
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
          if (
            c.targetCreation &&
            (effect !== 'draft' ||
              c.action.kind !== 'click' ||
              p ||
              c.publication ||
              c.approvalId ||
              c.workflowStep ||
              preparationTarget ||
              !creationFieldsMatch(c.targetCreation, c.source))
          )
            throw Error('PREPARATION_TARGET_CHANGED');
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
              p.fields &&
              c.action.kind === 'fill' &&
              (c.source.truncated || !observedControl(c.action, c.source))
            )
              throw Error('EXECUTION_EVIDENCE_MISSING');
            if (
              (c.action.kind === 'fill' &&
                !publicationFillBinding(p, c.action)) ||
              (c.action.kind === 'select' &&
                c.action.value !== p.destination) ||
              c.action.kind === 'check'
            )
              throw Error('PARTICIPATION_REQUIRED');
          }
          // 首版窄发布只允许一次提交点击，且派发前必须能在所属网页核对去向和全文。
          if (p && c.action.kind === 'click') {
            verifyPublicationFields(p, c.source);
            verifyCurrentSelections(
              e.actions.filter(
                (a) =>
                  a.goalVersion === e.goalVersion && a.status === 'confirmed',
              ),
              c.source,
            );
            if (
              !publicationParts(p).every((part) =>
                c.source.text.includes(part),
              ) ||
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
            ...(hasMaterial &&
            effect === 'publication' &&
            p?.fields &&
            c.action.kind === 'click'
              ? { fieldResults: verifyPublicationFields(p, c.source) }
              : {}),
            ...(e.coordination ? { coordination: acquireResource(e) } : {}),
            ...(c.workflowStep ? { workflowStep: c.workflowStep } : {}),
            targetCreation: c.targetCreation,
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
                workId: e.materialWorks?.find(
                  (w) => w.binding.goalVersion === e.goalVersion,
                )?.id,
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
          if (a.targetCreation) throw Error('EXECUTION_RESULT_UNKNOWN');
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
          if (a.action.kind === 'select') {
            if (a.source.url !== c.source.url)
              throw Error('EXECUTION_SELECTION_UNVERIFIED');
            a.selectionResult = selectedControl(a.action, c.source);
          }
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
      if (c.session) {
        if (c.session.origin !== new URL(task.url).origin)
          throw Error('COORDINATION_STALE');
        const old = e.coordination;
        if (!old || !sameSession(old.session, c.session))
          e.coordination = { session: c.session, status: 'unverified' };
        else if (old.session.epoch !== c.session.epoch) {
          old.session = c.session;
          if (old.status !== 'login') old.status = 'unverified';
          delete old.source;
        }
        const login = this.others(task.id).find(
          (r) =>
            r.execution.coordination?.loginId &&
            sameSession(r.execution.coordination.session, c.session!),
        );
        if (login && !e.coordination!.checkingLogin) {
          e.coordination!.status = 'login';
          e.coordination!.loginId = login.execution.coordination!.loginId;
          e.loginOrigin = c.session.origin;
          e.summary = '等待共享网站登录；可在同一个登录提示中处理。';
          this.save(task.id, e);
          return { claimed: false };
        }
        if (
          e.coordination!.status === 'login' &&
          !e.coordination!.checkingLogin
        )
          return { claimed: false };
        if (
          e.coordination!.waitFor &&
          resourceConflict(e, this.others(task.id))
        )
          return { claimed: false };
        const previousOwner = this.others(task.id).find(
          (r) => r.taskId === e.coordination!.waitFor,
        )?.execution;
        if (
          previousOwner?.actions.some(
            (a) =>
              a.status !== 'cancelled' &&
              previousOwner.resourceClaims?.some(
                (r) =>
                  r.id === a.coordination?.claimId &&
                  r.origin === c.session!.origin &&
                  (!r.targetUrl ||
                    !e.coordination!.target ||
                    r.targetUrl === e.coordination!.target.url),
              ),
          )
        )
          e.coordination!.changedBy = e.coordination!.waitFor;
        delete e.coordination!.waitFor;
      }
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
            !c.session &&
            x.resource === resource &&
            (['checking', 'running'].includes(x.phase) ||
              x.actions.some((a) =>
                ['reserved', 'dispatched', 'unknown'].includes(a.status),
              )),
        )
      )
        return { claimed: false };
      e.runId = c.runId;
      e.resource = c.session ? null : resource;
      move(e, 'CLAIM');
      e.summary = '正在核对当前页面与已有结果。';
      this.save(task.id, e);
      return { claimed: true, execution: e };
    };
    const result = this.db.transaction(() => {
      const result = apply();
      this.reconcileLogins();
      return result;
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
