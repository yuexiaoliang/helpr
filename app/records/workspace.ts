import { CleanupRecords } from './cleanup';
import { ScheduleRecords, validScheduleCatalog } from './schedule';
import { agreementSummary } from '../shared/agreement';
import { materialFailureMessage } from '../shared/material';
import {
  boundAgreement,
  activeAgreement,
  validAgreementCatalog,
} from './agreement';
import { validPublicationReferences, validWorkflowCatalog } from './workflow';
import { endedExecution, splitDelegation } from '../shared/task-groups';
import { hideTaskTab } from './task-tab';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, sql } from 'drizzle-orm';
import { createMachine, transition } from 'xstate';
import {
  mkdirSync,
  chmodSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  lstatSync,
} from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import {
  recordCommandSchema,
  snapshotSchema,
  type Task,
  type WorkspaceSnapshot,
} from '../shared/contracts';
import { websiteURL } from '../shared/url-policy';
import * as schema from './schema';
import { ModelRecords } from './model';
import { ExecutionRecords } from './execution';
import { executionSchema } from '../shared/execution';
import { BackupRecords } from './backup';
import { UpgradeRecords } from './upgrade';
import { z } from 'zod';
import { MaterialFiles } from './material';
import { materialSelectionSchema } from '../shared/material';
import { parseExcel } from './excel';
import {
  contentRequirements,
  contentSourceHash,
  validArticleModelCalls,
} from './article';
import { archivedModelCallSchema } from '../shared/model';
import { contentSourceSchema } from '../shared/article';
import {
  CURRENT_DATA_FORMAT,
  CURRENT_STATE_MODEL,
} from '../shared/record-format';

// 本项只有手动网页状态；计算转换不启动 actor、invocation 或网页动作。
const lifecycle = createMachine({
  id: 'workspace-task',
  initial: 'no-page',
  on: { LOAD: '.loading', READY: '.manual', FAIL: '.error' },
  states: { 'no-page': {}, loading: {}, manual: {}, error: {} },
});
function pagePhase(
  phase: Task['phase'],
  event: 'LOAD' | 'READY' | 'FAIL',
): Task['phase'] {
  const [next] = transition(
    lifecycle,
    lifecycle.resolveState({ value: phase, context: {} }),
    { type: event },
  );
  return snapshotSchema.shape.tasks.element.shape.phase.parse(next.value);
}

