import { afterEach, expect, test, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { UpgradeService } from '../../app/desktop/upgrade-service';
import { randomUUID } from 'node:crypto';
import type { UpgradeProof } from '../../app/shared/upgrade';

const folders: string[] = [];
const closeOwners: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  closeOwners.splice(0).forEach((close) => close());
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

test.each([
  {
    change: { credential: 'f'.repeat(64) },
    error: 'UPGRADE_CREDENTIAL_CHANGED',
  },
  { change: { profile: 'f'.repeat(64) }, error: 'UPGRADE_LOGIN_CHANGED' },
  { change: { cookies: [] }, error: 'UPGRADE_LOGIN_CHANGED' },
  { change: { nativeReady: false }, error: 'UPGRADE_CONTROL_UNAVAILABLE' },
])(
  '换版后的依据变化保持暂停，不以重新填写充抵原延续：$error',
  async ({ change, error }) => {
    const h = await preparedUpgrade();
    const service = await h.reopen();
    h.setProof(change);
    const result = await service.handle({ kind: 'upgrade-check' });
    expect(result).toMatchObject({ phase: 'blocked', error });
    expect(result).not.toHaveProperty('proof');
    expect(h.records.upgrade({ kind: 'status' }).proof?.credential).toBe(
      'b'.repeat(64),
    );
    expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
      phase: 'blocked',
      error,
    });
  },
);

test('真实到期与丢失有效登录分开，用户重新登录后保留到期事实而非改判原登录延续', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const h = await preparedUpgrade();
  const service = await h.reopen();
  vi.setSystemTime(Date.now() + 3601000);
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'blocked',
    error: 'UPGRADE_LOGIN_EXPIRED',
  });
  h.setProof({
    cookies: [
      {
        id: 'c'.repeat(64),
        value: 'e'.repeat(64),
        expires: Date.now() / 1000 + 3600,
      },
    ],
  });
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'complete',
    continuity: 'renewed',
  });
});

async function preparedUpgrade() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-check-'));
  folders.push(folder);
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  records.upgrade({ kind: 'boot', version: '0.1.0' });
  records.execute({ kind: 'create', requestId: 'task', goal: '保留原任务' });
  closeOwners.push(() => records.close());
  let proof: UpgradeProof = {
    credential: 'b'.repeat(64),
    profile: 'a'.repeat(64),
    cookies: [
      {
        id: 'c'.repeat(64),
        value: 'd'.repeat(64),
        expires: Date.now() / 1000 + 3600,
      },
    ],
    pages: [],
    nativeReady: true,
  };
  let failure = '';
  const make = (version: string) =>
    new UpgradeService({
      version,
      records: (c) => Promise.resolve(records.upgrade(c)),
      current: () => records.snapshot(),
      hold: () => Promise.resolve(),
      release: () => Promise.resolve(),
      ready: () => true,
      capture: () =>
        failure
          ? Promise.reject(Error(failure))
          : Promise.resolve(structuredClone(proof)),
      pages: () => Promise.resolve(proof.pages),
      acknowledge: () => Promise.resolve(),
      choose: () => Promise.resolve(folder),
      backup: async (requestId, file) =>
        (await records.backup({ kind: 'create', requestId, file })).archive,
      versions: () => ({
        revision: 2,
        phase: 'done',
        result: { kind: 'available', release: { version: '0.2.0' } },
      }),
      publish: () => {},
      quit: () => Promise.resolve(),
      closePages: () => Promise.resolve(),
    });
  const old = make('0.1.0');
  await old.initialize();
  const prepared = await old.handle({
    kind: 'upgrade-prepare',
    requestId: randomUUID(),
    versionRevision: 2,
  });
  expect(prepared.phase).toBe('ready');
  return {
    get records() {
      return records;
    },
    setProof: (next: Partial<UpgradeProof>) => {
      proof = { ...proof, ...next };
    },
    setFailure: (code: string) => {
      failure = code;
    },
    reopen: async (version = '0.2.0') => {
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
      const next = make(version);
      await next.initialize();
      return next;
    },
  };
}

