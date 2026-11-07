import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { executionSchema, type TaskExecution } from '../shared/execution';
import { agreementSummary, type AgreementVersion } from '../shared/agreement';
import {
  materialFailureMessage,
  type MaterialVersion,
} from '../shared/material';
import {
  latestOccurrence,
  scheduleTermsSchema,
  scheduleUICommandSchema,
  scheduleSummary,
  validateSchedule,
  type ScheduleRound,
  type Occurrence,
} from '../shared/schedule';
import { activeAgreement, workKey } from './agreement';
import { MaterialFiles } from './material';
import { ExecutionRecords } from './execution';
import * as schema from './schema';

const commands = z.union([
  ...scheduleUICommandSchema.options.slice(1),
  z.strictObject({
    kind: z.literal('schedule-propose'),
    taskId: z.string(),
    requestId: z.string(),
    expectedRevision: z.number(),
    text: z.string(),
    terms: scheduleTermsSchema,
  }),
  z.strictObject({
    kind: z.literal('prepare'),
    taskId: z.string(),
    now: z.number().int(),
    roundId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('commit'), token: z.string() }),
]);
type Prepared = {
  taskId: string;
  revision: number;
  versionId: string;
  occurrence: Occurrence;
  now: number;
  from: number;
  status: ScheduleRound['status'];
  reason: string;
  roundId?: string;
  materials?: MaterialVersion[];
  failure?: string;
  reply?: { id: string; hash: string };
};

