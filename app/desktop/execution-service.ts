import {
  formChainEpoch,
  type FormChainResolution,
  type HostFormChain,
} from '../shared/form-navigation-chain';
import { uploadedLink } from '../shared/upload-readiness';
import { creationFieldsMatch } from '../shared/target-creation';
import type {
  ActionNavigationEvent,
  LinkNavigationProof,
  FormNavigationProof,
} from '../shared/action-navigation';
import {
  agreementUICommandSchema,
  type AgreementUICommand,
} from '../shared/agreement';
import {
  scheduleUICommandSchema,
  type ScheduleUICommand,
  type ScheduleTerms,
} from '../shared/schedule';
import type { AgreementTerms } from '../shared/agreement';
import {
  verifyAttachment,
  verifyPublication,
  verifyRecoveredPublication,
} from './publication-verifier';
import {
  samePublication,
  type DownloadCheck,
  type Publication,
} from '../shared/publication';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { snapshotSchema, type WorkspaceSnapshot } from '../shared/contracts';
import {
  actionFactSchema,
  executionIntentSchema,
  nextStepSchema,
  type ExecutionIntent,
  type ParticipationReply,
  type ParticipationDecision,
  type TaskExecution,
  type NextStep,
  type ActionFact,
  type WebAction,
  type ExecutionPauseReason,
  pauseDescription,
  type SystemCondition,
  systemConditionLabel,
} from '../shared/execution';
import { pageSourceSchema, type PageObservation } from '../shared/model';
import { materialFailureMessage } from '../shared/material';
import {
  currentWorkflow,
  replayStep,
  reboundAction,
} from '../shared/workflow-replay';
import { currentRepair, withinWorkflowScope } from '../shared/workflow-repair';
import { availableWorkflows } from '../shared/workflow-catalog';
import {
  contentSourceSchema,
  excelFailureMessage,
  type ContentSource,
  type ArticleVersion,
} from '../shared/article';
import type { LearnedWorkflow } from '../shared/workflow';
import {
  sameSession,
  sameAccount,
  type SessionContext,
} from '../shared/coordination';

export type BoundObservation = {
  session?: SessionContext;
  observation: PageObservation;
  binding: { targetId: string; generation: number };
};
export type ProposalInput = {
  scheduleRequest?: {
    text: string;
    current: ScheduleTerms | null;
    now: string;
    zone: string;
  };
  publishingAgreement?: AgreementTerms;
  agreementRequest?: { text: string; current: AgreementTerms | null };
  contentSource?: ContentSource;
  article?: ArticleVersion;
  repair?: {
    parentVersion: string;
    fromIndex: number;
    index: number;
    targetUrl: string;
    materialId: string;
    content: string;
    fields?: Publication['fields'];
    destination: string;
    operation: { action: WebAction; effect: NextStep['effect'] } | null;
    resultRule: LearnedWorkflow['resultRule'];
  };
  coordination?: TaskExecution['coordination'];
  workflows?: Pick<
    LearnedWorkflow,
    'taskId' | 'version' | 'sha256' | 'goal' | 'applicability' | 'fields'
  >[];
  taskId: string;
  runId: string;
  goal: string;
  observation: PageObservation;
  pending: ActionFact | null;
  publication?: TaskExecution['publication'];
  loginOrigin?: string;
  clarifications?: { question: string; answer: string }[];
  history: ActionFact[];
  materials?: TaskExecution['materials'];
  preparation?: TaskExecution['preparation'];
  signal: AbortSignal;
  permit?: <T>(send: () => T) => T;
};
export type WebActionJob = {
  taskId: string;
  runId: string;
  actionId: string;
  action: WebAction;
  targetCreation?: ActionFact['targetCreation'];
  source: PageObservation;
  binding: BoundObservation['binding'];
  signal: AbortSignal;
  qualified: () => boolean;
};
type Job = {
  taskId: string;
  runId: string;
  version: number;
  inputEpoch: number;
  systemGeneration: number;
  abort: AbortController;
  work: Promise<void>;
};
const receipt = z
  .object({
    state: snapshotSchema,
    created: z.boolean().optional(),
    current: z.boolean().optional(),
    claimed: z.boolean().optional(),
    permitted: z.boolean().optional(),
    autoApproved: z.boolean().optional(),
    recovered: z.boolean().optional(),
  })
  .passthrough();