test('跨进程重新打开后，取消原密钥授权保持暂停，恢复原授权再检查而不重填密钥', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  h.setFailure('MODEL_CREDENTIAL_UNAVAILABLE');
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'blocked',
    error: 'MODEL_CREDENTIAL_UNAVAILABLE',
    working: false,
  });
  expect(h.records.upgrade({ kind: 'status' }).proof?.credential).toBe(
    'b'.repeat(64),
  );
  h.setFailure('');
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'complete',
    continuity: 'retained',
    working: false,
  });
});

test('原生现场分别核对后才生成真实业务备份，新停止使退出资格失效', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-service-'));
  folders.push(folder);
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  records.upgrade({ kind: 'boot', version: '0.1.0' });
  const a = records.execute({
    kind: 'create',
    requestId: 'A',
    goal: '原任务',
  }).taskId;
  let dirty = true;
  const proof = () => ({
    credential: null,
    profile: 'a'.repeat(64),
    cookies: [],
    pages: [{ taskId: a, generation: 1, epoch: 2, dirty }],
    nativeReady: true,
  });
  const service = new UpgradeService({
    version: '0.1.0',
    records: (c) => Promise.resolve(records.upgrade(c)),
    current: () => records.snapshot(),
    release: () => Promise.resolve(),
    hold: () => Promise.resolve(),
    ready: () => true,
    capture: () => Promise.resolve(proof()),
    pages: () => Promise.resolve(proof().pages),
    acknowledge: () => {
      dirty = false;
      return Promise.resolve();
    },
    choose: () => Promise.resolve(folder),
    backup: async (id, file) =>
      (await records.backup({ kind: 'create', requestId: id, file })).archive,
    versions: () => ({
      revision: 4,
      phase: 'done',
      result: { kind: 'available', release: { version: '0.2.0' } },
    }),
    publish: () => {},
    quit: () => Promise.resolve(),
    closePages: () => Promise.resolve(),
  });
  try {
    await service.initialize();
    const requestId = randomUUID();
    let status = await service.handle({
      kind: 'upgrade-prepare',
      requestId,
      versionRevision: 4,
    });
    expect(status).toMatchObject({
      phase: 'blocked',
      error: 'UPGRADE_PAGE_UNSAVED',
      backup: null,
      dirtyTasks: [a],
    });
    await service.handle({
      kind: 'upgrade-page-saved',
      taskId: a,
      generation: 1,
      epoch: 2,
    });
    status = await service.handle({
      kind: 'upgrade-prepare',
      requestId,
      versionRevision: 4,
    });
    expect(status).toMatchObject({ phase: 'ready', dirtyTasks: [] });
    expect(status.backup?.file).toContain(folder);
    const duplicate = await service.handle({
      kind: 'upgrade-prepare',
      requestId,
      versionRevision: 4,
    });
    expect(duplicate).toMatchObject({
      phase: 'ready',
      backup: { id: status.backup!.id },
    });
    records.execution({
      kind: 'intent',
      taskId: a,
      requestId: 'new-stop',
      intent: 'stop',
    });
    expect(
      await service.handle({
        kind: 'upgrade-exit',
        revision: status.recordRevision,
      }),
    ).toMatchObject({ phase: 'blocked', error: 'UPGRADE_CHANGED' });
    expect(records.snapshot().tasks[0]?.execution?.intent).toBe('stopped');
  } finally {
    records.close();
  }
});