/** 时间候选和文件读取不产生工作。临近派发再交回不透明 token，事务领取轮次和素材。 */
export class ScheduleRecords {
  private readonly prepared = new Map<string, Prepared>();
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly executions: ExecutionRecords,
    private readonly files: MaterialFiles,
    private readonly held: () => boolean,
  ) {}
  private rows() {
    return this.db
      .select()
      .from(schema.executions)
      .all()
      .map((r) => ({
        taskId: r.taskId,
        execution: executionSchema.parse(r.body),
      }));
  }
  private save(taskId: string, e: TaskExecution) {
    executionSchema.parse(e);
    this.db
      .update(schema.executions)
      .set({ body: e })
      .where(eq(schema.executions.taskId, taskId))
      .run();
    this.db
      .update(schema.workspace)
      .set({ revision: sql`${schema.workspace.revision}+1` })
      .run();
  }
  private agreement(e: TaskExecution, versionId: string) {
    const a = e.agreements?.find((a) => a.versionId === versionId);
    if (!a || !activeAgreement(a)) throw Error('AGREEMENT_EXPIRED');
    return a;
  }
  private binding(
    taskId: string,
    a: AgreementVersion,
    occurrence: Occurrence,
    period: 'date' | 'round',
  ) {
    return {
      ownerTaskId: taskId,
      agreementId: a.id,
      versionId: a.versionId,
      goalVersion: 1,
      periodKey:
        a.terms.period === 'per-period'
          ? period === 'date'
            ? occurrence.date
            : occurrence.local
          : '',
      repeatOf: null,
      repeatIntent: '',
    };
  }
  private cancel(taskId: string, e: TaskExecution) {
    const s = e.schedule!;
    const v = s.versions.at(-1)!;
    if (v.cancelledAt !== null) return;
    v.cancelledAt = Date.now();
    for (const round of s.rounds) {
      if (round.status === 'waiting') {
        round.status = 'skipped';
        round.reason = '计划已修改或取消，未开始轮次不再派发。';
      }
      for (const link of round.links) {
        // 引用到的旧工作不属于本计划新建的任务，不能替它停止或继续。
        if (!link.created) continue;
        const other = this.executions.get(link.taskId)!;
        if (other.phase === 'complete' || other.intent === 'stopped') continue;
        this.executions.execute({
          kind: 'intent',
          taskId: link.taskId,
          requestId: randomUUID(),
          intent: 'stop',
        });
      }
    }
    void taskId;
  }
  async execute(input: unknown): Promise<Record<string, unknown>> {
    const c = commands.parse(input);
    if (c.kind === 'prepare') return this.prepare(c);
    if (c.kind === 'commit') return this.commit(c.token);
    if (c.kind === 'schedule-prepare') throw Error('INVALID_REQUEST');
    if (c.kind === 'schedule-decide' && c.decision === 'run') {
      const hash = createHash('sha256').update(JSON.stringify(c)).digest('hex');
      const previous = this.db
        .select()
        .from(schema.executionRequests)
        .where(eq(schema.executionRequests.id, c.requestId))
        .get();
      if (previous) {
        if (previous.hash !== hash) throw Error('REQUEST_CONTENT_CONFLICT');
        return { changed: false };
      }
      // 重新取材仍通过 prepare/commit，UI 不可直接提供素材或派发。
      return this.prepare({
        kind: 'prepare',
        taskId: c.taskId,
        now: Date.now(),
        roundId: c.roundId,
        reply: { id: c.requestId, hash },
      });
    }
    return this.db.transaction(
      () => {
        if (this.held() && c.kind !== 'schedule-cancel')
          throw Error('UPGRADE_PENDING');
        const hash = createHash('sha256')
          .update(JSON.stringify(c))
          .digest('hex');
        const old = this.db
          .select()
          .from(schema.executionRequests)
          .where(eq(schema.executionRequests.id, c.requestId))
          .get();
        if (old) {
          if (old.hash !== hash) throw Error('REQUEST_CONTENT_CONFLICT');
          return { changed: false };
        }
        const e = this.executions.get(c.taskId);
        if (!e) throw Error('EXECUTION_NOT_FOUND');
        let s = e.schedule;
        if (c.kind === 'schedule-propose') {
          if ((s?.revision ?? 0) !== c.expectedRevision)
            throw Error('RECORD_VERSION_CONFLICT');
          validateSchedule(c.terms);
          const a = e.agreements?.at(-1);
          if (!a || !activeAgreement(a)) throw Error('AGREEMENT_EXPIRED');
          if (s) this.cancel(c.taskId, e);
          s ??= {
            revision: 0,
            cursor: Date.now() - 1,
            restoreReview: false,
            versions: [],
            rounds: [],
          };
          const last = s.versions.at(-1);
          s.versions.push({
            id: last?.id ?? randomUUID(),
            versionId: randomUUID(),
            version: (last?.version ?? 0) + 1,
            agreementVersionId: a.versionId,
            terms: c.terms,
            requestId: c.requestId,
            request: c.text,
            createdAt: Date.now(),
            acceptedAt: null,
            cancelledAt: null,
          });
          e.schedule = s;
        } else {
          if (!s) throw Error('SCHEDULE_EXPIRED');
          const v = s.versions.at(-1)!;
          if ('versionId' in c && c.versionId !== v.versionId)
            throw Error('SCHEDULE_EXPIRED');
          if (c.kind === 'schedule-cancel') this.cancel(c.taskId, e);
          else if (c.kind === 'schedule-accept') {
            if (v.cancelledAt !== null || v.acceptedAt !== null)
              throw Error('SCHEDULE_EXPIRED');
            this.agreement(e, v.agreementVersionId);
            validateSchedule(v.terms, true);
            v.acceptedAt = Date.now();
            s.cursor = Math.max(s.cursor, v.acceptedAt);
            s.restoreReview = false;
          } else if (c.kind === 'schedule-resume') {
            if (
              !s.restoreReview ||
              v.cancelledAt !== null ||
              v.acceptedAt === null
            )
              throw Error('SCHEDULE_EXPIRED');
            this.agreement(e, v.agreementVersionId);
            const referenced = s.rounds
              .flatMap((r) => r.links)
              .map((l) => this.executions.get(l.taskId));
            if (
              referenced.some(
                (x) =>
                  x?.restoreReview &&
                  !['ready', 'complete'].includes(x.restoreReview),
              )
            )
              throw Error('BACKUP_REVIEW_REQUIRED');
            s.restoreReview = false;
          } else if (c.kind === 'schedule-decide') {
            const round = s.rounds.find(
              (r) =>
                r.id === c.roundId &&
                r.versionId === v.versionId &&
                r.status === 'waiting',
            );
            if (!round) throw Error('SCHEDULE_EXPIRED');
            round.status = 'skipped';
            round.reason = '用户明确跳过这个未开始轮次。';
          }
        }
        s.revision++;
        e.version++;
        this.save(c.taskId, e);
        this.db
          .insert(schema.executionRequests)
          .values({ id: c.requestId, hash, taskId: c.taskId })
          .run();
        this.db
          .insert(schema.messages)
          .values({
            taskId: c.taskId,
            role: c.kind === 'schedule-propose' ? 'system' : 'user',
            text:
              c.kind === 'schedule-propose'
                ? '待接受的定时计划：' + scheduleSummary(c.terms)
                : {
                    'schedule-accept': '接受这个定时计划',
                    'schedule-cancel':
                      '取消定时计划，阻止尚未派发动作；已产生效果仍需核对。',
                    'schedule-resume': '已核对恢复资料，明确继续这个计划。',
                    'schedule-decide': '跳过这个未开始轮次。',
                  }[c.kind],
          })
          .run();
        return { changed: true };
      },
      { behavior: 'immediate' },
    );
  }
  private async prepare(c: {
    kind: 'prepare';
    taskId: string;
    now: number;
    roundId?: string;
    reply?: { id: string; hash: string };
  }) {
    if (this.held()) throw Error('UPGRADE_PENDING');
    const e = this.executions.get(c.taskId),
      s = e?.schedule,
      v = s?.versions.at(-1);
    if (
      !e ||
      !s ||
      !v ||
      s.restoreReview ||
      v.acceptedAt === null ||
      v.cancelledAt !== null
    )
      return { token: null };
    const a = this.agreement(e, v.agreementVersionId);
    const pending = c.roundId
      ? s.rounds.find(
          (r) =>
            r.id === c.roundId &&
            r.versionId === v.versionId &&
            r.status === 'waiting',
        )
      : undefined;
    if (c.roundId && !pending) throw Error('SCHEDULE_EXPIRED');
    const occurrence = pending?.occurrence ?? latestOccurrence(v.terms, c.now);
    if (!occurrence || (!pending && occurrence.dueAt <= s.cursor))
      return { token: null };
    const missed = c.now > occurrence.dueAt + v.terms.graceSeconds * 1000;
    const policy = pending
      ? 'run'
      : occurrence.treatment !== 'run'
        ? occurrence.treatment
        : missed
          ? v.terms.missed
          : 'run';
    const p: Prepared = {
      taskId: c.taskId,
      revision: s.revision,
      versionId: v.versionId,
      occurrence,
      now: c.now,
      from: pending?.from ?? s.cursor,
      status:
        policy === 'skip'
          ? 'skipped'
          : policy === 'ask' || policy === null
            ? 'waiting'
            : 'claimed',
      reason: pending
        ? '用户明确补做此轮一次；不代答原任务参与请求。'
        : occurrence.ambiguity
          ? `夏令时${occurrence.ambiguity === 'gap' ? '不存在' : '重复'}时刻按约定处理。`
          : missed
            ? '错过未开始的轮次，按本计划约定处理最近一次。'
            : '到点按约定取材。',
      ...(pending ? { roundId: pending.id } : {}),
      ...(c.reply ? { reply: c.reply } : {}),
    };
    if (p.status === 'claimed') {
      const binding = this.binding(c.taskId, a, occurrence, v.terms.periodKey);
      const complete = new Set(
        this.rows()
          .flatMap((r) => r.execution.materialWorks ?? [])
          .filter(
            (w) =>
              w.status === 'complete' &&
              w.key === workKey(a, { sha256: w.sha256, binding }),
          )
          .map((w) => w.sha256),
      );
      try {
        p.materials = await this.files.selectMany(
          { ...a.terms.selection, basis: agreementSummary(a.terms) },
          [agreementSummary(a.terms)],
          1,
          occurrence.date,
          complete,
        );
      } catch (error) {
        p.failure =
          materialFailureMessage[error instanceof Error ? error.message : ''] ??
          '无法按计划确定素材，请核对取材规则。';
      }
    }
    for (const [token, previous] of this.prepared)
      if (previous.taskId === c.taskId) this.prepared.delete(token);
    const token = randomUUID();
    this.prepared.set(token, p);
    return { token };
  }
  private commit(token: string) {
    const p = this.prepared.get(token);
    this.prepared.delete(token);
    if (!p) return { changed: false };
    return this.db.transaction(
      () => {
        if (this.held()) throw Error('UPGRADE_PENDING');
        let e = this.executions.get(p.taskId)!;
        const s = e.schedule,
          v = s?.versions.at(-1);
        if (
          !s ||
          !v ||
          s.revision !== p.revision ||
          v.versionId !== p.versionId ||
          s.restoreReview ||
          v.cancelledAt !== null ||
          v.acceptedAt === null
        ) {
          if (p.roundId) throw Error('RECORD_VERSION_CONFLICT');
          return { changed: false };
        }
        const a = this.agreement(e, v.agreementVersionId);
        if (
          !p.roundId &&
          s.rounds.some((r) => r.occurrence.key === p.occurrence.key)
        )
          return { changed: false };
        const links: ScheduleRound['links'] = [];
        const roundId = p.roundId ?? randomUUID();
        const create = (material?: MaterialVersion) => {
          const requestId = 'schedule:' + randomUUID();
          const created = this.executions.execute({
            kind: 'agreement-use',
            taskId: p.taskId,
            requestId,
            versionId: a.versionId,
            periodKey: this.binding(
              p.taskId,
              a,
              p.occurrence,
              v.terms.periodKey,
            ).periodKey,
            repeatOf: null,
          });
          const taskId = z.string().parse(created.taskId);
          this.executions.execute({
            kind: 'agreement-material',
            taskId,
            expectedVersion: 1,
            ...(material ? { material } : { failure: p.failure }),
          });
          const result = this.executions.get(taskId)!;
          result.scheduleOrigin = {
            ownerTaskId: p.taskId,
            roundId,
            versionId: v.versionId,
            date: p.occurrence.date,
          };
          this.save(taskId, result);
          links.push({
            taskId,
            created: true,
            workId: result.materialWorks?.[0]?.id ?? null,
            sha256: material?.sha256 ?? null,
          });
        };
        if (p.failure) create();
        for (const material of p.materials ?? []) {
          const binding = this.binding(
            p.taskId,
            a,
            p.occurrence,
            v.terms.periodKey,
          );
          const key = workKey(a, { binding, sha256: material.sha256 });
          const old = this.rows()
            .flatMap((r) =>
              (r.execution.materialWorks ?? []).map((w) => ({
                taskId: r.taskId,
                work: w,
              })),
            )
            .find((r) => r.work.key === key);
          if (old)
            links.push({
              taskId: old.taskId,
              created: false,
              workId: old.work.id,
              sha256: material.sha256,
            });
          else create(material);
        }
        // agreement-use 修改同一个拥有者；重新读取，避免覆盖其它关联事实。
        e = this.executions.get(p.taskId)!;
        const latest = e.schedule!;
        const round: ScheduleRound = {
          id: roundId,
          planId: v.id,
          versionId: v.versionId,
          occurrence: p.occurrence,
          from: p.from,
          checkedAt: p.now,
          status: p.status,
          reason:
            p.status === 'claimed' && !links.length
              ? '本轮没有尚未完成的合格素材，未新建任务。'
              : p.reason,
          links,
        };
        if (p.roundId)
          latest.rounds[latest.rounds.findIndex((r) => r.id === p.roundId)] =
            round;
        else {
          for (const old of latest.rounds)
            if (
              old.status === 'waiting' &&
              old.occurrence.dueAt < round.occurrence.dueAt
            ) {
              old.status = 'skipped';
              old.reason =
                '按计划只保留最近一次未开始轮次，较早待选择轮次已跳过。';
            }
          latest.rounds.push(round);
        }
        latest.cursor = Math.max(latest.cursor, p.occurrence.dueAt);
        latest.revision++;
        e.version++;
        this.save(p.taskId, e);
        if (p.reply)
          this.db
            .insert(schema.executionRequests)
            .values({ ...p.reply, taskId: p.taskId })
            .run();
        return { changed: true };
      },
      { behavior: 'immediate' },
    );
  }
}

