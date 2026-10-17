import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { snapshotSchema, type WorkspaceSnapshot } from '../shared/contracts';
import {
  executionIntentSchema,
  nextStepSchema,
  type ExecutionIntent,
  type NextStep,
  type ActionFact,
  type WebAction,
  type ExecutionPauseReason,
  pauseDescription,
} from '../shared/execution';
import type { PageObservation } from '../shared/model';

export type BoundObservation = {
  observation: PageObservation;
  binding: { targetId: string; generation: number };
};
export type ProposalInput = {
  taskId: string;
  runId: string;
  goal: string;
  observation: PageObservation;
  pending: ActionFact | null;
  history: ActionFact[];
  signal: AbortSignal;
  permit?: <T>(send: () => T) => T;
};
export type WebActionJob = {
  taskId: string;
  runId: string;
  actionId: string;
  action: WebAction;
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
    recovered: z.boolean().optional(),
  })
  .passthrough();
/** 任务意图与派发公开入口。记录进程之外保留即时阻断，所有等待之后重新核对。 */
export class ExecutionService {
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
      revoke: (taskId: string) => void;
      stopModels: (taskId: string) => void;
      beforeRecovery?: () => Promise<void>;
      input?: {
        prepare: (taskId: string) => Promise<number>;
        block: (taskId: string) => void;
        allow: (taskId: string, epoch: number) => boolean;
        epoch: (taskId: string) => number;
        valid: (taskId: string, epoch: number) => boolean;
        permit: <T>(taskId: string, epoch: number, send: () => T) => T;
      };
    },
  ) {}
  canExit() {
    return (
      this.pendingIntents.size === 0 &&
      this.workspaceUnsettled.size === 0 &&
      ![...this.blocked.values()].some((b) => !b.saved)
    );
  }
  decorate(state: WorkspaceSnapshot): WorkspaceSnapshot {
    return {
      ...state,
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
          : t;
      }),
    };
  }
  private publish(state = this.ports.current()) {
    this.ports.publish(state);
  }
  private async record(command: unknown) {
    const sequence = ++this.recordSequence;
    try {
      const result = receipt.parse(await this.ports.records(command));
      this.latestRecordSuccess = Math.max(this.latestRecordSuccess, sequence);
      this.publish(result.state);
      return { ...result, receiptSequence: sequence };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        sequence > this.latestRecordSuccess &&
        ![
          'REQUEST_CONTENT_CONFLICT',
          'RECORD_VERSION_CONFLICT',
          'TASK_NOT_FOUND',
          'INVALID_REQUEST',
          'EXECUTION_STOPPED',
          'EXECUTION_CONTINUE_REQUIRED',
          'EXECUTION_RESULT_UNKNOWN',
          'EXECUTION_PAGE_CHANGED',
          'EXECUTION_LIMIT',
          'EXECUTION_EVIDENCE_MISSING',
        ].includes(code)
      ) {
        this.latestRecordFailure = Math.max(this.latestRecordFailure, sequence);
        this.disable();
      }
      throw error;
    }
  }
  private stopImmediately(taskId: string, message: string, saved = false) {
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
    this.ports.input?.block(taskId);
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
      this.pump();
    }
  }
  async intent(input: ExecutionIntent): Promise<WorkspaceSnapshot> {
    const command = executionIntentSchema.parse(input);
    const priorBlock = this.blocked.get(command.taskId);
    let recordStarted = false;
    if (this.closing) throw Error('APPLICATION_EXITING');
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
      // 准备能力失败时尚未请求新保存，保留先前已可靠保存的暂停／停止。
      if (
        !recordStarted &&
        priorBlock?.saved &&
        this.intents.get(command.taskId) === sequence
      )
        this.blocked.set(command.taskId, priorBlock);
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
      !this.closing &&
      !job.abort.signal.aborted &&
      !this.blocked.has(job.taskId) &&
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
  private pump() {
    if (!this.available || this.closing) return;
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
    for (const task of this.ports.current().tasks) {
      if (!this.available || this.closing) return;
      if (
        task.execution?.phase !== 'queued' ||
        this.jobs.has(task.id) ||
        this.blocked.has(task.id) ||
        this.pendingIntents.has(task.id)
      )
        continue;
      if (task.execution.recoveryPending) {
        const version = task.execution.version;
        const sequence = this.intents.get(task.id);
        try {
          await this.ports.beforeRecovery?.();
          const epoch = await this.ports.input?.prepare(task.id);
          if (
            !this.available ||
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
      const claim = await this.record({
        kind: 'claim',
        taskId: task.id,
        runId,
      });
      if (!claim.claimed) continue;
      const current = claim.state.tasks.find(
        (t) => t.id === task.id,
      )?.execution;
      if (!current) continue;
      const job: Job = {
        taskId: task.id,
        runId,
        version: current.version,
        inputEpoch: this.ports.input?.epoch(task.id) ?? 0,
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
  private async run(job: Job) {
    try {
      for (let index = 0; index < 20; index++) {
        if (!this.live(job)) return;
        const observed = await this.abortable(
          () => this.ports.observe(job.taskId, job.abort.signal),
          job.abort.signal,
        );
        if (!this.live(job)) return;
        const current = this.ports
          .current()
          .tasks.find((t) => t.id === job.taskId)?.execution;
        if (!current) return;
        const pending =
          current.actions.find((a) =>
            ['reserved', 'dispatched', 'unknown'].includes(a.status),
          ) ?? null;
        const step = nextStepSchema.parse(
          await this.abortable(
            () =>
              this.ports.propose({
                taskId: job.taskId,
                runId: job.runId,
                goal: current.goal,
                observation: observed.observation,
                pending,
                history: current.actions,
                signal: job.abort.signal,
                permit: (send) =>
                  this.ports.input
                    ? this.ports.input.permit(job.taskId, job.inputEpoch, send)
                    : send(),
              }),
            job.abort.signal,
          ),
        );
        if (!this.live(job)) return;
        if (!step.evidence.every((v) => observed.observation.text.includes(v)))
          throw Error('EXECUTION_EVIDENCE_MISSING');
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
        const actionId = randomUUID();
        const reserved = await this.record({
          kind: 'reserve',
          taskId: job.taskId,
          runId: job.runId,
          id: actionId,
          summary: step.summary,
          action: step.action,
          source: observed.observation,
          binding: observed.binding,
        });
        if (!this.live(job) || reserved.created !== true) return;
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
            source: observed.observation,
            binding: observed.binding,
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
    for (;;) {
      const pump = this.pumping;
      if (pump) await pump;
      const jobs = [...this.jobs.values()];
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