test('升级准备可靠保留原停止与草稿，重开前后均阻止新派发', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-09-'));
  folders.push(folder);
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  records.upgrade({ kind: 'boot', version: '0.1.0' });
  const a = records.execute({
    kind: 'create',
    requestId: 'A',
    goal: '任务A',
  }).taskId;
  const b = records.execute({
    kind: 'create',
    requestId: 'B',
    goal: '任务B',
  }).taskId;
  records.execution({
    kind: 'intent',
    taskId: a,
    requestId: 'start-A',
    intent: 'start',
  });
  records.execution({
    kind: 'intent',
    taskId: b,
    requestId: 'stop-B',
    intent: 'stop',
  });
  records.execute({
    kind: 'draft',
    taskId: b,
    requestId: 'draft-B',
    text: '保留这段中文草稿',
  });
  records.upgrade({
    kind: 'prepare',
    requestId: 'prepare-09',
    target: '0.2.0',
  });
  expect(() =>
    records.execution({ kind: 'claim', taskId: a, runId: 'too-soon' }),
  ).toThrow('UPGRADE_PENDING');
  records.close();
  records = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    expect(records.upgrade({ kind: 'status' }).phase).toBe('preparing');
    expect(records.snapshot().tasks.find((t) => t.id === b)).toMatchObject({
      draft: '保留这段中文草稿',
      execution: { intent: 'stopped' },
    });
    expect(() =>
      records.execution({ kind: 'claim', taskId: a, runId: 'after-reopen' }),
    ).toThrow('UPGRADE_PENDING');
  } finally {
    records.close();
  }
});

test('换版检查失败后不能以另一项升级准备清除原失败和目标', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-failure-'));
  folders.push(folder);
  const r = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    r.upgrade({ kind: 'boot', version: '0.1.0' });
    r.upgrade({ kind: 'prepare', requestId: 'first', target: '0.2.0' });
    r.upgrade({ kind: 'boot', version: '0.2.0' });
    r.upgrade({ kind: 'block', error: 'UPGRADE_CREDENTIAL_CHANGED' });
    expect(() =>
      r.upgrade({ kind: 'prepare', requestId: 'replacement', target: '0.3.0' }),
    ).toThrow('UPGRADE_PENDING');
    expect(r.upgrade({ kind: 'status' })).toMatchObject({
      target: '0.2.0',
      error: 'UPGRADE_CREDENTIAL_CHANGED',
      reopening: true,
    });
  } finally {
    r.close();
  }
});

test('真实旧格式库迁移失败保留原副本，修复后原任务草稿可读，格式6业务备份仍可检查', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-upgrade-migration-'));
  folders.push(folder);
  let r = new WorkspaceRecords(folder, 'app/records/migrations');
  const taskId = r.execute({
    kind: 'create',
    requestId: 'old-task',
    goal: '旧版任务',
  }).taskId;
  r.execute({
    kind: 'draft',
    taskId,
    requestId: 'old-draft',
    text: '迁移前的中文文字',
  });
  r.close();
  const old = new Database(path.join(folder, 'workspace.sqlite'));
  old.exec('DROP TABLE installation');
  old
    .prepare(
      'DELETE FROM __drizzle_migrations WHERE created_at=(SELECT MAX(created_at) FROM __drizzle_migrations)',
    )
    .run();
  old.exec('UPDATE workspace SET schema_version=6');
  old.close();
  const broken = path.join(folder, 'broken-migrations');
  cpSync('app/records/migrations', broken, { recursive: true });
  writeFileSync(
    path.join(broken, '0004_upgrade_09.sql'),
    'CREATE TABLE installation(id integer PRIMARY KEY, body text NOT NULL); INVALID_MIGRATION;',
  );
  expect(() => new WorkspaceRecords(folder, broken)).toThrow();
  expect(
    readdirSync(folder).some((name) =>
      name.startsWith('workspace-before-upgrade-09-'),
    ),
  ).toBe(true);
  r = new WorkspaceRecords(folder, 'app/records/migrations');
  try {
    expect(r.snapshot().tasks[0]).toMatchObject({
      id: taskId,
      draft: '迁移前的中文文字',
    });
    const file = path.join(folder, 'archive.helpr-backup');
    await r.backup({ kind: 'create', requestId: 'check-legacy', file });
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as {
      dataVersion: number;
    };
    envelope.dataVersion = 6;
    const legacy = path.join(folder, 'format-6.helpr-backup');
    writeFileSync(legacy, JSON.stringify(envelope));
    expect(
      (await r.backup({ kind: 'inspect', file: legacy })).archive.tasks,
    ).toBe(1);
  } finally {
    r.close();
  }
});