export function validScheduleCatalog(
  rows: { taskId: string; execution?: TaskExecution | null }[],
) {
  try {
    const planIds = new Set<string>();
    const versionIds = new Set<string>();
    for (const { taskId, execution: e } of rows) {
      if (e?.scheduleOrigin) {
        const origin = e.scheduleOrigin;
        const round = rows
          .find((r) => r.taskId === origin.ownerTaskId)
          ?.execution?.schedule?.rounds.find((r) => r.id === origin.roundId);
        if (
          !round ||
          round.versionId !== origin.versionId ||
          round.occurrence.date !== origin.date ||
          !round.links.some((l) => l.taskId === taskId && l.created)
        )
          return false;
      }
      const s = e?.schedule;
      if (!s) continue;
      const id = s.versions[0]!.id;
      if (planIds.has(id)) return false;
      planIds.add(id);
      for (const [i, v] of s.versions.entries()) {
        if (versionIds.has(v.versionId)) return false;
        versionIds.add(v.versionId);
        validateSchedule(v.terms, v.acceptedAt !== null);
        if (
          v.id !== id ||
          v.version !== i + 1 ||
          (v.acceptedAt !== null && v.acceptedAt < v.createdAt) ||
          (v.cancelledAt !== null && v.cancelledAt < v.createdAt) ||
          (i < s.versions.length - 1 && v.cancelledAt === null) ||
          !e?.agreements?.some(
            (a) =>
              a.versionId === v.agreementVersionId && a.acceptedAt !== null,
          )
        )
          return false;
      }
      if (
        new Set(s.rounds.map((r) => r.id)).size !== s.rounds.length ||
        new Set(s.rounds.map((r) => r.occurrence.key)).size !== s.rounds.length
      )
        return false;
      for (const r of s.rounds) {
        if (
          r.planId !== id ||
          r.occurrence.key !== String(r.occurrence.dueAt) ||
          r.occurrence.dueAt > s.cursor ||
          !s.versions.some(
            (v) => v.versionId === r.versionId && v.acceptedAt !== null,
          ) ||
          (r.status !== 'claimed' && r.links.length)
        )
          return false;
        for (const link of r.links) {
          const linked = rows.find(
            (row) => row.taskId === link.taskId,
          )?.execution;
          if (
            !linked ||
            (link.created &&
              (linked.scheduleOrigin?.roundId !== r.id ||
                linked.scheduleOrigin.ownerTaskId !== taskId)) ||
            (link.workId &&
              !linked.materialWorks?.some(
                (w) => w.id === link.workId && w.sha256 === link.sha256,
              ))
          )
            return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