/** 记录拥有者的公开入口。仅在独立受管进程使用，提交成功后才返回投影。 */
export class WorkspaceRecords {
  private readonly cleanupRecords: CleanupRecords;
  private readonly models: ModelRecords;
  private readonly executions: ExecutionRecords;
  private readonly sqlite: Database.Database;
  private readonly db: ReturnType<typeof drizzle<typeof schema>>;
  private readonly backups: BackupRecords;
  private readonly upgrades: UpgradeRecords;
  private readonly schedules: ScheduleRecords;
  private readonly materials: MaterialFiles;
  private readonly materialWork = new Set<Promise<unknown>>();
  constructor(folder: string, migrations: string, validation = false) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.materials = new MaterialFiles(folder);
    const marker = path.join(folder, '.workspace-records');
    if (
      existsSync(marker) &&
      !existsSync(path.join(folder, 'workspace.sqlite'))
    )
      throw Error('DATA_MISSING');
    if (existsSync(marker)) {
      const file = lstatSync(path.join(folder, 'workspace.sqlite'));
      if (!file.isFile() || file.size < 100) throw Error('DATA_CORRUPT');
    }
    this.sqlite = new Database(path.join(folder, 'workspace.sqlite'));
    try {
      chmodSync(path.join(folder, 'workspace.sqlite'), 0o600);
      this.sqlite.pragma('foreign_keys = ON');
      this.sqlite.pragma('journal_mode = DELETE');
      this.sqlite.pragma('synchronous = EXTRA');
      this.sqlite.pragma('fullfsync = ON');
      // 受限验证给真实提交等待留出桌面工具送键时间；正常启动仍为 3 秒。
      this.sqlite.pragma(
        validation ? 'busy_timeout = 8000' : 'busy_timeout = 3000',
      );
      this.db = drizzle(this.sqlite, { schema });
      if (this.sqlite.pragma('quick_check', { simple: true }) !== 'ok')
        throw Error('DATA_CORRUPT');
      const legacy = this.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'",
        )
        .get();
      if (existsSync(marker) && !legacy) throw Error('DATA_CORRUPT');
      const priorVersion = legacy
        ? this.sqlite
            .prepare<[], { schema_version: number }>(
              'SELECT schema_version FROM workspace WHERE id=1',
            )
            .get()?.schema_version
        : CURRENT_DATA_FORMAT;
      if (
        !priorVersion ||
        ![
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          CURRENT_DATA_FORMAT,
        ].includes(priorVersion)
      )
        throw Error('DATA_VERSION_UNSUPPORTED');
      if (legacy && priorVersion !== CURRENT_DATA_FORMAT) {
        const backup = path.join(
          folder,
          (priorVersion === 22
            ? 'workspace-before-action-navigation-23-'
            : priorVersion === 21
              ? 'workspace-before-publication-fields-23-'
              : priorVersion === 20
                ? 'workspace-before-cleanup-22-'
                : priorVersion === 19
                  ? 'workspace-before-cross-site-21-'
                  : priorVersion === 18
                    ? 'workspace-before-schedules-20-'
                    : priorVersion === 17
                      ? 'workspace-before-agreements-19-'
                      : priorVersion === 16
                        ? 'workspace-before-excel-article-18-'
                        : priorVersion === 15
                          ? 'workspace-before-workflow-repair-17-'
                          : priorVersion === 14
                            ? 'workspace-before-coordination-16-'
                            : priorVersion === 13
                              ? 'workspace-before-workflow-reuse-15-'
                              : priorVersion === 12
                                ? 'workspace-before-publication-recovery-14-'
                                : priorVersion === 11
                                  ? 'workspace-before-publication-13-'
                                  : priorVersion === 10
                                    ? 'workspace-before-material-12-'
                                    : priorVersion === 9
                                      ? 'workspace-before-task-groups-11-'
                                      : priorVersion >= 7
                                        ? 'workspace-before-participation-10-'
                                        : priorVersion === 6
                                          ? 'workspace-before-upgrade-09-'
                                          : priorVersion === 5
                                            ? 'workspace-before-backup-07-'
                                            : 'workspace-before-recovery-05-') +
            randomUUID() +
            '.sqlite',
        );
        this.sqlite.prepare('VACUUM INTO ?').run(backup);
        chmodSync(backup, 0o600);
      }
      migrate(this.db, { migrationsFolder: migrations });
      const contentCalls = [
        ...this.db
          .select()
          .from(schema.modelCalls)
          .all()
          .map((call) => ({ call, hash: call.hash, output: call.output })),
        ...this.db
          .select()
          .from(schema.archivedModelCalls)
          .all()
          .map((row) => archivedModelCallSchema.parse(row.body)),
      ];
      for (const row of this.db.select().from(schema.executions).all()) {
        const body = row.body;
        if (
          body &&
          typeof body === 'object' &&
          'modelVersion' in body &&
          body.modelVersion !== CURRENT_STATE_MODEL
        )
          throw Error('STATE_MODEL_UNSUPPORTED');
        if (
          !executionSchema.safeParse(body).success ||
          !validPublicationReferences(
            row.taskId,
            executionSchema.parse(body),
          ) ||
          !validArticleModelCalls(
            row.taskId,
            executionSchema.parse(body),
            contentCalls,
          )
        )
          throw Error('DATA_CORRUPT');
      }
      if (
        !validWorkflowCatalog(
          this.db
            .select()
            .from(schema.executions)
            .all()
            .map((row) => ({ execution: executionSchema.parse(row.body) })),
        )
      )
        throw Error('DATA_CORRUPT');
      if (
        !validAgreementCatalog(
          this.db
            .select()
            .from(schema.executions)
            .all()
            .map((r) => ({
              taskId: r.taskId,
              execution: executionSchema.parse(r.body),
            })),
        )
      )
        throw Error('DATA_CORRUPT');
      this.db
        .insert(schema.workspace)
        .values({
          id: 1,
          active: null,
          revision: 0,
          schemaVersion: CURRENT_DATA_FORMAT,
        })
        .onConflictDoNothing()
        .run();
      const version = this.db
        .select()
        .from(schema.workspace)
        .get()?.schemaVersion;
      if (
        version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5 &&
        version !== 6 &&
        version !== 7 &&
        version !== 8 &&
        version !== 9 &&
        version !== 10 &&
        version !== 11 &&
        version !== 12 &&
        version !== 13 &&
        version !== 14 &&
        version !== 15 &&
        version !== 16 &&
        version !== 17 &&
        version !== 18 &&
        version !== 19 &&
        version !== 20 &&
        version !== 21 &&
        version !== 22 &&
        version !== CURRENT_DATA_FORMAT
      )
        throw new Error('DATA_VERSION_UNSUPPORTED');
      if (version !== CURRENT_DATA_FORMAT)
        this.db
          .update(schema.workspace)
          .set({ schemaVersion: CURRENT_DATA_FORMAT })
          .run();
      this.models = new ModelRecords(this.db);
      this.executions = new ExecutionRecords(this.db);
      this.backups = new BackupRecords(this.db, () => this.snapshot(), folder);
      this.cleanupRecords = new CleanupRecords(
        this.db,
        () => this.snapshot(),
        folder,
        () =>
          this.backups.busy() ||
          this.materialWork.size > 0 ||
          this.upgrades.held(),
      );
      this.upgrades = new UpgradeRecords(this.db, () => this.snapshot());
      this.schedules = new ScheduleRecords(
        this.db,
        this.executions,
        this.materials,
        () => this.upgrades.held(),
      );
      if (
        !validScheduleCatalog(
          this.snapshot().tasks.map((t) => ({
            taskId: t.id,
            execution: t.execution,
          })),
        )
      )
        throw Error('DATA_CORRUPT');
      if (!existsSync(marker)) {
        const fd = openSync(marker, 'wx', 0o600);
        try {
          writeSync(fd, 'helpr records initialized\n');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const directory = openSync(folder, 'r');
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }
  snapshot(): WorkspaceSnapshot {
    const meta = this.db.select().from(schema.workspace).get();
    const items = this.db
      .select()
      .from(schema.tasks)
      .orderBy(sql`rowid`)
      .all();
    return snapshotSchema.parse({
      revision: meta?.revision,
      active: meta?.active,
      modelSettings: this.models.settings(),
      tasks: items.map((task) => ({
        ...task,
        messages: this.models.messages(task.id),
        execution: this.executions.get(task.id),
      })),
    });
  }
  model(
    input: unknown,
  ): Record<string, unknown> & { state: WorkspaceSnapshot } {
    const kind = z.object({ kind: z.string() }).parse(input).kind;
    if (this.upgrades.held() && ['begin', 'dispatch'].includes(kind))
      throw Error('UPGRADE_PENDING');
    const result = this.models.execute(input);
    return { ...result, state: this.snapshot() };
  }
  execution(
    input: unknown,
  ): Record<string, unknown> & { state: WorkspaceSnapshot } {
    const c = z
      .object({ kind: z.string(), intent: z.string().optional() })
      .parse(input);
    if (
      this.upgrades.held() &&
      ([
        'claim',
        'reserve',
        'dispatch',
        'agreement-use',
        'agreement-accept',
      ].includes(c.kind) ||
        (c.kind === 'intent' && ['start', 'continue'].includes(c.intent ?? '')))
    )
      throw Error('UPGRADE_PENDING');
    const taskId = z
      .object({ taskId: z.string().optional() })
      .parse(input).taskId;
    if (
      taskId &&
      this.executions.get(taskId)?.historyCleanup &&
      [
        'intent',
        'claim',
        'reserve',
        'dispatch',
        'agreement-use',
        'agreement-accept',
        'agreement-propose',
        'repeat-material',
      ].includes(c.kind)
    )
      throw Error('HISTORY_CLEANED');
    return { ...this.executions.execute(input), state: this.snapshot() };
  }
  scheduled(
    input: unknown,
  ): Promise<Record<string, unknown> & { state: WorkspaceSnapshot }> {
    const taskId = z
      .object({ taskId: z.string().optional() })
      .parse(input).taskId;
    if (taskId && this.executions.get(taskId)?.historyCleanup)
      return Promise.reject(Error('HISTORY_CLEANED'));
    const work = this.schedules
      .execute(input)
      .then((result) => ({ ...result, state: this.snapshot() }));
    this.materialWork.add(work);
    void work.finally(() => this.materialWork.delete(work)).catch(() => {});
    return work;
  }
  material(input: unknown) {
    const work = this.materialCommand(input);
    this.materialWork.add(work);
    void work.finally(() => this.materialWork.delete(work)).catch(() => {});
    return work;
  }
  private async materialCommand(input: unknown) {
    const base = { taskId: z.string(), runId: z.string() };
    const c = z
      .discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('agreement-select'),
          taskId: z.string(),
          expectedVersion: z.number().int().positive(),
        }),
        z.strictObject({
          kind: z.literal('parse'),
          ...base,
          materialId: z.string().uuid(),
        }),
        z.strictObject({
          kind: z.literal('verify'),
          taskId: z.string(),
          materialId: z.string().uuid(),
          goalVersion: z.number().int().positive(),
        }),
        z.strictObject({
          kind: z.literal('select'),
          ...base,
          selection: materialSelectionSchema,
        }),
        z.strictObject({
          kind: z.literal('payload'),
          ...base,
          actionId: z.string(),
        }),
      ])
      .parse(input);
    if (this.executions.get(c.taskId)?.historyCleanup)
      throw Error('HISTORY_CLEANED');
    if (c.kind === 'agreement-select') {
      const e = this.executions.get(c.taskId);
      if (
        !e ||
        e.version !== c.expectedVersion ||
        e.phase !== 'queued' ||
        e.intent !== 'automatic' ||
        e.pauseReason ||
        e.restoreReview ||
        this.upgrades.held()
      )
        throw Error('EXECUTION_STOPPED');
      const a = boundAgreement(
        e,
        this.snapshot().tasks.map((t) => ({
          taskId: t.id,
          execution: t.execution,
        })),
      );
      if (!a || !activeAgreement(a)) throw Error('AGREEMENT_EXPIRED');
      let material;
      try {
        const selected = await this.materials.selectMany(
          { ...a.terms.selection, basis: agreementSummary(a.terms) },
          [e.goal],
          e.goalVersion,
          e.scheduleOrigin?.date ?? '',
          new Set(),
        );
        if (selected.length !== 1) throw Error('MATERIAL_AMBIGUOUS');
        material = selected[0]!;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return this.execution({
          kind: 'agreement-material',
          taskId: c.taskId,
          expectedVersion: c.expectedVersion,
          failure:
            materialFailureMessage[code] ??
            '无法按发布约定取得素材，请核对范围并修改委托。',
        });
      }
      return this.execution({
        kind: 'agreement-material',
        taskId: c.taskId,
        expectedVersion: c.expectedVersion,
        material,
      });
    }
    if (c.kind === 'verify') {
      const material = this.executions
        .get(c.taskId)
        ?.materials?.find(
          (m) => m.id === c.materialId && m.goalVersion === c.goalVersion,
        );
      if (!material) return { valid: false };
      try {
        await this.materials.read(material);
        return { valid: true };
      } catch {
        return { valid: false };
      }
    }
    const active = () => {
      const e = this.executions.get(c.taskId);
      if (
        this.upgrades.held() ||
        !e ||
        e.intent !== 'automatic' ||
        e.runId !== c.runId ||
        !['checking', 'running'].includes(e.phase)
      )
        throw Error('EXECUTION_STOPPED');
      return e;
    };
    const e = active();
    if (c.kind === 'parse') {
      const material = e.materials?.find(
        (m) => m.id === c.materialId && m.goalVersion === e.goalVersion,
      );
      if (!material) throw Error('MATERIAL_NOT_AUTHORIZED');
      const requirements = contentRequirements(e);
      const prior = e.contentSources?.find(
        (s) =>
          s.materialId === material.id &&
          s.requirements.goal === requirements.goal &&
          JSON.stringify(s.requirements.answers) ===
            JSON.stringify(requirements.answers),
      );
      if (prior) return { source: prior, state: this.snapshot() };
      const bytes = await this.materials.read(material);
      const parsed = await parseExcel(bytes, material.name);
      const latest = active();
      if (
        latest.version !== e.version ||
        JSON.stringify(contentRequirements(latest)) !==
          JSON.stringify(requirements)
      )
        throw Error('EXECUTION_STOPPED');
      const body = {
        ...parsed,
        id: randomUUID(),
        materialId: material.id,
        materialSha256: material.sha256,
        goalVersion: e.goalVersion,
        createdAt: Date.now(),
        requirements: { id: randomUUID(), ...requirements },
      };
      const source = contentSourceSchema.parse({
        ...body,
        sha256: contentSourceHash(body),
      });
      this.executions.execute({
        kind: 'content-source',
        taskId: c.taskId,
        runId: c.runId,
        source,
      });
      return { source, state: this.snapshot() };
    }
    if (c.kind === 'select') {
      if (e.materials?.some((m) => m.goalVersion === e.goalVersion))
        throw Error('MATERIAL_ALREADY_FIXED');
      if (
        e.actions.some((a) =>
          ['reserved', 'dispatched', 'unknown'].includes(a.status),
        )
      )
        throw Error('EXECUTION_RESULT_UNKNOWN');
      const material = await this.materials.select(
        c.selection,
        [
          e.goal,
          ...(e.answers ?? [])
            .filter((a) => a.goalVersion === e.goalVersion)
            .map((a) => a.answer),
        ],
        e.goalVersion,
      );
      active();
      const result = this.executions.execute({
        kind: 'material-selected',
        taskId: c.taskId,
        runId: c.runId,
        material,
      });
      return { ...result, state: this.snapshot() };
    }
    const action = e.actions.find(
      (a) =>
        a.id === c.actionId &&
        a.runId === c.runId &&
        a.goalVersion === e.goalVersion &&
        a.status === 'dispatched',
    );
    const id =
      action?.action.kind === 'upload' ? action.action.materialId : null;
    const version = e.materials?.find(
      (m) => m.id === id && m.goalVersion === e.goalVersion,
    );
    if (!version) throw Error('MATERIAL_NOT_AUTHORIZED');
    const bytes = await this.materials.read(version);
    const latest = active();
    if (
      latest.version !== e.version ||
      latest.actions.find((a) => a.id === c.actionId)?.status !== 'dispatched'
    )
      throw Error('EXECUTION_STOPPED');
    return {
      name: version.name,
      sha256: version.sha256,
      base64: bytes.toString('base64'),
    };
  }
  lookupRequest(input: unknown): {
    applied: boolean;
    state: WorkspaceSnapshot;
  } {
    const command = recordCommandSchema.parse(input);
    const canonical = Object.fromEntries(
      Object.entries(command).sort(([a], [b]) => a.localeCompare(b)),
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
    const previous = this.db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, command.requestId))
      .get();
    if (previous && previous.hash !== hash)
      throw new Error('REQUEST_CONTENT_CONFLICT');
    return { applied: Boolean(previous), state: this.snapshot() };
  }
  execute(input: unknown): { taskId: string; state: WorkspaceSnapshot } {
    const command = recordCommandSchema.parse(input);
    const canonical = Object.fromEntries(
      Object.entries(command).sort(([a], [b]) => a.localeCompare(b)),
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
    return this.db.transaction(
      (tx) => {
        const previous = tx
          .select()
          .from(schema.requests)
          .where(eq(schema.requests.id, command.requestId))
          .get();
        if (previous) {
          if (previous.hash !== hash)
            throw new Error('REQUEST_CONTENT_CONFLICT');
          return { taskId: previous.taskId, state: this.snapshot() };
        }
        let taskId: string;
        if (command.kind === 'create') {
          const members = splitDelegation(command.goal, command.keepTogether);
          const groupId = members.length > 1 ? randomUUID() : null;
          taskId = randomUUID();
          for (const [i, { goal, url }] of members.entries()) {
            const memberId = i === 0 ? taskId : randomUUID();
            tx.insert(schema.tasks)
              .values({
                id: memberId,
                groupId,
                groupGoal: groupId ? command.goal : null,
                goal,
                created: Date.now(),
                url,
                draft: '',
                hidden: false,
                minimized: false,
                phase: url ? pagePhase('no-page', 'LOAD') : 'no-page',
                error: '',
                version: 1,
              })
              .run();
            tx.insert(schema.messages)
              .values([
                { taskId: memberId, role: 'user', text: goal },
                {
                  taskId: memberId,
                  role: 'system',
                  text: '目标已保存。先打开网站，可以询问网页内容；在本任务选择“开始执行”后，才会按目标推进网页操作。',
                },
              ])
              .run();
          }
          tx.update(schema.workspace)
            .set({ active: taskId })
            .where(eq(schema.workspace.id, 1))
            .run();
        } else {
          taskId = command.taskId;
          const task = tx
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, taskId))
            .get();
          if (!task) throw new Error('TASK_NOT_FOUND');
          if (
            command.expectedVersion !== undefined &&
            command.expectedVersion !== task.version
          )
            throw new Error('RECORD_VERSION_CONFLICT');
          const update: Partial<typeof schema.tasks.$inferInsert> = {
            version: task.version + 1,
          };
          switch (command.kind) {
            case 'message':
              tx.insert(schema.messages)
                .values({ taskId, role: 'user', text: command.text })
                .run();
              update.draft = '';
              break;
            case 'draft':
              update.draft = command.text;
              break;
            case 'navigate':
              update.url = websiteURL(command.url);
              update.phase = pagePhase(task.phase as Task['phase'], 'LOAD');
              update.error = '';
              break;
            case 'page':
              update.url = websiteURL(command.url);
              update.phase = pagePhase(
                task.phase as Task['phase'],
                command.phase === 'loading'
                  ? 'LOAD'
                  : command.phase === 'manual'
                    ? 'READY'
                    : 'FAIL',
              );
              update.error = command.error;
              break;
            case 'select':
              update.hidden = false;
              tx.update(schema.workspace)
                .set({ active: taskId })
                .where(eq(schema.workspace.id, 1))
                .run();
              break;
            case 'archive-task':
              if (!endedExecution(this.executions.get(taskId)))
                throw Error('RECORD_VERSION_CONFLICT');
              update.archived = true;
              hideTaskTab(tx, taskId);
              break;
            case 'hide-task':
              hideTaskTab(tx, taskId);
              break;
            case 'minimize':
              update.minimized = !task.minimized;
              break;
          }
          tx.update(schema.tasks)
            .set(update)
            .where(eq(schema.tasks.id, taskId))
            .run();
        }
        const meta = tx.select().from(schema.workspace).get();
        tx.update(schema.workspace)
          .set({ revision: (meta?.revision ?? 0) + 1 })
          .where(eq(schema.workspace.id, 1))
          .run();
        tx.insert(schema.requests)
          .values({ id: command.requestId, hash, taskId })
          .run();
        return { taskId, state: this.snapshot() };
      },
      { behavior: 'immediate' },
    );
  }
  close(): void {
    this.sqlite.close();
  }
  cleanup(input: unknown) {
    return this.cleanupRecords.execute(input);
  }
  backup(input: unknown) {
    return this.backups.execute(input);
  }
  upgrade(input: unknown) {
    return {
      ...this.upgrades.execute(input),
      currentFingerprint: this.upgrades.fingerprint(),
      workspaceRevision: this.snapshot().revision,
    };
  }
  upgradeFingerprint() {
    return this.upgrades.fingerprint();
  }
  async settleBackups() {
    await this.backups.settled();
    await Promise.allSettled([...this.materialWork]);
  }
  checkpoint(): WorkspaceSnapshot {
    this.db.transaction(() => {
      this.db
        .update(schema.workspace)
        .set({ revision: sql`${schema.workspace.revision}+1` })
        .run();
    });
    return this.snapshot();
  }
}