/** 任务意图与派发公开入口。记录进程之外保留即时阻断，所有等待之后重新核对。 */
export class ExecutionService {
  private planTick = false;
  private readonly planMutations = new Set<string>();
  private available = true;
  private closing = false;
  private pumping: Promise<void> | null = null;
  private wake = false;
  private recordSequence = 0;
  private latestRecordSuccess = 0;
  private latestRecordFailure = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly blocked = new Map<
    string,
    {
      saved: boolean;
      message: string;
      reason?: ExecutionPauseReason;
      outage?: boolean;
      control?: ExecutionIntent['intent'];
    }
  >();
  private readonly intents = new Map<string, number>();
  private readonly pendingIntents = new Set<string>();
  private workspaceUnsettled = new Set<string>();
  private readonly systemConditions = new Set<SystemCondition>();
  private systemGeneration = 0;
  private restoring = false;
  private upgradeHeld = false;
  private readonly pendingReplies = new Set<Promise<unknown>>();
  private readonly reviews = new Map<
    string,
    { abort: AbortController; work: Promise<void>; epoch?: number }
  >();
  private readonly interruptions = new Set<Promise<unknown>>();
  private readonly resultDiscoveries = new Set<string>();
  private readonly navigationBlocks = new Map<
    string,
    FormChainResolution['control']
  >();
  private readonly chainDiscoveries = new Set<string>();
  private readonly formProofs = new Map<string, FormNavigationProof>();
  private readonly linkProofs = new Map<string, LinkNavigationProof>();
  private readonly navigationRecoveries = new Set<string>();
  private readonly pendingNavigations = new Set<Promise<unknown>>();
  private readonly sessionUpdates = new Map<string, Promise<unknown>>();
  constructor(
    private readonly ports: {
      records: (command: unknown) => Promise<unknown>;
      current: () => WorkspaceSnapshot;
      publish: (state: WorkspaceSnapshot) => void;
      observe: (
        taskId: string,
        signal: AbortSignal,
      ) => Promise<BoundObservation>;
      propose: (input: ProposalInput) => Promise<NextStep>;
      perform: (job: WebActionJob) => Promise<void>;
      material?: (command: unknown) => Promise<unknown>;
      scheduled?: (command: unknown) => Promise<unknown>;
      revoke: (taskId: string) => void;
      stopModels: (taskId: string) => void;
      beforeRecovery?: () => Promise<void>;
      session?: (taskId: string) => Promise<SessionContext>;
      resultPageReady?: (event: ActionNavigationEvent) => Promise<boolean>;
      formChainReady?: (
        proof: FormNavigationProof,
      ) => Promise<HostFormChain | null>;
      navigationReady?: (event: ActionNavigationEvent) => Promise<boolean>;
      refreshPage?: (taskId: string) => Promise<void>;
      initialUpgradeHold?: boolean;
      input?: {
        prepare: (taskId: string) => Promise<number>;
        block: (taskId: string) => void;
        allow: (taskId: string, epoch: number) => boolean;
        epoch: (taskId: string) => number;
        valid: (taskId: string, epoch: number) => boolean;
        permit: <T>(taskId: string, epoch: number, send: () => T) => T;
      };
    },
  ) {
    this.upgradeHeld = ports.initialUpgradeHold ?? false;
  }
  async recordNavigation(event: ActionNavigationEvent) {
    const saving = this.record({ kind: 'action-navigation', ...event });
    this.pendingNavigations.add(saving);
    try {
      await saving;
    } finally {
      this.pendingNavigations.delete(saving);
    }
    this.tryActionNavigation(event.taskId);
    this.tryDynamicResult(event.taskId);
  }
  acceptLinkNavigation(proof: LinkNavigationProof) {
    this.linkProofs.set(proof.taskId, proof);
    this.tryActionNavigation(proof.taskId);
  }
  acceptFormNavigation(proof: FormNavigationProof) {
    this.formProofs.set(proof.taskId, proof);
    this.tryFormDiscovery(proof.taskId);
    this.tryActionNavigation(proof.taskId, true);
  }
  private tryFormDiscovery(taskId: string) {
    const proof = this.formProofs.get(taskId);
    if (
      !proof?.chain ||
      this.reviews.has(taskId) ||
      this.chainDiscoveries.has(proof.actionId) ||
      !this.blocked.get(taskId)?.saved
    )
      return;
    this.chainDiscoveries.add(proof.actionId);
    this.resultDiscoveries.delete(proof.actionId);
    this.tryDynamicResult(taskId);
  }
  /** 已有提交只读核对；导航是候选观察的触发，不是成功或恢复输入的许可。 */
  private tryDynamicResult(taskId: string) {
    const e = this.ports
      .current()
      .tasks.find((t) => t.id === taskId)?.execution;
    const action = e?.actions.find(
      (a) =>
        a.goalVersion === e.goalVersion &&
        ((a.effect === 'publication' &&
          a.submission &&
          !a.submission.recovery &&
          !a.discoveredRecovery) ||
          (a.targetCreation && !a.discoveredTarget)) &&
        a.navigation?.mainFrame &&
        !a.navigation.sameDocument &&
        a.status === 'unknown' &&
        a.dispatchState === 'possible',
    );
    if (
      !e ||
      !action ||
      this.blocked.get(taskId)?.reason !== 'page-change' ||
      !this.blocked.get(taskId)?.saved ||
      this.resultDiscoveries.has(action.id) ||
      this.reviews.has(taskId)
    )
      return;
    this.resultDiscoveries.add(action.id);
    const sequence = this.intents.get(taskId),
      systemGeneration = this.systemGeneration;
    const review = { abort: new AbortController(), work: Promise.resolve() };
    this.reviews.set(taskId, review);
    const signal = AbortSignal.any([
      review.abort.signal,
      AbortSignal.timeout(6000),
    ]);
    const current = () => {
      const latest = this.ports
        .current()
        .tasks.find((t) => t.id === taskId)?.execution;
      return (
        !signal.aborted &&
        this.available &&
        !this.closing &&
        this.systemReady() &&
        this.systemGeneration === systemGeneration &&
        this.intents.get(taskId) === sequence &&
        !this.pendingIntents.has(taskId) &&
        !this.sessionUpdates.has(taskId) &&
        latest?.intent === 'automatic' &&
        latest.phase === 'paused' &&
        latest.pauseReason === 'page-change'
      );
    };
    review.work = (async () => {
      try {
        await this.jobs.get(taskId)?.work;
        const discoveryEpoch = this.ports.input?.epoch(taskId);
        let previous: BoundObservation | undefined;
        for (let attempt = 0; attempt < 20 && current(); attempt++) {
          const epoch = discoveryEpoch;
          if (this.ports.input?.epoch(taskId) !== epoch) return;
          let observed: BoundObservation;
          try {
            if (
              this.ports.resultPageReady &&
              !(await this.abortable(
                () =>
                  this.ports.resultPageReady!({
                    taskId,
                    runId: action.runId,
                    actionId: action.id,
                    navigation: action.navigation!,
                  }),
                signal,
              ))
            ) {
              await new Promise<void>((r) => setTimeout(r, 250));
              continue;
            }
            observed = await this.abortable(
              () => this.ports.observe(taskId, signal),
              signal,
            );
          } catch {
            if (!current()) return;
            await new Promise<void>((r) => setTimeout(r, 250));
            continue;
          }
          if (!current() || this.ports.input?.epoch(taskId) !== epoch) return;
          if (
            observed.binding.targetId !== action.binding.targetId ||
            observed.binding.generation < action.navigation!.generation ||
            observed.observation.generation !== observed.binding.generation ||
            observed.observation.truncated ||
            (action.coordination &&
              (!observed.session ||
                !sameSession(action.coordination.session, observed.session) ||
                action.coordination.session.epoch !== observed.session.epoch))
          )
            return;
          if (
            previous?.observation.fingerprint ===
              observed.observation.fingerprint &&
            previous.observation.url === observed.observation.url &&
            previous.binding.generation === observed.binding.generation
          ) {
            const latest = this.ports
              .current()
              .tasks.find((t) => t.id === taskId)!.execution!;
            const saved = await this.record({
              kind: action.targetCreation
                ? 'created-target-observed'
                : 'publication-result-entry',
              taskId,
              expectedVersion: latest.version,
              actionId: action.id,
              source: observed.observation,
              binding: observed.binding,
            });
            if (
              !saved.created ||
              !current() ||
              this.ports.input?.epoch(taskId) !== epoch
            )
              return;
            if (action.targetCreation) return;
            const execution = this.ports
              .current()
              .tasks.find((t) => t.id === taskId)!.execution!;
            const frozen = execution.actions.find((a) => a.id === action.id)!;
            // 核对与持久化均不调用原生prepare/allow，也不启动模型或工作者。
            await this.checkRecoveredPublication(
              taskId,
              execution,
              frozen,
              review.abort.signal,
            );
            return;
          }
          previous = observed;
          await new Promise<void>((r) => setTimeout(r, 250));
        }
      } catch {
        // 缺少关联、保存失败或观察失效均保留原暂停与未知，不自动重试提交。
      }
    })().finally(() => {
      if (this.reviews.get(taskId) === review) this.reviews.delete(taskId);
      this.tryFormDiscovery(taskId);
      this.tryActionNavigation(taskId, true);
      this.pump();
    });
  }
  private tryActionNavigation(taskId: string, form = false) {
    const proofs = form ? this.formProofs : this.linkProofs;
    const proof = proofs.get(taskId);
    const action = this.ports
      .current()
      .tasks.find((t) => t.id === taskId)
      ?.execution?.actions.find((a) => a.id === proof?.actionId);
    if (
      !proof ||
      !action?.navigation ||
      (form && !action.discoveredTarget) ||
      this.blocked.get(taskId)?.reason !== 'page-change' ||
      !this.blocked.get(taskId)?.saved ||
      this.navigationRecoveries.has(taskId) ||
      !this.ports.navigationReady ||
      !this.ports.input
    )
      return;
    proofs.delete(taskId);
    this.navigationRecoveries.add(taskId);
    const event: ActionNavigationEvent = {
      taskId,
      runId: action.runId,
      actionId: action.id,
      navigation: action.navigation,
    };
    const sequence = this.intents.get(taskId),
      systemGeneration = this.systemGeneration;
    // 旧直接导航仍恰好两次撤权；网络链只采用逐事件无缺口的回执，不以当前epoch作基线。
    const requestChain = form
      ? (proof as FormNavigationProof).chain
      : undefined;
    let epoch = event.navigation.inputEpoch + 2;
    let chain: FormChainResolution | undefined;
    const unchanged = () =>
      this.available &&
      !this.closing &&
      this.systemReady() &&
      this.systemGeneration === systemGeneration &&
      this.intents.get(taskId) === sequence &&
      this.ports.input!.epoch(taskId) === epoch &&
      !this.pendingIntents.has(taskId) &&
      !this.sessionUpdates.has(taskId);
    const work = (async () => {
      try {
        await this.jobs.get(taskId)?.work;
        if (requestChain) {
          const host = await this.ports.formChainReady?.(
            proof as FormNavigationProof,
          );
          if (!host) return;
          chain = {
            host,
            control: (this.navigationBlocks.get(taskId) ?? []).filter(
              (r) => r.before >= event.navigation.inputEpoch,
            ),
          };
          const verified = formChainEpoch(
            requestChain,
            chain,
            event.navigation,
          );
          if (verified === undefined) return;
          epoch = verified;
        }
        if (!unchanged()) return;
        const signal = AbortSignal.timeout(6000);
        let observed: BoundObservation | undefined;
        for (
          let attempt = 0;
          attempt < 20 && !signal.aborted && unchanged();
          attempt++
        ) {
          const ready = await this.abortable(
            () =>
              requestChain
                ? Promise.resolve(true)
                : this.ports.navigationReady!(event),
            signal,
          );
          if (ready) {
            observed = await this.abortable(
              () => this.ports.observe(taskId, signal),
              signal,
            );
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        if (
          !observed ||
          !unchanged() ||
          observed.binding.targetId !== event.navigation.targetId ||
          observed.binding.generation !== event.navigation.generation ||
          observed.observation.url !== (requestChain?.finalUrl ?? proof.url) ||
          observed.observation.truncated ||
          proof.url !== event.navigation.url ||
          proof.inputEpoch !== event.navigation.inputEpoch ||
          proof.generation !== event.navigation.sourceGeneration ||
          proof.targetId !== event.navigation.targetId ||
          (form &&
            (!action.targetCreation ||
              !creationFieldsMatch(
                action.targetCreation,
                observed.observation,
              ) ||
              observed.observation.fingerprint !==
                action.discoveredTarget?.source.fingerprint)) ||
          (action.coordination &&
            (!observed.session ||
              !sameSession(action.coordination.session, observed.session) ||
              action.coordination.session.epoch !== observed.session.epoch))
        )
          return;
        const current = this.ports
          .current()
          .tasks.find((t) => t.id === taskId)?.execution;
        if (!current || current.pauseReason !== 'page-change') return;
        const resolution = {
          proof,
          source: pageSourceSchema.strip().parse(observed.observation),
          pausedInputEpoch: epoch,
          ...(chain ? { chain } : {}),
        };
        if (
          !actionFactSchema.safeParse({
            ...action,
            status: 'confirmed',
            [form ? 'formNavigationResolution' : 'navigationResolution']:
              resolution,
          }).success
        )
          return;
        const result = await this.record({
          kind: form ? 'form-navigation-resolved' : 'navigation-resolved',
          taskId,
          expectedVersion: current.version,
          resolution,
        });
        if (!result.recovered) return;
        if (!unchanged() || !this.ports.input!.allow(taskId, epoch)) {
          // 较新的停止/接管已有自己的记录；否则撤销刚保存的可运行状态。
          if (this.intents.get(taskId) === sequence)
            await this.suspend(taskId, 'ownership-unknown', randomUUID());
          return;
        }
        this.blocked.delete(taskId);
        this.publish();
      } catch {
        // 只读观察失败保持暂停；绝不重发旧点击。
      } finally {
        this.navigationRecoveries.delete(taskId);
        this.pump();
      }
    })();
    this.pendingNavigations.add(work);
    void work.finally(() => this.pendingNavigations.delete(work));
  }
  canExit() {
    return (
      this.pendingReplies.size === 0 &&
      this.pendingNavigations.size === 0 &&
      this.pendingIntents.size === 0 &&
      this.reviews.size === 0 &&
      this.interruptions.size === 0 &&
      this.sessionUpdates.size === 0 &&
      this.workspaceUnsettled.size === 0 &&
      ![...this.blocked.values()].some((b) => !b.saved)
    );
  }
  decorate(state: WorkspaceSnapshot): WorkspaceSnapshot {
    return {
      ...state,
      runtime: { conditions: [...this.systemConditions] },
      tasks: state.tasks.map((t) => {
        const b = this.blocked.get(t.id);
        const unsettled = this.workspaceUnsettled.has(t.id);
        return b
          ? {
              ...t,
              executionControl: {
                blocked: true,
                stopSaved: b.saved && !unsettled,
                message: unsettled
                  ? '目标或任务变化尚未可靠保存，已保留现场并阻止旧目标继续。'
                  : b.message,
                ...(b.reason ? { reason: b.reason } : {}),
              },
            }
          : !this.systemReady() &&
              t.execution?.intent === 'automatic' &&
              !t.execution.pauseReason &&
              ['queued', 'checking', 'running'].includes(t.execution.phase)
            ? {
                ...t,
                executionControl: {
                  blocked: true,
                  stopSaved: true,
                  system: true,
                  message: this.upgradeHeld
                    ? '正在准备升级或核对换版后的现场，已暂停新的自动操作。原任务意图保留。'
                    : this.systemConditions.size
                      ? `系统暂停：${[...this.systemConditions].map((c) => systemConditionLabel[c]).join('、')}。原任务与网页保留，条件恢复后先核对再续做。`
                      : '正在可靠保存系统暂停检查点，完成后先核对原任务；没有直接重发。',
                },
              }
            : t;
      }),
    };
  }
  private publish(state = this.ports.current()) {
    this.ports.publish(state);
  }
  /** 系统事件先同步阻断，再保存恢复检查点；解除条件不替代用户继续。 */
  async setSystemCondition(condition: SystemCondition, blocked: boolean) {
    if (this.systemConditions.has(condition) === blocked) return;
    if (blocked) this.systemConditions.add(condition);
    else this.systemConditions.delete(condition);
    this.systemGeneration++;
    if (blocked) {
      const tasks = this.ports.current().tasks;
      // 在任何等待之前撤权，记录进程迟滞不能延长旧派发资格。
      for (const task of tasks) {
        this.reviews.get(task.id)?.abort.abort();
        this.ports.input?.block(task.id);
        this.jobs.get(task.id)?.abort.abort(Error('SYSTEM_SUSPENDED'));
        this.ports.revoke(task.id);
        this.ports.stopModels(task.id);
      }
      this.publish();
      for (const task of tasks) {
        const e = task.execution;
        if (
          !e ||
          e.intent !== 'automatic' ||
          e.pauseReason ||
          !['queued', 'checking', 'running'].includes(e.phase)
        )
          continue;
        const saved = this.record({
          kind: 'system-interrupt',
          taskId: task.id,
          expectedVersion: e.version,
        });
        this.interruptions.add(saved);
        void saved
          .finally(() => {
            this.interruptions.delete(saved);
            this.publish();
            this.pump();
          })
          .catch(() => {});
      }
    }
    this.publish();
    await Promise.all([...this.interruptions]);
    this.pump();
  }
  systemReady() {
    return (
      !this.restoring &&
      !this.upgradeHeld &&
      this.systemConditions.size === 0 &&
      this.interruptions.size === 0
    );
  }
  private async record(command: unknown) {
    const sequence = ++this.recordSequence;
    try {
      const result = receipt.parse(await this.ports.records(command));
      this.latestRecordSuccess = Math.max(this.latestRecordSuccess, sequence);
      if (result.state.revision >= this.ports.current().revision)
        this.publish(result.state);
      return { ...result, receiptSequence: sequence };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        sequence > this.latestRecordSuccess &&
        ![
          'HISTORY_CLEANED',
          'AGREEMENT_EXPIRED',
          'AGREEMENT_SCOPE_INVALID',
          'AGREEMENT_PERIOD_REQUIRED',
          'AGREEMENT_NEEDS_DETAILS',
          'MATERIAL_WORK_EXISTS',
          'MATERIAL_WORK_UNSETTLED',
          'MATERIAL_REPEAT_CHANGED',
          'REQUEST_CONTENT_CONFLICT',
          'RECORD_VERSION_CONFLICT',
          'TASK_NOT_FOUND',
          'INVALID_REQUEST',
          'EXECUTION_STOPPED',
          'EXECUTION_CONTINUE_REQUIRED',
          'PARTICIPATION_EXPIRED',
          'PARTICIPATION_REQUIRED',
          'EXECUTION_RESULT_UNKNOWN',
          'EXECUTION_PAGE_CHANGED',
          'EXECUTION_LIMIT',
          'WORKFLOW_NOT_APPLICABLE',
          'COORDINATION_STALE',
          'COORDINATION_EVIDENCE_MISSING',
          'COORDINATION_TARGET_CHANGED',
          'EXECUTION_EVIDENCE_MISSING',
          'EXECUTION_SELECTION_UNVERIFIED',
          'BACKUP_REVIEW_REQUIRED',
          'MATERIAL_NOT_AUTHORIZED',
          'MATERIAL_ALREADY_UPLOADED',
          'MATERIAL_ALREADY_FIXED',
          'PREPARATION_TARGET_CHANGED',
          'PREPARATION_INCOMPLETE',
          'PUBLICATION_RESULT_REQUIRED',
          'PUBLICATION_BINDING_MISMATCH',
          'ARTICLE_BINDING_MISMATCH',
          'ARTICLE_FACT_INVALID',
          'PUBLICATION_BYTES_UNVERIFIED',
          'PUBLICATION_ALREADY_DISPATCHED',
        ].includes(code)
      ) {
        this.latestRecordFailure = Math.max(this.latestRecordFailure, sequence);
        this.disable();
      }
      throw error;
    }
  }
  private stopImmediately(taskId: string, message: string, saved = false) {
    this.reviews.get(taskId)?.abort.abort();
    this.ports.input?.block(taskId);
    this.blocked.set(taskId, { saved, message });
    this.jobs.get(taskId)?.abort.abort(new Error('EXECUTION_STOPPED'));
    this.ports.revoke(taskId);
    this.ports.stopModels(taskId);
    this.publish();
  }
  async suspend(
    taskId: string,
    reason: ExecutionPauseReason,
    requestId: string,
  ) {
    if (this.closing) return;
    const prior = this.blocked.get(taskId);
    if (
      !this.pendingIntents.has(taskId) &&
      prior?.saved &&
      prior.reason === reason
    )
      return;
    const sequence = (this.intents.get(taskId) ?? 0) + 1;
    const execution = this.ports
      .current()
      .tasks.find((t) => t.id === taskId)?.execution;
    const affected =
      this.pendingIntents.has(taskId) ||
      (execution &&
        execution.intent !== 'stopped' &&
        execution.phase !== 'complete');
    this.intents.set(taskId, sequence);
    const before = this.ports.input?.epoch(taskId);
    this.ports.input?.block(taskId);
    const after = this.ports.input?.epoch(taskId);
    if (
      reason === 'page-change' &&
      before !== undefined &&
      after !== undefined
    ) {
      const blocks = this.navigationBlocks.get(taskId) ?? [];
      this.navigationBlocks.set(taskId, [
        ...blocks.slice(-17),
        { requestId, before, after },
      ]);
    }
    this.jobs.get(taskId)?.abort.abort(Error('EXECUTION_STOPPED'));
    this.ports.revoke(taskId);
    this.ports.stopModels(taskId);
    if (affected)
      this.blocked.set(taskId, {
        saved: false,
        reason,
        message: pauseDescription[reason].message + ' 暂停记录正在保存。',
      });
    this.publish();
    try {
      await this.record({
        kind: 'suspend',
        taskId,
        requestId,
        reason,
        controlSequence: sequence,
      });
      if (affected && this.intents.get(taskId) === sequence) {
        this.blocked.set(taskId, {
          saved: true,
          reason,
          message: pauseDescription[reason].message,
        });
        this.publish();
      }
    } finally {
      if (this.intents.get(taskId) === sequence)
        this.pendingIntents.delete(taskId);
      this.tryActionNavigation(taskId);
      this.tryFormDiscovery(taskId);
      this.tryActionNavigation(taskId, true);
      this.tryDynamicResult(taskId);
      this.pump();
    }
  }
  private async scheduleRecord(command: unknown) {
    if (!this.ports.scheduled) throw Error('SCHEDULE_UNAVAILABLE');
    try {
      const result = receipt
        .extend({ token: z.string().nullable().optional() })
        .parse(await this.ports.scheduled(command));
      if (result.state.revision >= this.ports.current().revision)
        this.publish(result.state);
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        !/^(SCHEDULE_|AGREEMENT_|RECORD_VERSION_CONFLICT|REQUEST_CONTENT_CONFLICT|UPGRADE_PENDING|BACKUP_REVIEW_REQUIRED|INVALID_REQUEST)/.test(
          code,
        )
      )
        this.disable();
      throw error;
    }
  }
  async tickPlans(now = Date.now()) {
    if (
      this.planTick ||
      !this.ports.scheduled ||
      !this.available ||
      this.closing ||
      !this.systemReady()
    )
      return;
    this.planTick = true;
    const generation = this.systemGeneration;
    const qualified = (taskId: string) =>
      this.available &&
      !this.closing &&
      this.systemReady() &&
      generation === this.systemGeneration &&
      !this.planMutations.has(taskId) &&
      !this.workspaceUnsettled.has(taskId);
    const work = (async () => {
      for (const task of this.ports.current().tasks) {
        const s = task.execution?.schedule,
          v = s?.versions.at(-1);
        if (
          !s ||
          !v ||
          s.restoreReview ||
          v.acceptedAt === null ||
          v.cancelledAt !== null ||
          !qualified(task.id)
        )
          continue;
        if (
          !task.execution?.agreements?.some(
            (a) =>
              a.versionId === v.agreementVersionId &&
              a.acceptedAt !== null &&
              a.revokedAt === null,
          )
        )
          continue;
        const prepared = await this.scheduleRecord({
          kind: 'prepare',
          taskId: task.id,
          now,
        });
        if (prepared.token && qualified(task.id))
          await this.scheduleRecord({ kind: 'commit', token: prepared.token });
      }
    })();
    this.pendingReplies.add(work);
    try {
      await work;
    } finally {
      this.pendingReplies.delete(work);
      this.planTick = false;
      this.pump();
    }
  }
  async scheduled(input: ScheduleUICommand): Promise<WorkspaceSnapshot> {
    const c = scheduleUICommandSchema.parse(input);
    if (this.closing || !this.available) throw Error('RECORDS_UNAVAILABLE');
    if (c.kind !== 'schedule-cancel' && !this.systemReady())
      throw Error('SYSTEM_SUSPENDED');
    if (this.planMutations.has(c.taskId))
      throw Error('RECORD_VERSION_CONFLICT');
    const task = this.ports.current().tasks.find((t) => t.id === c.taskId);
    if (!task?.execution) throw Error('EXECUTION_NOT_FOUND');
    if (task.execution.historyCleanup) throw Error('HISTORY_CLEANED');
    const plan = task.execution.schedule;
    if (c.kind === 'schedule-prepare') {
      const saved = plan?.versions.find((v) => v.requestId === c.requestId);
      if (saved) {
        if (saved.request !== c.text) throw Error('REQUEST_CONTENT_CONFLICT');
        return this.decorate(this.ports.current());
      }
      if ((plan?.revision ?? 0) !== c.expectedRevision)
        throw Error('RECORD_VERSION_CONFLICT');
      if (['queued', 'checking', 'running'].includes(task.execution.phase))
        throw Error('AGREEMENT_TASK_BUSY');
    } else if (
      'versionId' in c &&
      c.versionId !== plan?.versions.at(-1)?.versionId
    )
      throw Error('SCHEDULE_EXPIRED');
    this.planMutations.add(c.taskId);
    const generation = this.systemGeneration;
    const qualified = () =>
      this.available &&
      !this.closing &&
      this.systemReady() &&
      generation === this.systemGeneration;
    const affected =
      c.kind === 'schedule-cancel' || c.kind === 'schedule-prepare'
        ? new Set(
            task.execution.schedule?.rounds.flatMap((r) =>
              r.links.filter((l) => l.created).map((l) => l.taskId),
            ) ?? [],
          )
        : new Set<string>();
    for (const id of affected) {
      const e = this.ports.current().tasks.find((t) => t.id === id)?.execution;
      if (e && e.phase !== 'complete')
        this.stopImmediately(id, '计划正在修改或取消，新动作已阻断。');
    }
    const work = (async () => {
      if (c.kind === 'schedule-prepare') {
        const prior = task.execution!.schedule;
        const saved = prior?.versions.find((v) => v.requestId === c.requestId);
        if (saved) {
          if (saved.request !== c.text) throw Error('REQUEST_CONTENT_CONFLICT');
          return;
        }
        if ((prior?.revision ?? 0) !== c.expectedRevision)
          throw Error('RECORD_VERSION_CONFLICT');
        if (['queued', 'checking', 'running'].includes(task.execution!.phase))
          throw Error('AGREEMENT_TASK_BUSY');
        const old = prior?.versions.at(-1);
        if (old && old.cancelledAt === null)
          await this.scheduleRecord({
            kind: 'schedule-cancel',
            taskId: c.taskId,
            requestId: randomUUID(),
            versionId: old.versionId,
          });
        const current = this.ports
          .current()
          .tasks.find((t) => t.id === c.taskId)!.execution!;
        const revision = current.schedule?.revision ?? 0;
        const abort = new AbortController();
        const observation = await this.ports.observe(c.taskId, abort.signal);
        const step = await this.ports.propose({
          taskId: c.taskId,
          runId: c.requestId,
          goal: current.goal,
          observation: observation.observation,
          pending: null,
          history: [],
          publishingAgreement: current.agreements?.at(-1)?.terms,
          scheduleRequest: {
            text: c.text,
            current: old?.terms ?? null,
            now: new Date().toISOString(),
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          signal: abort.signal,
          permit: (send) => {
            if (!qualified()) throw Error('SYSTEM_SUSPENDED');
            return send();
          },
        });
        if (!qualified()) throw Error('SYSTEM_SUSPENDED');
        if (!step.schedule) throw Error('SCHEDULE_NEEDS_DETAILS');
        await this.scheduleRecord({
          ...c,
          kind: 'schedule-propose',
          expectedRevision: revision,
          terms: step.schedule,
        });
      } else {
        const prepared = await this.scheduleRecord(c);
        if (prepared.token && qualified())
          await this.scheduleRecord({ kind: 'commit', token: prepared.token });
      }
      for (const id of affected) {
        const e = this.ports
          .current()
          .tasks.find((t) => t.id === id)?.execution;
        if (e?.intent === 'stopped')
          this.blocked.set(id, {
            saved: true,
            message: e.summary,
            control: 'stop',
          });
      }
    })();
    this.pendingReplies.add(work);
    try {
      await work;
      return this.decorate(this.ports.current());
    } finally {
      this.pendingReplies.delete(work);
      this.planMutations.delete(c.taskId);
      this.pump();
    }
  }
  async agreement(input: AgreementUICommand): Promise<WorkspaceSnapshot> {
    const c = agreementUICommandSchema.parse(input);
    if (this.closing) throw Error('APPLICATION_EXITING');
    if (!this.available) throw Error('RECORDS_UNAVAILABLE');
    if (c.kind !== 'agreement-revoke' && !this.systemReady())
      throw Error('SYSTEM_SUSPENDED');
    const task = this.ports.current().tasks.find((t) => t.id === c.taskId);
    if (!task?.execution) throw Error('EXECUTION_NOT_FOUND');
    if (task.execution.historyCleanup) throw Error('HISTORY_CLEANED');
    if (c.kind === 'agreement-prepare') {
      const saved = task.execution.agreements?.find(
        (a) => a.requestId === c.requestId,
      );
      if (saved) {
        if (saved.request !== c.text) throw Error('REQUEST_CONTENT_CONFLICT');
        return this.decorate(this.ports.current());
      }
      if (['queued', 'running', 'checking'].includes(task.execution.phase))
        throw Error('AGREEMENT_TASK_BUSY');
      if (task.execution.version !== c.expectedVersion)
        throw Error('RECORD_VERSION_CONFLICT');
      const old = task.execution.agreements?.at(-1);
      if (old && old.revokedAt === null)
        await this.agreement({
          kind: 'agreement-revoke',
          taskId: c.taskId,
          requestId: randomUUID(),
          versionId: old.versionId,
        });
      const expectedVersion = this.ports
        .current()
        .tasks.find((t) => t.id === c.taskId)!.execution!.version;
      const abort = new AbortController();
      const qualified = () =>
        !this.closing &&
        this.systemReady() &&
        this.ports.current().tasks.find((t) => t.id === c.taskId)?.execution
          ?.version === expectedVersion;
      const job = (async () => {
        const observed = await this.ports.observe(c.taskId, abort.signal);
        if (!qualified()) throw Error('RECORD_VERSION_CONFLICT');
        const step = await this.ports.propose({
          taskId: c.taskId,
          runId: c.requestId,
          goal: task.execution!.goal,
          observation: observed.observation,
          history: [],
          pending: null,
          materials: task.execution!.materials,
          publication: task.execution!.publication,
          agreementRequest: {
            text: c.text,
            current: task.execution!.agreements?.at(-1)?.terms ?? null,
          },
          signal: abort.signal,
          permit: (send) => {
            if (!qualified()) throw Error('RECORD_VERSION_CONFLICT');
            return send();
          },
        });
        if (!step.agreement) throw Error('AGREEMENT_NEEDS_DETAILS');
        await this.record({
          ...c,
          expectedVersion,
          kind: 'agreement-propose',
          terms: step.agreement,
        });
      })();
      this.pendingReplies.add(job);
      try {
        await job;
      } finally {
        this.pendingReplies.delete(job);
      }
      return this.decorate(this.ports.current());
    }
    const version = task.execution.agreements?.find(
      (a) => a.versionId === c.versionId,
    );
    if (!version) throw Error('AGREEMENT_EXPIRED');
    const affected =
      c.kind === 'agreement-revoke' && version.revokedAt === null
        ? this.ports
            .current()
            .tasks.filter(
              (t) =>
                t.execution?.agreementBinding?.versionId === c.versionId &&
                t.execution.phase !== 'complete',
            )
        : [];
    // 即时撤权先于记录等待；数据库提交后也不恢复旧工作者。
    for (const t of affected)
      this.stopImmediately(t.id, '正在保存发布约定撤销；新动作已阻断。');
    const job = this.record(c);
    this.pendingReplies.add(job);
    try {
      await job;
      for (const t of affected) {
        const latest = this.ports
          .current()
          .tasks.find((v) => v.id === t.id)?.execution;
        if (latest?.intent !== 'stopped' && !latest?.pauseReason)
          this.blocked.delete(t.id);
        else if (latest)
          this.blocked.set(t.id, {
            saved: true,
            message: latest.summary,
            reason: latest.pauseReason,
          });
      }
      this.publish();
      return this.decorate(this.ports.current());
    } finally {
      this.pendingReplies.delete(job);
      this.pump();
    }
  }
  async reply(
    command: ParticipationReply | ParticipationDecision,
  ): Promise<WorkspaceSnapshot> {
    if (this.closing) throw Error('APPLICATION_EXITING');
    if (!this.systemReady()) throw Error('SYSTEM_SUSPENDED');
    if (!this.available) throw Error('RECORDS_UNAVAILABLE');
    if (
      command.kind === 'participation-decision' &&
      command.operation === 'login-check'
    ) {
      const task = this.ports
        .current()
        .tasks.find((t) => t.id === command.taskId);
      const q = task?.execution?.question;
      const block = this.blocked.get(command.taskId);
      if (
        !task?.execution ||
        !q ||
        q.id !== command.questionId ||
        q.type !== 'login' ||
        this.pendingIntents.has(task.id) ||
        (block &&
          (!block.saved ||
            !['page-change', 'takeover'].includes(block.reason ?? '')))
      )
        throw Error('PARTICIPATION_EXPIRED');
      return this.intent(
        {
          kind: 'execution-intent',
          intent: 'continue',
          taskId: task.id,
          requestId: 'login:' + q.id,
          expectedVersion: task.execution.version,
          text: '已登录，核对后继续',
        },
        q.id,
      );
    }
    if (
      this.blocked.has(command.taskId) ||
      this.pendingIntents.has(command.taskId)
    )
      throw Error('PARTICIPATION_EXPIRED');
    const work = this.record(command);
    this.pendingReplies.add(work);
    try {
      await work;
      return this.decorate(this.ports.current());
    } finally {
      this.pendingReplies.delete(work);
      this.pump();
    }
  }
  async intent(
    input: ExecutionIntent,
    loginQuestionId?: string,
    closeAtVersion?: number,
  ): Promise<WorkspaceSnapshot> {
    const command = executionIntentSchema.parse(input);
    const currentTask = this.ports
      .current()
      .tasks.find((t) => t.id === command.taskId);
    if (currentTask?.execution?.historyCleanup) throw Error('HISTORY_CLEANED');
    if (
      closeAtVersion !== undefined &&
      (!currentTask ||
        currentTask.hidden ||
        (currentTask.execution?.version ?? 0) !== closeAtVersion ||
        this.pendingIntents.has(command.taskId))
    )
      throw Error('RECORD_VERSION_CONFLICT');
    if (
      currentTask?.archived &&
      currentTask.execution?.result &&
      currentTask.execution.result.goalVersion ===
        currentTask.execution.goalVersion &&
      ['continue', 'start'].includes(command.intent)
    )
      return this.decorate(this.ports.current());
    if (
      ['start', 'continue'].includes(command.intent) &&
      this.ports.current().tasks.find((t) => t.id === command.taskId)?.execution
        ?.restoreReview === 'complete'
    )
      return this.decorate(this.ports.current());
    const pendingQuestion = this.ports
      .current()
      .tasks.find((task) => task.id === command.taskId)?.execution?.question;
    if (
      pendingQuestion &&
      pendingQuestion.id !== loginQuestionId &&
      ['start', 'continue'].includes(command.intent)
    )
      throw Error('PARTICIPATION_REQUIRED');
    const priorBlock = this.blocked.get(command.taskId);
    let recordStarted = false;
    if (this.closing) throw Error('APPLICATION_EXITING');
    if (command.intent !== 'stop' && !this.systemReady())
      throw Error('SYSTEM_SUSPENDED');
    const systemGeneration = this.systemGeneration;
    const sequence = (this.intents.get(command.taskId) ?? 0) + 1;
    this.intents.set(command.taskId, sequence);
    this.pendingIntents.add(command.taskId);
    if (
      command.intent === 'stop' ||
      command.intent === 'revise' ||
      command.intent === 'continue'
    )
      this.stopImmediately(
        command.taskId,
        command.intent === 'stop'
          ? '已阻断新操作，正在保存停止记录。'
          : '正在保存最新要求，先前执行已失效。',
      );
    const blocking = this.blocked.get(command.taskId);
    if (blocking && command.intent !== 'start')
      blocking.control = command.intent;
    try {
      const inputEpoch =
        command.intent !== 'stop'
          ? await this.ports.input?.prepare(command.taskId)
          : undefined;
      recordStarted = true;
      const result = await this.record({
        ...command,
        ...(loginQuestionId ? { loginQuestionId } : {}),
        ...(closeAtVersion !== undefined ? { closeAtVersion } : {}),
        kind: 'intent',
        controlSequence: sequence,
      });
      if (this.intents.get(command.taskId) !== sequence)
        return this.decorate(this.ports.current());
      if (result.created !== true && result.current !== true)
        throw Error('RECORD_VERSION_CONFLICT');
      const task = result.state.tasks.find((t) => t.id === command.taskId);
      if (result.receiptSequence > this.latestRecordFailure)
        this.available = true;
      else if (task?.execution?.intent !== 'stopped')
        throw Error('RECORDS_UNAVAILABLE');
      if (
        command.intent !== 'stop' &&
        (!this.systemReady() || systemGeneration !== this.systemGeneration)
      ) {
        this.ports.input?.block(command.taskId);
        if (task?.execution)
          await this.record({
            kind: 'system-interrupt',
            taskId: task.id,
            expectedVersion: task.execution.version,
          });
        if (
          this.intents.get(command.taskId) === sequence &&
          !task?.execution?.pauseReason
        )
          this.blocked.delete(command.taskId);
        return this.decorate(this.ports.current());
      }
      // 已接受的开始请求重送只返回回执，不改变正在执行或刚被原生撤销的资格。
      if (command.intent === 'start' && result.created !== true) {
        if (
          this.ports.input &&
          (inputEpoch === undefined ||
            !this.ports.input.valid(command.taskId, inputEpoch))
        )
          await this.suspend(command.taskId, 'ownership-unknown', randomUUID());
        return this.decorate(this.ports.current());
      }
      if (
        closeAtVersion !== undefined &&
        task?.archived &&
        task.execution?.intent !== 'stopped'
      ) {
        this.blocked.delete(task.id);
        this.publish();
        return this.decorate(result.state);
      }
      if (task?.execution?.intent === 'stopped')
        this.blocked.set(task.id, {
          saved: true,
          message: task.execution.summary,
        });
      else if (task?.execution?.pauseReason)
        this.blocked.set(task.id, {
          saved: true,
          reason: task.execution.pauseReason,
          message: task.execution.summary,
        });
      else {
        if (
          this.ports.input &&
          (inputEpoch === undefined ||
            !this.ports.input.allow(command.taskId, inputEpoch))
        ) {
          await this.suspend(command.taskId, 'ownership-unknown', randomUUID());
          throw Error('INPUT_CHANGED_DURING_CONTINUE');
        }
        this.blocked.delete(command.taskId);
      }
      this.publish();
      return this.decorate(result.state);
    } catch (error) {
      // 明确的旧版本拒绝没有接受新意图。撤销本次临时阻断，按最新可靠记录
      // 保留停止／接管或问题入口；保存结果不明时仍必须保留未保存阻断。
      if (
        recordStarted &&
        error instanceof Error &&
        error.message === 'RECORD_VERSION_CONFLICT' &&
        command.intent !== 'stop' &&
        this.intents.get(command.taskId) === sequence
      ) {
        const latest = this.ports
          .current()
          .tasks.find((t) => t.id === command.taskId)?.execution;
        if (priorBlock && !priorBlock.saved)
          this.blocked.set(command.taskId, priorBlock);
        else if (latest?.intent === 'stopped' || latest?.pauseReason)
          this.blocked.set(command.taskId, {
            saved: true,
            message: latest.summary,
            ...(latest.pauseReason ? { reason: latest.pauseReason } : {}),
          });
        else if (
          latest &&
          ['queued', 'checking', 'running'].includes(latest.phase)
        )
          await this.suspend(command.taskId, 'page-change', randomUUID());
        else this.blocked.delete(command.taskId);
      }
      // 准备能力失败时尚未请求新保存，保留先前已可靠保存的暂停／停止。
      if (!recordStarted && this.intents.get(command.taskId) === sequence) {
        if (priorBlock) this.blocked.set(command.taskId, priorBlock);
        else {
          const previous = this.ports
            .current()
            .tasks.find((t) => t.id === command.taskId)?.execution;
          if (!previous) this.blocked.delete(command.taskId);
          else if (['queued', 'checking', 'running'].includes(previous.phase))
            await this.suspend(command.taskId, 'page-change', randomUUID());
          else
            this.blocked.set(command.taskId, {
              saved: true,
              message:
                '网页连接尚未就绪，原任务记录保留。连接恢复后可重试继续。',
            });
        }
      }
      if (
        command.intent === 'stop' &&
        this.intents.get(command.taskId) === sequence
      )
        this.blocked.set(command.taskId, {
          saved: false,
          control: 'stop',
          message: '已阻断新操作，但停止尚未保存。请保持应用打开并重试停止。',
        });
      this.publish();
      throw error;
    } finally {
      if (this.intents.get(command.taskId) === sequence)
        this.pendingIntents.delete(command.taskId);
      this.pump();
    }
  }
  private live(job: Job): boolean {
    const e = this.ports
      .current()
      .tasks.find((t) => t.id === job.taskId)?.execution;
    return (
      this.available &&
      this.systemReady() &&
      job.systemGeneration === this.systemGeneration &&
      !this.closing &&
      !job.abort.signal.aborted &&
      !this.blocked.has(job.taskId) &&
      !this.sessionUpdates.has(job.taskId) &&
      (!this.ports.input ||
        this.ports.input.valid(job.taskId, job.inputEpoch)) &&
      this.jobs.get(job.taskId) === job &&
      e?.intent === 'automatic' &&
      e.runId === job.runId &&
      e.version === job.version
    );
  }
  private async abortable<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(Error('EXECUTION_STOPPED'));
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  refresh() {
    this.pump();
  }
  /** 宿主已经同步撤销原生门；这里只保存事实，不解除用户停止或接管。 */
  async sessionChanged(session: SessionContext, taskIds: string[]) {
    for (const id of taskIds) {
      this.ports.input?.block(id);
      this.jobs.get(id)?.abort.abort(Error('COORDINATION_STALE'));
      this.reviews.get(id)?.abort.abort(Error('COORDINATION_STALE'));
      this.ports.revoke(id);
      this.ports.stopModels(id);
      const work = this.record({
        kind: 'session-invalidated',
        taskId: id,
        session,
      });
      this.sessionUpdates.set(id, work);
      void work
        .finally(() => {
          if (this.sessionUpdates.get(id) === work)
            this.sessionUpdates.delete(id);
          this.pump();
        })
        .catch(() => {});
    }
    await Promise.all([...this.sessionUpdates.values()]);
  }
  private blockSessionPeers(job: Job, session: SessionContext) {
    for (const task of this.ports.current().tasks) {
      if (
        task.id === job.taskId ||
        !task.execution?.coordination ||
        !sameSession(task.execution.coordination.session, session)
      )
        continue;
      this.ports.input?.block(task.id);
      this.jobs.get(task.id)?.abort.abort(Error('COORDINATION_STALE'));
      this.ports.revoke(task.id);
      this.ports.stopModels(task.id);
    }
  }
  async beginRestore() {
    if (this.upgradeHeld) throw Error('UPGRADE_PENDING');
    if (this.restoring) throw Error('BACKUP_BUSY');
    this.restoring = true;
    this.systemGeneration++;
    for (const task of this.ports.current().tasks)
      this.stopImmediately(task.id, '正在恢复资料，自动操作已暂停。', true);
    await this.settled();
    for (const task of this.ports.current().tasks)
      await this.record({ kind: 'backup-pause', taskId: task.id });
  }
  async endRestore(state: WorkspaceSnapshot) {
    this.restoring = false;
    await this.recordsRestored(state);
  }
  async holdUpgrade() {
    if (this.restoring) throw Error('BACKUP_BUSY');
    if (!this.upgradeHeld) {
      this.upgradeHeld = true;
      this.systemGeneration++;
      const tasks = this.ports.current().tasks;
      for (const t of tasks) {
        this.reviews.get(t.id)?.abort.abort();
        this.ports.input?.block(t.id);
        this.jobs.get(t.id)?.abort.abort(Error('UPGRADE_PENDING'));
        this.ports.revoke(t.id);
        this.ports.stopModels(t.id);
      }
      this.publish();
    }
    await this.settled();
    for (const t of this.ports.current().tasks) {
      const e = t.execution;
      if (
        e &&
        e.intent === 'automatic' &&
        !e.recoveryPending &&
        !e.pauseReason &&
        ['queued', 'checking', 'running'].includes(e.phase)
      )
        await this.record({
          kind: 'system-interrupt',
          taskId: t.id,
          expectedVersion: e.version,
        });
    }
  }
  releaseUpgrade() {
    this.upgradeHeld = false;
    this.systemGeneration++;
    this.publish();
    this.pump();
  }
  async reviewRestored(taskId: string): Promise<WorkspaceSnapshot> {
    if (this.reviews.has(taskId)) throw Error('MODEL_BUSY');
    if (!this.available || this.closing || !this.systemReady())
      throw Error('SYSTEM_SUSPENDED');
    const task = this.ports.current().tasks.find((t) => t.id === taskId),
      e = task?.execution;
    if (!e?.restoreReview) throw Error('BACKUP_REVIEW_REQUIRED');
    const version = e.version,
      generation = this.systemGeneration;
    const job: { abort: AbortController; work: Promise<void>; epoch?: number } =
      { abort: new AbortController(), work: Promise.resolve() };
    this.reviews.set(taskId, job);
    const sameIntent = () =>
      !job.abort.signal.aborted &&
      this.available &&
      !this.closing &&
      this.systemReady() &&
      this.systemGeneration === generation &&
      this.ports.current().tasks.find((t) => t.id === taskId)?.execution
        ?.version === version;
    const current = () =>
      sameIntent() &&
      (!this.ports.input ||
        (job.epoch !== undefined && this.ports.input.valid(taskId, job.epoch)));
    job.work = (async () => {
      job.epoch = await this.ports.input?.prepare(taskId);
      if (!sameIntent()) throw Error('EXECUTION_STOPPED');
      // 本次明确核对仅授予只读观察／模型发送资格，执行状态仍暂停，不建立网页动作工作者。
      if (
        this.ports.input &&
        (job.epoch === undefined || !this.ports.input.allow(taskId, job.epoch))
      )
        throw Error('INPUT_CHANGED_DURING_CONTINUE');
      const observed = await this.abortable(
        () => this.ports.observe(taskId, job.abort.signal),
        job.abort.signal,
      );
      if (!current()) throw Error('EXECUTION_STOPPED');
      const step = await this.abortable(
        () =>
          this.ports.propose({
            taskId,
            runId: randomUUID(),
            goal: e.goal,
            observation: observed.observation,
            pending:
              e.actions.find((a) =>
                ['reserved', 'dispatched', 'unknown'].includes(a.status),
              ) ?? null,
            history: e.actions,
            materials: e.materials?.filter(
              (m) => m.goalVersion === e.goalVersion,
            ),
            preparation: e.preparation?.filter(
              (f) => f.goalVersion === e.goalVersion,
            ),
            publication: e.publication,
            loginOrigin: e.loginOrigin,
            clarifications: e.answers
              ?.filter((a) => a.goalVersion === e.goalVersion)
              .map((a) => ({ question: a.text, answer: a.answer })),
            signal: job.abort.signal,
            permit: (send) => {
              if (!current()) throw Error('EXECUTION_STOPPED');
              return this.ports.input
                ? this.ports.input.permit(taskId, job.epoch!, send)
                : send();
            },
          }),
        job.abort.signal,
      );
      if (!current()) throw Error('EXECUTION_STOPPED');
      const accepted = await this.record({
        kind: 'backup-review-result',
        taskId,
        expectedVersion: version,
        source: observed.observation,
        step,
      });
      if (
        this.ports.input &&
        job.epoch !== undefined &&
        !this.ports.input.valid(taskId, job.epoch)
      ) {
        const execution = accepted.state.tasks.find(
          (task) => task.id === taskId,
        )?.execution;
        if (execution)
          await this.record({
            kind: 'backup-pause',
            taskId,
            expectedVersion: execution.version,
          });
        throw Error('EXECUTION_STOPPED');
      }
      const completed = this.ports
        .current()
        .tasks.find((task) => task.id === taskId)?.execution;
      if (
        !job.abort.signal.aborted &&
        completed?.intent === 'automatic' &&
        completed.version === version + 1 &&
        completed.restoreReview === 'complete'
      ) {
        this.blocked.delete(taskId);
        this.publish();
      }
    })();
    try {
      await job.work;
      return this.decorate(this.ports.current());
    } finally {
      if (this.reviews.get(taskId) === job) this.reviews.delete(taskId);
      if (
        this.ports.input &&
        job.epoch !== undefined &&
        this.ports.input.epoch(taskId) === job.epoch
      )
        this.ports.input.block(taskId);
    }
  }
  private pump() {
    if (!this.available || this.closing || !this.systemReady()) return;
    if (this.pumping) {
      this.wake = true;
      return;
    }
    this.pumping = this.schedule()
      .catch(() => {})
      .finally(() => {
        this.pumping = null;
        if (this.wake) {
          this.wake = false;
          this.pump();
        }
      });
  }
  private async schedule() {
    const systemGeneration = this.systemGeneration;
    for (const task of this.ports.current().tasks) {
      if (
        !this.available ||
        this.closing ||
        !this.systemReady() ||
        systemGeneration !== this.systemGeneration
      )
        return;
      const pausedResult = task.execution?.actions.find(
        (a) =>
          a.discoveredRecovery &&
          a.goalVersion === task.execution!.goalVersion &&
          a.status === 'unknown' &&
          !task.execution!.publicationChecks?.some((c) => c.actionId === a.id),
      );
      if (
        task.execution?.intent === 'automatic' &&
        task.execution.phase === 'paused' &&
        task.execution.pauseReason === 'page-change' &&
        !task.execution.restoreReview &&
        !task.execution.question &&
        !task.execution.loginOrigin &&
        pausedResult &&
        !this.jobs.has(task.id) &&
        !this.reviews.has(task.id) &&
        !this.pendingIntents.has(task.id)
      ) {
        this.recoverPublication(task.id, task.execution, pausedResult);
        continue;
      }
      if (
        (task.execution?.agreementBinding &&
          this.planMutations.has(
            task.execution.agreementBinding.ownerTaskId,
          )) ||
        task.execution?.phase !== 'queued' ||
        this.jobs.has(task.id) ||
        this.reviews.has(task.id) ||
        this.reviews.size + this.jobs.size >= 2 ||
        this.blocked.has(task.id) ||
        this.pendingIntents.has(task.id) ||
        this.sessionUpdates.has(task.id)
      )
        continue;
      if (
        task.execution.agreementBinding?.goalVersion ===
          task.execution.goalVersion &&
        !task.execution.materials?.some(
          (m) => m.goalVersion === task.execution!.goalVersion,
        ) &&
        this.ports.material
      ) {
        try {
          const result = receipt.parse(
            await this.ports.material({
              kind: 'agreement-select',
              taskId: task.id,
              expectedVersion: task.execution.version,
            }),
          );
          if (result.state.revision >= this.ports.current().revision)
            this.publish(result.state);
          this.wake = result.created === true;
        } catch {
          /* 停止、撤销和旧版本不放行；等待新意图。 */
        }
        continue;
      }
      const submitted = task.execution.actions.find(
        (a) =>
          a.goalVersion === task.execution!.goalVersion &&
          (a.submission?.recovery || a.discoveredRecovery) &&
          a.dispatchState === 'possible' &&
          ['dispatched', 'unknown'].includes(a.status),
      );
      if (submitted) {
        this.recoverPublication(task.id, task.execution, submitted);
        continue;
      }
      if (task.execution.recoveryPending) {
        const version = task.execution.version;
        const sequence = this.intents.get(task.id);
        try {
          await this.ports.beforeRecovery?.();
          const epoch = await this.ports.input?.prepare(task.id);
          if (
            !this.available ||
            !this.systemReady() ||
            systemGeneration !== this.systemGeneration ||
            this.closing ||
            this.blocked.has(task.id) ||
            this.pendingIntents.has(task.id) ||
            this.intents.get(task.id) !== sequence
          )
            continue;
          const recovered = await this.record({
            kind: 'recover',
            taskId: task.id,
            expectedVersion: version,
          });
          const current = this.ports
            .current()
            .tasks.find((t) => t.id === task.id)?.execution;
          if (
            !recovered.recovered ||
            !current ||
            current.version !== version ||
            current.phase !== 'queued' ||
            this.blocked.has(task.id) ||
            this.pendingIntents.has(task.id) ||
            this.closing ||
            !this.available ||
            !this.systemReady() ||
            systemGeneration !== this.systemGeneration ||
            this.intents.get(task.id) !== sequence
          )
            continue;
          if (
            this.ports.input &&
            (epoch === undefined || !this.ports.input.allow(task.id, epoch))
          ) {
            await this.suspend(task.id, 'ownership-unknown', randomUUID());
            continue;
          }
        } catch {
          // 初次页面／原生能力尚未就绪时保留恢复标记，下一次就绪通知再核对。
          continue;
        }
      }
      const runId = randomUUID();
      const session = await this.ports.session?.(task.id);
      const claim = await this.record({
        kind: 'claim',
        taskId: task.id,
        runId,
        ...(session ? { session } : {}),
      });
      if (!this.systemReady() || systemGeneration !== this.systemGeneration) {
        const execution = this.ports
          .current()
          .tasks.find((t) => t.id === task.id)?.execution;
        if (execution)
          await this.record({
            kind: 'system-interrupt',
            taskId: task.id,
            expectedVersion: execution.version,
          });
        this.wake = true;
        return;
      }
      if (!claim.claimed) continue;
      if (session && this.ports.session) {
        const latest = await this.ports.session(task.id);
        if (!sameSession(session, latest) || session.epoch !== latest.epoch) {
          await this.sessionChanged(latest, [task.id]);
          continue;
        }
      }
      const current = claim.state.tasks.find(
        (t) => t.id === task.id,
      )?.execution;
      if (!current) continue;
      const job: Job = {
        taskId: task.id,
        runId,
        version: current.version,
        inputEpoch: this.ports.input?.epoch(task.id) ?? 0,
        systemGeneration,
        abort: new AbortController(),
        work: Promise.resolve(),
      };
      this.jobs.set(task.id, job);
      if (this.blocked.has(task.id) || this.pendingIntents.has(task.id)) {
        job.abort.abort();
      }
      job.work = this.run(job).finally(() => {
        if (this.jobs.get(task.id) === job) this.jobs.delete(task.id);
        this.pump();
      });
    }
  }
  private recoverPublication(
    taskId: string,
    execution: TaskExecution,
    action: ActionFact,
  ) {
    const review = { abort: new AbortController(), work: Promise.resolve() };
    this.reviews.set(taskId, review);
    review.work = (async () => {
      try {
        await this.checkRecoveredPublication(
          taskId,
          execution,
          action,
          review.abort.signal,
        );
      } catch {
        // 不自动重试未分类失败；已有网页效果与动作记录留存。
        if (!review.abort.signal.aborted && this.available)
          await this.suspend(taskId, 'record-unavailable', randomUUID()).catch(
            () => {},
          );
      }
    })().finally(() => {
      if (this.reviews.get(taskId) === review) this.reviews.delete(taskId);
      this.pump();
    });
  }
  private async checkRecoveredPublication(
    taskId: string,
    execution: TaskExecution,
    action: ActionFact,
    signal: AbortSignal,
  ) {
    const check = await verifyRecoveredPublication(execution, action, signal);
    const verified = await this.ports.material?.({
      kind: 'verify',
      taskId,
      materialId: check.materialId,
      goalVersion: check.goalVersion,
    });
    check.localMaterial = z
      .object({ valid: z.boolean() })
      .parse(verified ?? { valid: false }).valid
      ? 'verified'
      : 'unavailable';
    if (check.localMaterial !== 'verified') {
      check.status = 'unknown';
      check.failure = 'material';
    }
    if (signal.aborted) return;
    // 记录进程按版本处理核对期间的新停止；只读完成也不取得下一动作的资格。
    await this.record({
      kind: 'publication-recovery-result',
      taskId,
      expectedVersion: execution.version,
      check,
    });
    const latest = this.ports
      .current()
      .tasks.find((t) => t.id === taskId)?.execution;
    if (
      latest?.intent === 'automatic' &&
      latest.phase === 'complete' &&
      this.blocked.get(taskId)?.reason === 'page-change'
    ) {
      this.blocked.delete(taskId);
      this.publish();
    }
  }
  private async waitForUpload(
    job: Job,
    action: ActionFact,
    first: BoundObservation,
  ) {
    const signal = AbortSignal.any([
      job.abort.signal,
      AbortSignal.timeout(10000),
    ]);
    const save = (command: unknown) =>
      this.abortable(() => this.record(command), signal);
    const initialSession = first.session ? { ...first.session } : undefined;
    let observed = first;
    let previous: BoundObservation | undefined;
    const valid = async (value: BoundObservation) => {
      const coordination = this.ports
        .current()
        .tasks.find((t) => t.id === job.taskId)?.execution?.coordination;
      if (
        coordination &&
        (coordination.status !== 'ready' || coordination.refreshRequired)
      )
        throw Error('COORDINATION_STALE');
      if (!this.live(job) || signal.aborted) throw Error('EXECUTION_STOPPED');
      if (
        action.navigation ||
        value.observation.url !== action.source.url ||
        value.binding.targetId !== first.binding.targetId ||
        value.binding.generation !== first.binding.generation ||
        value.observation.generation !== value.binding.generation ||
        (action.runId === job.runId &&
          (value.binding.targetId !== action.binding.targetId ||
            value.binding.generation !== action.binding.generation))
      )
        throw Error('EXECUTION_PAGE_CHANGED');
      if (initialSession) {
        const latest = this.ports.session
          ? await this.abortable(() => this.ports.session!(job.taskId), signal)
          : value.session;
        if (
          !latest ||
          !value.session ||
          !sameSession(initialSession, latest) ||
          latest.epoch !== initialSession.epoch ||
          !sameSession(initialSession, value.session) ||
          value.session.epoch !== initialSession.epoch
        )
          throw Error('COORDINATION_STALE');
      }
      if (!this.live(job) || signal.aborted) throw Error('EXECUTION_STOPPED');
    };
    try {
      for (let attempt = 0; attempt < 24; attempt++) {
        await valid(observed);
        const link = uploadedLink(action, observed.observation);
        const before = previous && uploadedLink(action, previous.observation);
        if (
          link &&
          before?.url === link.url &&
          before.name === link.name &&
          previous!.observation.fingerprint === observed.observation.fingerprint
        ) {
          const current = this.ports
            .current()
            .tasks.find((t) => t.id === job.taskId)!.execution!;
          const material = current.materials?.find(
            (m) =>
              action.action.kind === 'upload' &&
              m.id === action.action.materialId &&
              m.goalVersion === current.goalVersion,
          );
          if (!material) throw Error('MATERIAL_CORRUPT');
          // 先保存可恢复的页面关联。下载失败或停止不删除已派发的上传事实。
          const target = current.preparation?.find(
            (f) => f.kind === 'target' && f.goalVersion === current.goalVersion,
          );
          await save({
            kind: 'preparation-observed',
            taskId: job.taskId,
            runId: job.runId,
            source: observed.observation,
            facts: [
              ...(!target
                ? [
                    {
                      kind: 'target',
                      url: observed.observation.url,
                      materialId: null,
                      evidence: [link.name],
                    },
                  ]
                : []),
              {
                kind: 'upload',
                url: link.url,
                materialId: material.id,
                evidence: [link.name],
              },
            ],
          });
          await valid(observed);
          const download = await this.abortable(
            () =>
              verifyAttachment(
                {
                  content: current.goal,
                  destination: target?.url ?? observed.observation.url,
                  attachment: {
                    materialId: material.id,
                    targetUrl: target?.url ?? observed.observation.url,
                    url: link.url,
                  },
                },
                material,
                signal,
              ),
            signal,
          );
          const fixed = await this.abortable(
            () =>
              this.ports.material?.({
                kind: 'verify',
                taskId: job.taskId,
                materialId: material.id,
                goalVersion: material.goalVersion,
              }) ?? Promise.resolve({ valid: false }),
            signal,
          );
          if (!z.object({ valid: z.boolean() }).parse(fixed).valid)
            throw Error('MATERIAL_CORRUPT');
          const latest = await this.abortable(
            () => this.ports.observe(job.taskId, signal),
            signal,
          );
          await valid(latest);
          if (
            latest.observation.fingerprint !==
              observed.observation.fingerprint ||
            uploadedLink(action, latest.observation)?.url !== link.url
          )
            throw Error('EXECUTION_RESULT_UNKNOWN');
          await save({
            kind: 'resolve',
            taskId: job.taskId,
            runId: job.runId,
            id: action.id,
            source: observed.observation,
            binding: observed.binding,
            evidence: [link.name],
            download,
          });
          return this.live(job);
        }
        previous = observed;
        if (attempt === 23) break;
        await this.abortable(
          () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
          signal,
        );
        observed = await this.abortable(
          () => this.ports.observe(job.taskId, signal),
          signal,
        );
      }
    } catch (error) {
      if (!this.live(job)) return false;
      if (error instanceof Error && error.message === 'MATERIAL_CORRUPT')
        throw error;
      // 只读检查失败后不重试下载，不让模型确认未知上传。
    }
    if (this.live(job))
      await this.finish(
        job,
        'unknown',
        '附件已送出，但尚未核对就绪或下载字节；已暂停，不重传，也不保存或发布。明确继续后先核对已有附件。',
      );
    return false;
  }
  private async run(job: Job) {
    try {
      const initial = this.ports
        .current()
        .tasks.find((t) => t.id === job.taskId)?.execution;
      if (initial?.coordination?.refreshRequired) {
        // 本任务尚未写入且没有人工接管时才可丢弃旧只读页面。已有现场留待本人核对。
        if (!initial.actions.some((a) => a.status !== 'cancelled')) {
          if (!this.ports.refreshPage)
            throw Error('COORDINATION_TARGET_CHANGED');
          await this.ports.refreshPage(job.taskId);
        }
        if (!this.live(job)) return;
      }
      for (const material of initial?.materials?.filter(
        (m) => m.goalVersion === initial.goalVersion,
      ) ?? []) {
        if (!this.live(job)) return;
        const checked = await this.ports.material?.({
          kind: 'verify',
          taskId: job.taskId,
          materialId: material.id,
          goalVersion: material.goalVersion,
        });
        if (!this.live(job)) return;
        if (
          !z.object({ valid: z.boolean() }).parse(checked ?? { valid: false })
            .valid
        )
          throw Error('MATERIAL_CORRUPT');
      }
      let stalePlans = 0;
      for (let index = 0; index < 20; index++) {
        if (!this.live(job)) return;
        let observed = await this.abortable(
          () => this.ports.observe(job.taskId, job.abort.signal),
          job.abort.signal,
        );
        if (!this.live(job)) return;
        const current = this.ports
          .current()
          .tasks.find((t) => t.id === job.taskId)?.execution;
        if (!current) return;
        const created = current.actions
          .filter(
            (a) =>
              a.goalVersion === current.goalVersion && a.status !== 'cancelled',
          )
          .at(-1);
        if (
          created?.discoveredTarget &&
          created.targetCreation &&
          (observed.observation.url !== created.discoveredTarget.source.url ||
            !creationFieldsMatch(
              created.targetCreation,
              observed.observation,
            ) ||
            observed.observation.links?.filter(
              (l) => l.url === observed.observation.url,
            ).length !== 1 ||
            observed.observation.links?.filter(
              (l) => l.url === created.source.url,
            ).length !== 1)
        ) {
          await this.finish(
            job,
            'unknown',
            '已保存创建目标，但当前字段或身份不符；保留草稿，不重新创建。',
          );
          return;
        }
        const pending =
          current.actions.find((a) =>
            ['reserved', 'dispatched', 'unknown'].includes(a.status),
          ) ?? null;
        if (pending?.targetCreation && !pending.discoveredTarget) {
          await this.finish(
            job,
            'unknown',
            '创建已有派发记录，但缺少可靠的新目标检查点；保留未知，不再次创建。',
          );
          return;
        }
        if (pending?.action.kind === 'upload') {
          if (!(await this.waitForUpload(job, pending, observed))) return;
          continue;
        }
        const use = currentWorkflow(current);
        const workflows = availableWorkflows(this.ports.current().tasks)
          .filter(
            (w) =>
              w.replay &&
              w.applicability.origin ===
                new URL(observed.observation.url).origin,
          )
          .slice(-10)
          .map(({ taskId, version, sha256, goal, applicability, fields }) => ({
            taskId,
            version,
            sha256,
            goal,
            applicability,
            ...(fields ? { fields } : {}),
          }));
        let replay: NextStep | undefined;
        const repair = currentRepair(current);
        const replaying = use && !current.loginOrigin && !repair;
        if (replaying) {
          const deadline = Date.now() + 8000;
          for (let attempt = 0; ; attempt++) {
            try {
              replay = replayStep(current, observed.observation);
              break;
            } catch (error) {
              if (
                error instanceof Error &&
                [
                  'WORKFLOW_CONDITION_CHANGED',
                  'WORKFLOW_CONTROL_CHANGED',
                ].includes(error.message) &&
                (error.message === 'WORKFLOW_CONTROL_CHANGED' ||
                  attempt >= 7 ||
                  Date.now() >= deadline)
              ) {
                await this.record({
                  kind: 'workflow-repair',
                  taskId: job.taskId,
                  runId: job.runId,
                  id: randomUUID(),
                  useId: use.id,
                  source: observed.observation,
                  reason: error.message,
                });
                break;
              }
              if (
                !(error instanceof Error) ||
                error.message !== 'WORKFLOW_CONDITION_CHANGED' ||
                attempt >= 7 ||
                Date.now() >= deadline
              )
                throw error;
              await this.abortable(
                () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
                job.abort.signal,
              );
              if (!this.live(job)) return;
              observed = await this.abortable(
                () => this.ports.observe(job.taskId, job.abort.signal),
                job.abort.signal,
              );
              if (!this.live(job)) return;
            }
          }
          if (!replay) continue;
        }
        let step: NextStep;
        try {
          step = nextStepSchema.parse(
            replaying
              ? replay
              : await this.abortable(
                  () =>
                    this.ports.propose({
                      taskId: job.taskId,
                      runId: job.runId,
                      goal: current.goal,
                      publishingAgreement: current.agreementBinding
                        ? this.ports
                            .current()
                            .tasks.find(
                              (t) =>
                                t.id === current.agreementBinding!.ownerTaskId,
                            )
                            ?.execution?.agreements?.find(
                              (a) =>
                                a.versionId ===
                                current.agreementBinding!.versionId,
                            )?.terms
                        : undefined,
                      observation: observed.observation,
                      pending,
                      history: current.actions,
                      publication: current.publication,
                      article: current.articles?.findLast(
                        (a) => a.goalVersion === current.goalVersion,
                      ),
                      materials: current.materials?.filter(
                        (m) => m.goalVersion === current.goalVersion,
                      ),
                      preparation: current.preparation?.filter(
                        (f) => f.goalVersion === current.goalVersion,
                      ),
                      workflows:
                        use ||
                        current.actions.some(
                          (a) => a.goalVersion === current.goalVersion,
                        )
                          ? []
                          : workflows,
                      loginOrigin: current.loginOrigin,
                      coordination: current.coordination,
                      ...(repair && use
                        ? {
                            repair: {
                              parentVersion: use.workflow.version,
                              fromIndex: repair.fromIndex,
                              index: current.actions.filter(
                                (a) =>
                                  a.goalVersion === current.goalVersion &&
                                  a.status !== 'cancelled',
                              ).length,
                              targetUrl: use.targetUrl,
                              materialId: use.materialId,
                              content: use.approved?.content ?? use.content,
                              fields: use.approved?.fields ?? use.fields,
                              destination: use.destination,
                              operation: (() => {
                                const index = current.actions.filter(
                                  (a) =>
                                    a.goalVersion === current.goalVersion &&
                                    a.status !== 'cancelled',
                                ).length;
                                return index < use.workflow.steps.length
                                  ? {
                                      action: reboundAction(use, index),
                                      effect: use.workflow.steps[index]!.effect,
                                    }
                                  : null;
                              })(),
                              resultRule: use.workflow.resultRule,
                            },
                          }
                        : {}),
                      clarifications: current.answers
                        ?.filter((a) => a.goalVersion === current.goalVersion)
                        .map((a) => ({ question: a.text, answer: a.answer })),
                      signal: job.abort.signal,
                      permit: (send) =>
                        this.ports.input
                          ? this.ports.input.permit(
                              job.taskId,
                              job.inputEpoch,
                              send,
                            )
                          : send(),
                    }),
                  job.abort.signal,
                ),
          );
        } catch (error) {
          // 只重做已拒绝的只读规划；旧提议不进入预留，已有派发仍先核对结果。
          if (
            error instanceof Error &&
            error.message === 'EXECUTION_PAGE_CHANGED' &&
            stalePlans < 2 &&
            this.live(job)
          ) {
            stalePlans++;
            continue;
          }
          throw error;
        }
        if (!this.live(job)) return;
        if (repair && !withinWorkflowScope(current, step)) {
          await this.record({
            kind: 'ask',
            workflowScopeChange: true,
            taskId: job.taskId,
            runId: job.runId,
            questionId: randomUUID(),
            url: observed.observation.url,
            text: '网页变化后的做法涉及原目标、内容或操作范围之外的改变，已保留原确认并暂停。请说明是否需要修改本次委托。',
          });
          return;
        }
        if (!step.evidence.every((v) => observed.observation.text.includes(v)))
          throw Error('EXECUTION_EVIDENCE_MISSING');
        if (
          observed.session &&
          (step.coordination ||
            ['act', 'authenticated'].includes(step.decision))
        ) {
          if (
            step.coordination &&
            this.ports
              .current()
              .tasks.some(
                (t) =>
                  t.id !== job.taskId &&
                  t.execution?.coordination?.account &&
                  sameSession(
                    t.execution.coordination.session,
                    observed.session!,
                  ) &&
                  !sameAccount(
                    t.execution.coordination.account,
                    step.coordination!.account,
                  ),
              )
          )
            this.blockSessionPeers(job, observed.session);
          await this.record({
            kind: 'coordination-observed',
            taskId: job.taskId,
            runId: job.runId,
            session: observed.session,
            source: observed.observation,
            proposal: step.coordination,
            authenticated: step.decision === 'authenticated',
          });
          if (!this.live(job)) return;
        }
        if (
          step.decision === 'reuse' &&
          !step.anomalies?.length &&
          !step.extraResults?.length
        ) {
          if (!step.workflow || pending || use)
            throw Error('WORKFLOW_NOT_APPLICABLE');
          if (
            !current.materials?.some(
              (m) => m.goalVersion === current.goalVersion,
            )
          ) {
            if (!step.material || !this.ports.material)
              throw Error('WORKFLOW_NOT_APPLICABLE');
            const selected = receipt.parse(
              await this.ports.material({
                kind: 'select',
                taskId: job.taskId,
                runId: job.runId,
                selection: step.material,
              }),
            );
            if (selected.state.revision >= this.ports.current().revision)
              this.publish(selected.state);
            if (!this.live(job) || !selected.created) return;
          }
          await this.record({
            kind: 'workflow-bind',
            taskId: job.taskId,
            runId: job.runId,
            choice: step.workflow,
            source: observed.observation,
          });
          if (!this.live(job)) return;
          continue;
        }
        // 取得稳定目标或已上传依据即保存；后面的失败不能抹掉已有事实。
        if (step.preparation?.length) {
          await this.record({
            kind: 'preparation-observed',
            taskId: job.taskId,
            runId: job.runId,
            source: observed.observation,
            facts: step.preparation,
          });
          if (!this.live(job)) return;
        }
        if (step.anomalies?.length || step.extraResults?.length) {
          await this.record({
            kind: 'anomaly',
            taskId: job.taskId,
            runId: job.runId,
            source: observed.observation,
            anomalies: step.anomalies ?? [],
            extraResults: step.extraResults ?? [],
          });
          return;
        }
        // 登录障碍和未知结果分别保存。处理登录只授予观察，不把已送出的动作重发。
        if (step.decision === 'login') {
          if (observed.session) this.blockSessionPeers(job, observed.session);
          await this.record({
            kind: 'ask',
            type: 'login',
            taskId: job.taskId,
            runId: job.runId,
            questionId: randomUUID(),
            text: '请到这项任务的网页登录，完成后先核对已有结果。',
            url: observed.observation.url,
          });
          return;
        }
        if (
          step.decision === 'authenticated' &&
          current.loginOrigin &&
          new URL(observed.observation.url).origin === current.loginOrigin
        ) {
          await this.record({
            kind: 'verified-login',
            taskId: job.taskId,
            runId: job.runId,
            source: observed.observation,
            evidence: step.evidence,
          });
          continue;
        }
        if (step.decision === 'observe') {
          // 仅再取一次受控观察；保留未知派发，不给任何重送资格。
          await this.abortable(
            () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
            job.abort.signal,
          );
          continue;
        }
        // 最终提交的页面后条件不能单独消除未知；必须核对公开结果和原始字节。
        const submitted = current.actions.find(
          (a) =>
            a.goalVersion === current.goalVersion &&
            a.submission &&
            a.status !== 'cancelled',
        );
        if (
          step.decision === 'complete' &&
          current.materials?.some((m) => m.goalVersion === current.goalVersion)
        ) {
          if (!submitted || !step.result || !current.publication?.attachment)
            throw Error('PUBLICATION_RESULT_REQUIRED');
          const check = await this.abortable(
            () =>
              verifyPublication({
                execution: current,
                source: observed.observation,
                proposal: step.result!,
                actionId: submitted.id,
                signal: job.abort.signal,
              }),
            job.abort.signal,
          );
          if (!this.live(job)) return;
          await this.record({
            kind: 'publication-result',
            taskId: job.taskId,
            runId: job.runId,
            check,
          });
          return;
        }
        if (submitted) {
          await this.finish(
            job,
            'unknown',
            '最终提交已有派发记录，尚未取得可核对的结果；不会重复提交。',
          );
          return;
        }
        if (pending) {
          if (
            step.previous?.id !== pending.id ||
            step.previous.status !== 'confirmed'
          ) {
            await this.finish(
              job,
              'unknown',
              '先前已送出的操作结果仍不明，已暂停后续操作，不直接重发。',
            );
            return;
          }
          if (
            !step.previous.evidence.every((v) =>
              observed.observation.text.includes(v),
            )
          )
            throw Error('EXECUTION_EVIDENCE_MISSING');
          await this.record({
            kind: 'resolve',
            taskId: job.taskId,
            runId: job.runId,
            id: pending.id,
            source: observed.observation,
            evidence: step.previous.evidence,
          });
        }
        if (!this.live(job)) return;
        if (step.decision === 'material') {
          if (!step.material || !this.ports.material)
            throw Error('MODEL_FORMAT');
          try {
            const result = receipt.parse(
              await this.ports.material({
                kind: 'select',
                taskId: job.taskId,
                runId: job.runId,
                selection: step.material,
              }),
            );
            if (result.state.revision >= this.ports.current().revision)
              this.publish(result.state);
            if (!this.live(job) || !result.created) return;
          } catch (error) {
            if (!this.live(job)) return;
            const message =
              materialFailureMessage[
                error instanceof Error ? error.message : ''
              ];
            if (!message) {
              if (
                error instanceof Error &&
                [
                  'MATERIAL_ALREADY_FIXED',
                  'EXECUTION_RESULT_UNKNOWN',
                  'EXECUTION_STOPPED',
                ].includes(error.message)
              )
                throw error;
              this.disable();
              throw error;
            }
            await this.record({
              kind: 'ask',
              taskId: job.taskId,
              runId: job.runId,
              questionId: randomUUID(),
              text: message,
              url: observed.observation.url,
            });
            return;
          }
          continue;
        }
        if (step.decision === 'compose') {
          if (!step.compose || !this.ports.material || current.publication)
            throw Error('MODEL_FORMAT');
          try {
            const parsed = z
              .object({ source: contentSourceSchema, state: snapshotSchema })
              .parse(
                await this.ports.material({
                  kind: 'parse',
                  taskId: job.taskId,
                  runId: job.runId,
                  materialId: step.compose.materialId,
                }),
              );
            if (parsed.state.revision >= this.ports.current().revision)
              this.publish(parsed.state);
            if (!this.live(job)) return;
            const proposal = await this.abortable(
              () =>
                this.ports.propose({
                  taskId: job.taskId,
                  runId: job.runId,
                  goal: current.goal,
                  observation: observed.observation,
                  pending: null,
                  history: [],
                  contentSource: parsed.source,
                  signal: job.abort.signal,
                  permit: (send) =>
                    this.ports.input
                      ? this.ports.input.permit(
                          job.taskId,
                          job.inputEpoch,
                          send,
                        )
                      : send(),
                }),
              job.abort.signal,
            );
            if (!this.live(job)) return;
            if (proposal.decision === 'ask') {
              await this.record({
                kind: 'ask',
                taskId: job.taskId,
                runId: job.runId,
                questionId: randomUUID(),
                text: proposal.summary,
                url: observed.observation.url,
              });
              return;
            }
            if (!proposal.article || !proposal.modelCallId)
              throw Error('MODEL_FORMAT');
            await this.record({
              kind: 'article-generated',
              taskId: job.taskId,
              runId: job.runId,
              sourceId: parsed.source.id,
              draft: proposal.article,
              modelCallId: proposal.modelCallId,
            });
          } catch (error) {
            if (!this.live(job)) return;
            const message =
              excelFailureMessage[error instanceof Error ? error.message : ''];
            if (!message) throw error;
            await this.record({
              kind: 'ask',
              taskId: job.taskId,
              runId: job.runId,
              questionId: randomUUID(),
              text: message,
              url: observed.observation.url,
            });
            return;
          }
          continue;
        }
        if (step.decision === 'prepared') {
          await this.record({
            kind: 'finish',
            taskId: job.taskId,
            runId: job.runId,
            phase: 'paused',
            prepared: true,
            source: observed.observation,
            evidence: step.evidence,
            summary:
              '素材已上传并保存草稿，准备依据已记录。最终发布尚未执行；下载字节仍须独立核对。',
          });
          return;
        }
        const p = current.publication;
        const requiresLogin = !!current.loginOrigin;
        const candidate = step.publication;
        const needsReview =
          step.decision === 'review' ||
          (step.decision === 'act' &&
            (candidate || p) &&
            (!p?.approvalId ||
              !candidate ||
              p.approvalId !== step.approvalId ||
              !samePublication(p, candidate) ||
              p.origin !== new URL(observed.observation.url).origin)) ||
          (p && !p.approvalId);
        if (requiresLogin || needsReview || step.decision === 'ask') {
          const preview = candidate ?? p;
          if (!requiresLogin && needsReview && !preview)
            throw Error('MODEL_FORMAT');
          if (requiresLogin && observed.session)
            this.blockSessionPeers(job, observed.session);
          const reviewResult = await this.record({
            kind: 'ask',
            taskId: job.taskId,
            runId: job.runId,
            questionId: randomUUID(),
            ...(requiresLogin
              ? { type: 'login' }
              : needsReview && preview
                ? {
                    type: 'review',
                    publication: {
                      ...(preview.articleId
                        ? { articleId: preview.articleId }
                        : {}),
                      content: preview.content,
                      ...(preview.fields ? { fields: preview.fields } : {}),
                      destination: preview.destination,
                      ...(preview.attachment
                        ? { attachment: preview.attachment }
                        : {}),
                    },
                  }
                : {}),
            text: requiresLogin
              ? '请到这项任务的网页登录，完成后核对。'
              : needsReview
                ? '请确认本次发布的目标和内容。'
                : step.summary,
            url: observed.observation.url,
          });
          if (reviewResult.autoApproved === true) continue;
          return;
        }
        if (step.decision === 'complete') {
          await this.record({
            kind: 'finish',
            taskId: job.taskId,
            runId: job.runId,
            phase: 'complete',
            summary: step.summary,
            source: observed.observation,
            evidence: step.evidence,
          });
          return;
        }
        if (step.decision === 'wait' || !step.action) {
          await this.finish(job, 'unknown', step.summary);
          return;
        }
        if (current.coordination?.changedBy) {
          await this.record({
            kind: 'ask',
            taskId: job.taskId,
            runId: job.runId,
            questionId: randomUUID(),
            coordinationDecision: true,
            url: observed.observation.url,
            text: '另一项任务已修改这个目标，当前结果已重新读取。本项还需要改写：请说明要保留现有结果、在其基础上继续，还是明确替换。',
          });
          return;
        }
        let dispatchObservation = observed;
        let download: DownloadCheck | undefined;
        const finalAttachment =
          p?.attachment &&
          step.action.kind === 'click' &&
          (step.effect ?? 'publication') === 'publication';
        if (finalAttachment) {
          const material = current.materials?.find(
            (m) =>
              m.id === p.attachment!.materialId &&
              m.goalVersion === current.goalVersion,
          );
          if (!material) throw Error('PUBLICATION_BINDING_MISMATCH');
          download = await this.abortable(
            () => verifyAttachment(p, material, job.abort.signal),
            job.abort.signal,
          );
          if (!this.live(job)) return;
          dispatchObservation = await this.abortable(
            () => this.ports.observe(job.taskId, job.abort.signal),
            job.abort.signal,
          );
          if (!this.live(job)) return;
        }
        if (dispatchObservation.session) {
          await this.record({
            kind: 'coordination-observed',
            taskId: job.taskId,
            runId: job.runId,
            session: dispatchObservation.session,
            source: dispatchObservation.observation,
            proposal: step.coordination,
          });
          if (!this.live(job)) return;
        }
        const actionId = randomUUID();
        const reserved = await this.record({
          kind: 'reserve',
          ...(use
            ? {
                workflowStep: {
                  useId: use.id,
                  ...(repair ? { repairId: repair.id } : {}),
                  index: current.actions.filter(
                    (a) =>
                      a.goalVersion === current.goalVersion &&
                      a.status !== 'cancelled',
                  ).length,
                },
              }
            : {}),
          effect: step.effect,
          targetCreation: step.targetCreation,
          recovery: step.recovery,
          evidence: step.evidence,
          ...(download ? { download } : {}),
          ...(step.publication
            ? {
                publication: step.publication,
                approvalId: step.approvalId ?? undefined,
              }
            : {}),
          taskId: job.taskId,
          runId: job.runId,
          id: actionId,
          summary: step.summary,
          action: step.action,
          source: dispatchObservation.observation,
          binding: dispatchObservation.binding,
        });
        if (!this.live(job) || reserved.created !== true) return;
        if (dispatchObservation.session && this.ports.session) {
          const latest = await this.ports.session(job.taskId);
          if (
            !sameSession(latest, dispatchObservation.session) ||
            latest.epoch !== dispatchObservation.session.epoch
          ) {
            await this.sessionChanged(latest, [job.taskId]);
            return;
          }
        }
        const dispatched = await this.record({
          kind: 'dispatch',
          taskId: job.taskId,
          runId: job.runId,
          id: actionId,
        });
        if (!this.live(job) || dispatched.permitted !== true) return;
        let returned = false;
        try {
          await this.ports.perform({
            taskId: job.taskId,
            runId: job.runId,
            actionId,
            action: step.action,
            targetCreation: step.targetCreation,
            source: dispatchObservation.observation,
            binding: dispatchObservation.binding,
            signal: job.abort.signal,
            qualified: () => this.live(job),
          });
          returned = true;
        } finally {
          await this.record({
            kind: 'reported',
            taskId: job.taskId,
            id: actionId,
            returned,
          });
        }
        if (!this.live(job)) return;
      }
      await this.finish(
        job,
        'paused',
        '本轮已达到执行上限，已暂停。继续前将先核对已有结果。',
      );
    } catch (error) {
      if (this.live(job)) {
        const code = error instanceof Error ? error.message : '';
        await this.finish(
          job,
          code === 'EXECUTION_PAGE_CHANGED' ? 'unknown' : 'paused',
          code === 'EXECUTION_PAGE_CHANGED'
            ? '网页已变化，先核对现有结果。'
            : code === 'EXECUTION_SELECTION_UNVERIFIED'
              ? '尚不能核对网页实际选中的选项，已暂停后续操作。页面文字或旧确认不能代替当前选中状态，不会自动重选或提交。'
              : code === 'MATERIAL_CORRUPT'
                ? '本机固定素材缺失或损坏，已保留原记录并暂停；不会重读来源替换或继续提交。'
                : code.startsWith('COORDINATION_')
                  ? '网站账号、目标或权限依据已变化，已暂停并保留原现场。请先保存需要保留的网页文字，刷新并核对原账号与目标后明确继续。'
                  : code.startsWith('WORKFLOW_')
                    ? '已保存的做法与本次参数或网页条件不匹配，已暂停并保留记录，需要重新核对；不会套用旧值或重发。'
                    : '执行暂时无法继续，已暂停后续操作。已有结果与记录保留。',
        ).catch(() => {});
      }
    }
  }
  private finish(job: Job, phase: 'unknown' | 'paused', summary: string) {
    return this.record({
      kind: 'finish',
      taskId: job.taskId,
      runId: job.runId,
      phase,
      summary,
    });
  }
  async settled() {
    await Promise.allSettled([...this.reviews.values()].map((r) => r.work));
    for (;;) {
      const pump = this.pumping;
      await Promise.allSettled([
        ...this.interruptions,
        ...this.pendingReplies,
        ...this.pendingNavigations,
      ]);
      await Promise.allSettled([...this.sessionUpdates.values()]);
      if (pump) await pump;
      const jobs = [...this.jobs.values()];
      if (this.reviews.size) {
        await Promise.allSettled([...this.reviews.values()].map((r) => r.work));
        continue;
      }
      if (!jobs.length && !this.pumping) return;
      await Promise.all(jobs.map((j) => j.work));
    }
  }
  disable() {
    this.available = false;
    for (const task of this.ports.current().tasks)
      if (
        task.execution?.intent === 'automatic' &&
        task.execution.phase !== 'complete'
      ) {
        const prior = this.blocked.get(task.id);
        this.stopImmediately(
          task.id,
          '执行记录或控制连接暂不可用，已阻断新的自动操作。',
          true,
        );
        if (prior) this.blocked.set(task.id, prior);
        else
          this.blocked.set(task.id, {
            saved: true,
            message: '记录连接已中断，等待可靠记录重新核对。',
            outage: true,
          });
      }
  }
  async recordsRestored(
    state: WorkspaceSnapshot,
    unsettledTasks: readonly string[] = [],
  ) {
    this.publish(state);
    this.available = true;
    this.workspaceUnsettled = new Set(unsettledTasks);
    for (const task of state.tasks) {
      const prior = this.blocked.get(task.id),
        e = task.execution;
      if (prior?.outage) this.blocked.delete(task.id);
      else if (
        prior &&
        e &&
        ((prior.control === 'stop' && e.intent === 'stopped') ||
          (prior.reason && prior.reason === e.pauseReason))
      )
        this.blocked.set(task.id, {
          ...prior,
          saved: true,
          message: e.summary,
        });
      if (unsettledTasks.includes(task.id)) {
        const reconciled = this.blocked.get(task.id);
        this.stopImmediately(
          task.id,
          '已暂停自动操作，请核对任务变化后再明确继续。',
          true,
        );
        if (reconciled) this.blocked.set(task.id, reconciled);
      }
    }
    for (const taskId of unsettledTasks) {
      const e = this.ports
        .current()
        .tasks.find((t) => t.id === taskId)?.execution;
      if (
        e &&
        this.blocked.get(taskId)?.saved !== false &&
        ['queued', 'checking', 'running'].includes(e.phase)
      )
        await this.suspend(taskId, 'record-unavailable', randomUUID());
    }
    this.publish();
    this.pump();
  }
  workspaceSaved(unsettledTasks: readonly string[]) {
    this.workspaceUnsettled = new Set(unsettledTasks);
    this.publish();
  }
  async stopAll() {
    this.closing = true;
    // 升级暂停已经撤权；重复 trip 会改变已核对的原生现场代次。
    if (!this.upgradeHeld)
      for (const t of this.ports.current().tasks) {
        const prior = this.blocked.get(t.id);
        this.stopImmediately(t.id, '应用正在退出，已阻断新的自动操作。', true);
        if (prior) this.blocked.set(t.id, prior);
      }
    await this.settled();
  }
  cancelExit() {
    this.closing = false;
    this.publish();
  }
}
