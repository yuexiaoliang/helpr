import { createHash } from 'node:crypto';
import { lstatSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  cleanupCommandSchema,
  type CleanupPreview,
  type CleanupReceipt,
} from '../shared/cleanup';
import type { WorkspaceSnapshot } from '../shared/contracts';
import * as schema from './schema';

/** 清理仅释放明确选中的素材副本。引用事实先提交；文件删除失败只留下冗余副本。 */
export class CleanupRecords {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly snapshot: () => WorkspaceSnapshot,
    private readonly folder: string,
    private readonly busy: () => boolean,
  ) {}
  private preview(taskIds: string[]): CleanupPreview {
    const state = this.snapshot();
    const tasks = taskIds.map((taskId) => {
      const task = state.tasks.find((t) => t.id === taskId),
        e = task?.execution;
      let reason = '';
      if (
        !e ||
        e.phase !== 'complete' ||
        e.runId ||
        e.question ||
        e.recoveryPending ||
        (e.restoreReview && e.restoreReview !== 'complete') ||
        e.pauseReason ||
        e.actions.some((a) => !['confirmed', 'cancelled'].includes(a.status)) ||
        e.resourceClaims?.some((r) => r.status !== 'released') ||
        e.materialProcessing?.some((m) => m.status !== 'complete') ||
        e.materialWorks?.some((m) => m.status !== 'complete')
      )
        reason = '任务仍可继续、结果待核对或目标占用尚未释放，保留全部资料。';
      else if (
        e.schedule ||
        e.scheduleOrigin ||
        e.agreements?.length ||
        e.agreementBinding
      )
        reason = '任务关联定时计划或发布约定，保留取材及核对依据。';
      else if (e.historyCleanup)
        reason = '已提交清理，处理事实与证明继续保留。';
      else if (
        this.db
          .select()
          .from(schema.modelCalls)
          .where(eq(schema.modelCalls.taskId, taskId))
          .all()
          .some((m) => ['preparing', 'sending', 'streaming'].includes(m.phase))
      )
        reason = '模型请求尚未结束，保留资料。';
      else {
        // 完整结构化记录中的 UUID 引用保守保护；不根据目标网址相同推定共享归属。
        const ids = [
          taskId,
          ...(e.materials ?? []).map((m) => m.id),
          ...(e.learnedWorkflows ?? []).map((w) => w.version),
        ];
        if (
          state.tasks.some(
            (other) =>
              other.id !== taskId &&
              ids.some((id) =>
                JSON.stringify(other.execution ?? null).includes(
                  JSON.stringify(id),
                ),
              ),
          )
        )
          reason = '其它任务、流程或计划仍引用本项资料。';
        else if (!e.materials?.length) reason = '没有可释放的素材副本。';
      }
      return {
        taskId,
        eligible: !reason,
        reason:
          reason || '仅清理固定素材副本；保留会话、处理事实、流程和结果证明。',
      };
    });
    const eligible = new Set(
      tasks.filter((t) => t.eligible).map((t) => t.taskId),
    );
    const files = new Map<string, { sha256: string; bytes: number }>();
    for (const task of state.tasks) {
      if (!eligible.has(task.id)) continue;
      for (const m of task.execution?.materials ?? []) {
        if (m.discardedAt !== undefined) continue;
        if (
          state.tasks.some(
            (other) =>
              !eligible.has(other.id) &&
              other.execution?.materials?.some(
                (v) => v.sha256 === m.sha256 && v.discardedAt === undefined,
              ),
          )
        )
          continue;
        const file = this.file(m.sha256);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== m.bytes)
          throw Error('CLEANUP_FILE_CHANGED');
        files.set(m.sha256, { sha256: m.sha256, bytes: m.bytes });
      }
    }
    // 共享副本仍在使用时，不把其对应历史标记成已清理。
    for (const task of tasks)
      if (task.eligible) {
        const e = state.tasks.find((t) => t.id === task.taskId)!.execution!;
        if (e.materials!.some((m) => !files.has(m.sha256))) {
          task.eligible = false;
          task.reason = '素材副本仍被未选中或受保护的任务共享，保留全部资料。';
        }
      }
    // 保守固定点：一个任务被保护后，它的所有素材继续保护其它选中任务。
    let changed = true;
    while (changed) {
      changed = false;
      const retained = new Set(
        state.tasks
          .filter((t) => !tasks.some((p) => p.taskId === t.id && p.eligible))
          .flatMap((t) =>
            (t.execution?.materials ?? [])
              .filter((m) => m.discardedAt === undefined)
              .map((m) => m.sha256),
          ),
      );
      for (const t of tasks)
        if (
          t.eligible &&
          state.tasks
            .find((s) => s.id === t.taskId)!
            .execution!.materials!.some((m) => retained.has(m.sha256))
        ) {
          t.eligible = false;
          t.reason = '共享素材仍需保留。';
          changed = true;
        }
    }
    const removable = new Set(
      state.tasks
        .filter((t) => tasks.some((p) => p.taskId === t.id && p.eligible))
        .flatMap((t) => t.execution!.materials!.map((m) => m.sha256)),
    );
    const list = [...files.values()].filter((f) => removable.has(f.sha256));
    return {
      tasks,
      files: list,
      bytes: list.reduce((n, f) => n + f.bytes, 0),
      token: createHash('sha256')
        .update(JSON.stringify({ taskIds, state, tasks, files: list }))
        .digest('hex'),
    };
  }
  private file(sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw Error('CLEANUP_FILE_CHANGED');
    const dir = path.join(this.folder, 'materials');
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('CLEANUP_FILE_CHANGED');
    return path.join(dir, sha);
  }
  execute(input: unknown) {
    const c = cleanupCommandSchema.parse(input);
    if (new Set(c.taskIds).size !== c.taskIds.length)
      throw Error('INVALID_REQUEST');
    if (this.busy()) throw Error('CLEANUP_BUSY');
    if (c.kind === 'cleanup-preview') return this.preview(c.taskIds);
    const prior = this.snapshot().tasks.filter(
      (t) => t.execution?.historyCleanup?.requestId === c.requestId,
    );
    if (prior.length) {
      if (
        prior.length !== c.taskIds.length ||
        prior.some(
          (t) =>
            !c.taskIds.includes(t.id) ||
            t.execution!.historyCleanup!.token !== c.token,
        )
      )
        throw Error('REQUEST_CONTENT_CONFLICT');
    } else {
      this.db.transaction(
        () => {
          const preview = this.preview(c.taskIds);
          if (preview.token !== c.token) throw Error('CLEANUP_CHANGED');
          if (preview.tasks.some((t) => !t.eligible) || !preview.files.length)
            throw Error('CLEANUP_PROTECTED');
          const at = Date.now();
          for (const task of this.snapshot().tasks.filter((t) =>
            c.taskIds.includes(t.id),
          )) {
            const e = task.execution!;
            e.version++;
            e.historyCleanup = { requestId: c.requestId, token: c.token, at };
            for (const m of e.materials!) m.discardedAt = at;
            this.db
              .update(schema.executions)
              .set({ body: e })
              .where(eq(schema.executions.taskId, task.id))
              .run();
          }
          this.db
            .update(schema.workspace)
            .set({ revision: sql`${schema.workspace.revision}+1` })
            .run();
        },
        { behavior: 'immediate' },
      );
    }
    // 同步边界内无新的领取、素材写入或备份进入。崩溃最多留下不再被执行引用的文件。
    const state = this.snapshot();
    const files = new Map(
      state.tasks
        .filter((t) => c.taskIds.includes(t.id))
        .flatMap((t) =>
          (t.execution?.materials ?? []).map(
            (m) => [m.sha256, m.bytes] as const,
          ),
        ),
    );
    let removedBytes = 0,
      pendingFiles = 0;
    for (const [sha, bytes] of files) {
      if (
        state.tasks.some((t) =>
          t.execution?.materials?.some(
            (m) => m.sha256 === sha && m.discardedAt === undefined,
          ),
        )
      )
        continue;
      try {
        const file = this.file(sha),
          stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes)
          throw Error('CLEANUP_FILE_CHANGED');
        unlinkSync(file);
        removedBytes += bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') pendingFiles++;
      }
    }
    try {
      const fd = openSync(path.join(this.folder, 'materials'), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      pendingFiles++;
    }
    const receipt: CleanupReceipt = {
      requestId: c.requestId,
      phase: pendingFiles ? 'pending' : 'complete',
      removedBytes,
      pendingFiles,
    };
    return { ...receipt, state };
  }
}
