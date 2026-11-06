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
  private readonly models: ModelRecords;
  private readonly executions: ExecutionRecords;
  private readonly sqlite: Database.Database;
  private readonly db: ReturnType<typeof drizzle<typeof schema>>;
  private readonly backups: BackupRecords;
  private readonly upgrades: UpgradeRecords;
  constructor(folder: string, migrations: string, validation = false) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
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
        ![1, 2, 3, 4, 5, 6, 7, 8, 9, CURRENT_DATA_FORMAT].includes(priorVersion)
      )
        throw Error('DATA_VERSION_UNSUPPORTED');
      if (legacy && priorVersion !== CURRENT_DATA_FORMAT) {
        const backup = path.join(
          folder,
          (priorVersion === 9
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
      for (const row of this.db.select().from(schema.executions).all()) {
        const body = row.body;
        if (
          body &&
          typeof body === 'object' &&
          'modelVersion' in body &&
          body.modelVersion !== CURRENT_STATE_MODEL
        )
          throw Error('STATE_MODEL_UNSUPPORTED');
        if (!executionSchema.safeParse(body).success)
          throw Error('DATA_CORRUPT');
      }
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
      this.upgrades = new UpgradeRecords(this.db, () => this.snapshot());
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
      (['claim', 'reserve', 'dispatch'].includes(c.kind) ||
        (c.kind === 'intent' && ['start', 'continue'].includes(c.intent ?? '')))
    )
      throw Error('UPGRADE_PENDING');
    return { ...this.executions.execute(input), state: this.snapshot() };
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
