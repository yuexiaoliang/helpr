import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  snapshotSchema,
  taskSchema,
  type WorkspaceSnapshot,
} from '../shared/contracts';
import { modelCallSchema, archivedModelCallSchema } from '../shared/model';
import { backupArchiveSchema, type BackupArchive } from '../shared/backup';
import * as schema from './schema';
import { pauseForBackup } from './execution';
import { websiteURL } from '../shared/url-policy';

const request = z.strictObject({
  kind: z.literal('create'),
  requestId: z.string().min(1).max(100),
  file: z.string().min(1).max(4096),
});
const restoreRequest = request.extend({
  kind: z.literal('restore'),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
const inspectRequest = z.strictObject({
  kind: z.literal('inspect'),
  file: z.string().min(1).max(4096),
});
type BackupResult = {
  archive: BackupArchive;
  safety?: BackupArchive;
  state: WorkspaceSnapshot;
};
const savedCall = archivedModelCallSchema;
const requestFact = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  hash: z.string(),
});
export const backupPayloadSchema = z.strictObject({
  revision: snapshotSchema.shape.revision,
  active: snapshotSchema.shape.active,
  tasks: z.array(taskSchema.omit({ executionControl: true })),
  calls: z.array(savedCall),
  requests: z.array(requestFact),
  executionRequests: z.array(requestFact),
});
export type BackupPayload = z.infer<typeof backupPayloadSchema>;
const envelope = z.strictObject({
  format: z.literal('helpr-backup'),
  version: z.literal(1),
  dataVersion: z.literal(6),
  stateModel: z.literal(1),
  id: z.string().min(1).max(100),
  created: z.number().int().nonnegative(),
  files: z.tuple([
    z.strictObject({
      name: z.literal('records.json'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
  payload: backupPayloadSchema,
});
const bytes = (payload: BackupPayload) => Buffer.from(JSON.stringify(payload));
const digest = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** 唯一记录拥有者选择一致逻辑快照；文件写入不阻塞控制拥有者的停止。 */
export class BackupRecords {
  private readonly pending = new Map<
    string,
    Promise<{ archive: BackupArchive; state: WorkspaceSnapshot }>
  >();
  private restoring: Promise<BackupResult> | null = null;
  async settled() {
    if (this.restoring) await this.restoring;
    await Promise.all([...this.pending.values()]);
  }
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly snapshot: () => WorkspaceSnapshot,
    private readonly folder: string,
  ) {}
  async execute(input: unknown): Promise<BackupResult> {
    const command = z
      .discriminatedUnion('kind', [request, restoreRequest, inspectRequest])
      .parse(input);
    try {
      if (command.kind === 'create') return await this.create(command);
      if (command.kind === 'inspect')
        return {
          archive: (await readBackup(command.file)).archive,
          state: this.snapshot(),
        };
      if (this.restoring) throw Error('BACKUP_BUSY');
      const work = this.restore(command);
      this.restoring = work;
      try {
        return await work;
      } finally {
        this.restoring = null;
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'ENOSPC') throw Error('BACKUP_STORAGE_FULL');
      if (code === 'ENOENT') throw Error('BACKUP_FILE_MISSING');
      if (
        ['EACCES', 'EROFS', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EEXIST'].includes(
          String(code),
        )
      )
        throw Error('BACKUP_STORAGE_UNAVAILABLE');
      throw error;
    }
  }
  private async restore(
    command: z.infer<typeof restoreRequest>,
  ): Promise<BackupResult> {
    const receiptId = 'restore:' + command.requestId;
    const prior = this.db
      .select()
      .from(schema.backupReceipts)
      .where(eq(schema.backupReceipts.id, receiptId))
      .get();
    const savedReceipt = z.strictObject({
      archive: backupArchiveSchema,
      safety: backupArchiveSchema,
    });
    if (prior) {
      const saved = savedReceipt.parse(prior.archive);
      if (
        prior.file !== command.file ||
        saved.archive.checksum !== command.checksum
      )
        throw Error('REQUEST_CONTENT_CONFLICT');
      return { ...saved, state: this.snapshot() };
    }
    const incoming = await readBackup(command.file);
    if (incoming.archive.checksum !== command.checksum)
      throw Error('BACKUP_CHANGED');
    const directory = path.join(this.folder, 'backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const safety = (
      await this.create({
        kind: 'create',
        requestId: 'safety:' + command.requestId,
        file: path.join(
          directory,
          'before-restore-' +
            digest(Buffer.from(command.requestId)) +
            '.helpr-backup',
        ),
      })
    ).archive;
    // 短事务中按当前事实合并。文件写入等待期间的新停止／目标变化仍以本机当前记录为准。
    this.db.transaction(
      () => {
        const current = this.snapshot();
        const currentIds = new Set(current.tasks.map((t) => t.id));
        for (const task of incoming.payload.tasks) {
          if (currentIds.has(task.id)) continue;
          const { execution, messages, ...fields } = task;
          if (fields.url) websiteURL(fields.url);
          this.db
            .insert(schema.tasks)
            .values({ ...fields, version: fields.version + 1 })
            .run();
          for (const message of messages)
            this.db
              .insert(schema.messages)
              .values({
                taskId: task.id,
                role: message.role,
                text: message.text,
                callId: message.call?.id ?? null,
              })
              .run();
          if (execution)
            this.db
              .insert(schema.executions)
              .values({ taskId: task.id, body: execution })
              .run();
        }
        for (const table of [schema.requests, schema.executionRequests]) {
          const facts =
            table === schema.requests
              ? incoming.payload.requests
              : incoming.payload.executionRequests;
          for (const fact of facts) {
            const old = this.db
              .select()
              .from(table)
              .where(eq(table.id, fact.id))
              .get();
            if (old && (old.hash !== fact.hash || old.taskId !== fact.taskId))
              throw Error('REQUEST_CONTENT_CONFLICT');
            if (!old) this.db.insert(table).values(fact).run();
          }
        }
        for (const saved of incoming.payload.calls) {
          const live = this.db
            .select()
            .from(schema.modelCalls)
            .where(eq(schema.modelCalls.id, saved.call.id))
            .get();
          const old = this.db
            .select()
            .from(schema.archivedModelCalls)
            .where(eq(schema.archivedModelCalls.id, saved.call.id))
            .get();
          if (live || old) continue;
          const body = structuredClone(saved);
          if (['preparing', 'sending', 'streaming'].includes(body.call.phase)) {
            body.call.phase = 'interrupted';
            body.call.error = 'MODEL_INTERRUPTED';
          }
          this.db
            .insert(schema.archivedModelCalls)
            .values({
              id: body.call.id,
              taskId: body.call.taskId,
              hash: body.hash,
              body,
            })
            .run();
        }
        for (const row of this.db.select().from(schema.executions).all()) {
          const parsed = taskSchema.shape.execution.unwrap().parse(row.body);
          if (!parsed) throw Error('DATA_CORRUPT');
          this.db
            .update(schema.executions)
            .set({ body: pauseForBackup(parsed) })
            .where(eq(schema.executions.taskId, row.taskId))
            .run();
        }
        this.db
          .update(schema.workspace)
          .set({
            revision: Math.max(current.revision, incoming.payload.revision) + 1,
            active: current.active ?? incoming.payload.active,
          })
          .run();
        this.db
          .insert(schema.backupReceipts)
          .values({
            id: receiptId,
            file: command.file,
            archive: { archive: incoming.archive, safety },
          })
          .run();
      },
      { behavior: 'immediate' },
    );
    return { archive: incoming.archive, safety, state: this.snapshot() };
  }
  create(input: unknown) {
    const command = request.parse(input);
    const prior = this.pending.get(command.requestId);
    if (prior)
      return prior.then((result) => {
        if (result.archive.file !== command.file)
          throw Error('REQUEST_CONTENT_CONFLICT');
        return { ...result, state: this.snapshot() };
      });
    const work = this.write(command);
    this.pending.set(command.requestId, work);
    void work
      .finally(() => this.pending.delete(command.requestId))
      .catch(() => {});
    return work;
  }
  payload(): BackupPayload {
    return this.db.transaction(() => {
      const state = this.snapshot();
      return backupPayloadSchema.parse({
        revision: state.revision,
        active: state.active,
        tasks: state.tasks.map((task) =>
          taskSchema.omit({ executionControl: true }).strip().parse(task),
        ),
        calls: [
          ...this.db
            .select()
            .from(schema.modelCalls)
            .all()
            .map((row) => ({
              call: modelCallSchema.strip().parse(row),
              output: row.output,
              hash: row.hash,
            })),
          ...this.db
            .select()
            .from(schema.archivedModelCalls)
            .all()
            .map((row) => savedCall.parse(row.body)),
        ],
        requests: this.db.select().from(schema.requests).all(),
        executionRequests: this.db
          .select()
          .from(schema.executionRequests)
          .all(),
      });
    });
  }
  private async write(command: z.infer<typeof request>) {
    const previous = this.db
      .select()
      .from(schema.backupReceipts)
      .where(eq(schema.backupReceipts.id, command.requestId))
      .get();
    if (previous) {
      if (previous.file !== command.file)
        throw Error('REQUEST_CONTENT_CONFLICT');
      const existing = await readBackup(command.file);
      const archive = backupArchiveSchema.parse(previous.archive);
      if (
        archive.checksum !== existing.archive.checksum ||
        archive.id !== existing.archive.id
      )
        throw Error('BACKUP_CHANGED');
      return { archive, state: this.snapshot() };
    }
    let archive: BackupArchive;
    try {
      const existing = await readBackup(command.file);
      if (existing.archive.id !== command.requestId)
        throw Error('BACKUP_EXISTS');
      archive = existing.archive;
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      const payload = this.payload(),
        data = bytes(payload),
        created = Date.now();
      const contents = JSON.stringify(
        envelope.parse({
          format: 'helpr-backup',
          version: 1,
          dataVersion: 6,
          stateModel: 1,
          id: command.requestId,
          created,
          files: [
            { name: 'records.json', bytes: data.length, sha256: digest(data) },
          ],
          payload,
        }),
      );
      if (Buffer.byteLength(contents) > 64 * 1024 * 1024)
        throw Error('BACKUP_TOO_LARGE');
      const temporary = command.file + '.' + randomUUID() + '.partial';
      const fd = await open(temporary, 'wx', 0o600);
      let published = false;
      try {
        await fd.writeFile(contents);
        await fd.sync();
        await fd.close();
        // 不覆盖已有文件；发布之后、回执保存之前中断，可通过固定身份核对原文件。
        await link(temporary, command.file);
        published = true;
        const directory = await open(path.dirname(command.file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (published) throw Error('BACKUP_RECEIPT_UNKNOWN');
        throw error;
      } finally {
        await fd.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
      archive = (await readBackup(command.file)).archive;
    }
    try {
      this.db
        .insert(schema.backupReceipts)
        .values({ id: command.requestId, file: command.file, archive })
        .run();
    } catch {
      throw Error('BACKUP_RECEIPT_UNKNOWN');
    }
    return { archive, state: this.snapshot() };
  }
}
export async function readBackup(
  file: string,
): Promise<{ archive: BackupArchive; payload: BackupPayload }> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: string;
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw Error('BACKUP_INVALID');
    contents = await fd.readFile('utf8');
  } finally {
    await fd.close();
  }
  let value: z.infer<typeof envelope>;
  try {
    value = envelope.parse(JSON.parse(contents));
  } catch {
    throw Error('BACKUP_INCOMPATIBLE');
  }
  const data = bytes(value.payload);
  if (
    value.files[0].sha256 !== digest(data) ||
    value.files[0].bytes !== data.length
  )
    throw Error('BACKUP_INVALID');
  const ids = new Set(value.payload.tasks.map((t) => t.id));
  const calls = new Map(value.payload.calls.map((c) => [c.call.id, c.call]));
  if (
    ids.size !== value.payload.tasks.length ||
    (value.payload.active && !ids.has(value.payload.active)) ||
    [...value.payload.requests, ...value.payload.executionRequests].some(
      (r) => !ids.has(r.taskId),
    ) ||
    value.payload.calls.some((c) => !ids.has(c.call.taskId)) ||
    calls.size !== value.payload.calls.length ||
    value.payload.tasks.some((t) =>
      t.messages.some(
        (m) =>
          m.call &&
          (m.call.taskId !== t.id ||
            JSON.stringify(calls.get(m.call.id)) !== JSON.stringify(m.call)),
      ),
    ) ||
    [value.payload.requests, value.payload.executionRequests].some(
      (facts) => new Set(facts.map((f) => f.id)).size !== facts.length,
    )
  )
    throw Error('BACKUP_INVALID');
  return {
    archive: {
      id: value.id,
      created: value.created,
      file,
      checksum: digest(data),
      tasks: ids.size,
    },
    payload: value.payload,
  };
}
