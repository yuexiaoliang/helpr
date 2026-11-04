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
import { requestApplicationQuit } from '../../app/desktop/controller';

vi.mock('electron', () => ({
  app: {},
  utilityProcess: {},
  Menu: {},
  Tray: {},
  nativeImage: {},
  safeStorage: {},
  powerMonitor: {},
  shell: {},
}));

const folders: string[] = [];
const closeOwners: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  closeOwners.splice(0).forEach((close) => close());
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

test('升级后尚待检查时普通退出可靠保存，重开仍须检查且不解除升级暂停', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  const quit = vi.fn(() => {
    h.records.checkpoint();
    return Promise.resolve();
  });
  expect(service.held()).toBe(true);
  await expect(
    requestApplicationQuit({ upgrades: service, canExit: () => true, quit }),
  ).resolves.toBeNull();
  expect(quit).toHaveBeenCalledOnce();
  expect(service.held()).toBe(true);
  const reopened = await h.reopen();
  expect(reopened.held()).toBe(true);
  expect(await reopened.handle({ kind: 'upgrade-status' })).toMatchObject({
    phase: 'checking',
    reopening: true,
    continuity: 'unchecked',
  });
  expect(h.releases).toBe(1);
});

test('升级检查失败后可退出，原失败、备份与执行屏障保持', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  h.setFailure('MODEL_CREDENTIAL_UNAVAILABLE');
  const blocked = await service.handle({ kind: 'upgrade-check' });
  expect(blocked).toMatchObject({
    phase: 'blocked',
    error: 'MODEL_CREDENTIAL_UNAVAILABLE',
  });
  const ledger = h.records.upgrade({ kind: 'status' });
  await requestApplicationQuit({
    upgrades: service,
    canExit: () => true,
    quit: () => {
      h.records.checkpoint();
      return Promise.resolve();
    },
  });
  const after = h.records.upgrade({ kind: 'status' });
  expect(after.workspaceRevision).toBeGreaterThanOrEqual(
    ledger.workspaceRevision,
  );
  expect({ ...after, workspaceRevision: ledger.workspaceRevision }).toEqual(
    ledger,
  );
  expect(service.held()).toBe(true);
  expect(h.releases).toBe(1);
});

test('升级核对进行中仍不能退出，核对结束后才允许，未可靠保存继续阻止退出', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  let completeCapture = () => {};
  const gate = new Promise<void>((resolve) => (completeCapture = resolve));
  h.setCaptureGate(() => gate);
  const before = h.captures;
  const checking = service.handle({ kind: 'upgrade-check' });
  const quit = vi.fn(async () => {});
  try {
    await vi.waitFor(() => expect(h.captures).toBe(before + 1));
    await expect(
      requestApplicationQuit({ upgrades: service, canExit: () => true, quit }),
    ).rejects.toThrow('UPGRADE_PENDING');
    expect(quit).not.toHaveBeenCalled();
  } finally {
    completeCapture();
    await checking;
  }
  await expect(
    requestApplicationQuit({ upgrades: service, canExit: () => false, quit }),
  ).rejects.toThrow('UNSAVED_CHANGES');
  expect(quit).not.toHaveBeenCalled();
});

test('升级待核对时退出保存失败不清除升级记录或屏障', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  const ledger = h.records.upgrade({ kind: 'status' });
  await expect(
    requestApplicationQuit({
      upgrades: service,
      canExit: () => true,
      quit: () => Promise.reject(Error('SQLITE_BUSY')),
    }),
  ).rejects.toThrow('SQLITE_BUSY');
  expect(h.records.upgrade({ kind: 'status' })).toEqual(ledger);
  expect(service.held()).toBe(true);
});

test.each([
  {
    change: { credential: 'f'.repeat(64) },
    error: 'UPGRADE_CREDENTIAL_CHANGED',
  },
  { change: { profile: 'f'.repeat(64) }, error: 'UPGRADE_LOGIN_CHANGED' },
  { change: { cookies: [] }, error: 'UPGRADE_LOGIN_CHANGED' },
  { change: { nativeReady: false }, error: 'UPGRADE_CONTROL_UNAVAILABLE' },
  {
    change: {
      application: {
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        identifier: 'local.helpr.desktop' as const,
        requirement: 'f'.repeat(64),
      },
    },
    error: 'UPGRADE_PACKAGE_UNVERIFIED',
  },
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

test('会话到期与丢失有效登录分开，更新后保留到期事实而非改判原登录延续', async () => {
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
    application: {
      platform: 'darwin',
      arch: 'arm64',
      identifier: 'local.helpr.desktop',
      requirement: 'e'.repeat(64),
    },
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
  let checkpointFailure = '';
  let pagesOpen = true;
  let backupDirectory = folder;
  let afterBackup = () => {};
  let captures = 0;
  let releases = 0;
  let captureGate = () => Promise.resolve();
  const make = (version: string) =>
    new UpgradeService({
      version,
      records: (c) => Promise.resolve(records.upgrade(c)),
      hold: () => Promise.resolve(),
      release: () => {
        releases++;
        return Promise.resolve();
      },
      ready: () => true,
      capture: async () => {
        captures++;
        await captureGate();
        return failure
          ? Promise.reject(Error(failure))
          : Promise.resolve(structuredClone(proof));
      },
      pages: () => Promise.resolve(proof.pages),
      acknowledge: () => Promise.resolve(),
      choose: () => Promise.resolve(backupDirectory),
      backup: async (requestId, file) => {
        const { archive } = await records.backup({
          kind: 'create',
          requestId,
          file,
        });
        afterBackup();
        return archive;
      },
      versions: () => ({
        revision: 2,
        phase: 'done',
        result: { kind: 'available', release: { version: '0.2.0' } },
      }),
      publish: () => {},
      quit: () => Promise.resolve(),
      closePages: () => {
        pagesOpen = false;
        return Promise.resolve();
      },
      checkpoint: () =>
        checkpointFailure
          ? Promise.reject(Error(checkpointFailure))
          : Promise.resolve(),
      cancelExit: () => Promise.resolve(),
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
    folder,
    service: old,
    setBackupDirectory: (directory: string) => {
      backupDirectory = directory;
    },
    afterBackup: (effect: () => void) => {
      afterBackup = effect;
    },
    get pagesOpen() {
      return pagesOpen;
    },
    get captures() {
      return captures;
    },
    setCaptureGate: (gate: () => Promise<void>) => {
      captureGate = gate;
    },
    get releases() {
      return releases;
    },
    setCheckpointFailure: (code: string) => {
      checkpointFailure = code;
    },
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

test('取消本次准备后仍可再次准备，保留旧备份并生成新的操作身份', async () => {
  const h = await preparedUpgrade();
  const before = h.records.upgrade({ kind: 'status' });
  const cancelled = await h.service.handle({ kind: 'upgrade-cancel' });
  expect(cancelled).toMatchObject({ phase: 'complete', reopening: false });
  const next = await h.service.handle({
    kind: 'upgrade-prepare',
    requestId: randomUUID(),
    versionRevision: 2,
  });
  expect(next.phase).toBe('ready');
  expect(next.requestId).not.toBe(before.requestId);
});

test('v3换版检查不能越过原网页未保存状态，逐项处理后才放行基础核对', async () => {
  const h = await preparedUpgrade();
  const service = await h.reopen();
  const releases = h.releases;
  h.setProof({
    pages: [{ taskId: 'original-page', generation: 1, epoch: 2, dirty: true }],
  });
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'blocked',
    error: 'UPGRADE_PAGE_UNSAVED',
    dirtyTasks: ['original-page'],
  });
  expect(h.releases).toBe(releases);
  expect(h.pagesOpen).toBe(true);
  h.setProof({
    pages: [{ taskId: 'original-page', generation: 1, epoch: 2, dirty: false }],
  });
  expect(await service.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'complete',
    error: '',
  });
  expect(h.releases).toBe(releases + 1);
});

test('v3重开旧版检查成功后，外部换成新版仍须重新取得本轮包与控制证据', async () => {
  const h = await preparedUpgrade();
  const old = await h.reopen('0.1.0');
  expect(await old.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'complete',
  });
  const captures = h.captures,
    releases = h.releases;
  const newer = await h.reopen('0.2.0');
  expect(await newer.handle({ kind: 'upgrade-status' })).toMatchObject({
    phase: 'checking',
    reopening: true,
  });
  expect(h.releases).toBe(releases);
  h.setFailure('UPGRADE_PACKAGE_UNVERIFIED');
  expect(await newer.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'blocked',
    error: 'UPGRADE_PACKAGE_UNVERIFIED',
  });
  expect(h.captures).toBeGreaterThan(captures);
  expect(h.releases).toBe(releases);
  h.setFailure('');
  expect(await newer.handle({ kind: 'upgrade-check' })).toMatchObject({
    phase: 'complete',
  });
});

test('v3取消准备只返回原网页，保留尚未保存现场，不要求丢弃或伪造保存', async () => {
  const h = await preparedUpgrade();
  h.setProof({
    pages: [{ taskId: 'original-page', generation: 1, epoch: 3, dirty: true }],
  });
  expect(await h.service.handle({ kind: 'upgrade-cancel' })).toMatchObject({
    phase: 'complete',
    dirtyTasks: ['original-page'],
  });
  expect(h.pagesOpen).toBe(true);
});

test('实际备份位置不可写入时不报告可退出，原任务和旧备份仍可读取', async () => {
  const h = await preparedUpgrade();
  const before = h.records.snapshot();
  const oldBackup = h.records.upgrade({ kind: 'status' }).backup!;
  const original = readFileSync(oldBackup.file);
  await h.service.handle({ kind: 'upgrade-cancel' });
  const regularFile = path.join(h.folder, 'not-a-directory');
  writeFileSync(regularFile, '保留原文件');
  h.setBackupDirectory(regularFile);
  expect(
    await h.service.handle({
      kind: 'upgrade-prepare',
      requestId: randomUUID(),
      versionRevision: 2,
    }),
  ).toMatchObject({
    phase: 'blocked',
    error: 'BACKUP_STORAGE_UNAVAILABLE',
    backup: null,
  });
  expect(h.service.held()).toBe(true);
  expect(h.pagesOpen).toBe(true);
  expect(h.records.snapshot().tasks).toEqual(before.tasks);
  expect(readFileSync(oldBackup.file)).toEqual(original);
  expect(readFileSync(regularFile, 'utf8')).toBe('保留原文件');
  expect(
    (await h.records.backup({ kind: 'inspect', file: oldBackup.file })).archive
      .id,
  ).toBe(oldBackup.id);
});

test('真实备份完成期间的新停止使准备失效，保留该停止与已写备份', async () => {
  const h = await preparedUpgrade();
  await h.service.handle({ kind: 'upgrade-cancel' });
  h.afterBackup(() =>
    h.records.execution({
      kind: 'intent',
      taskId: h.records.snapshot().tasks[0]!.id,
      requestId: 'stop-during-backup',
      intent: 'stop',
    }),
  );
  expect(
    await h.service.handle({
      kind: 'upgrade-prepare',
      requestId: randomUUID(),
      versionRevision: 2,
    }),
  ).toMatchObject({ phase: 'blocked', error: 'UPGRADE_CHANGED', backup: null });
  expect(h.records.snapshot().tasks[0]?.execution?.intent).toBe('stopped');
  expect(h.pagesOpen).toBe(true);
  expect(h.service.held()).toBe(true);
  expect(
    readdirSync(h.folder).filter((file) => file.endsWith('.helpr-backup')),
  ).toHaveLength(2);
});

test('记录关闭再打开后，凭据端口拒绝读取时保持暂停，恢复原依据再检查', async () => {
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

test('升级退出的可靠检查点失败时，网页关闭边界尚未触发，原文字仍在', async () => {
  const h = await preparedUpgrade();
  h.setCheckpointFailure('UNSAVED_CHANGES');
  const ledger = h.records.upgrade({ kind: 'status' });
  expect(
    await h.service.handle({ kind: 'upgrade-exit', revision: ledger.revision }),
  ).toMatchObject({ phase: 'blocked', error: 'UNSAVED_CHANGES' });
  expect(h.pagesOpen).toBe(true);
});

test('逐项现场依据核对后才生成业务备份，新停止使退出资格失效', async () => {
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
    application: {
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      identifier: 'local.helpr.desktop' as const,
      requirement: 'e'.repeat(64),
    },
    profile: 'a'.repeat(64),
    cookies: [],
    pages: [{ taskId: a, generation: 1, epoch: 2, dirty }],
    nativeReady: true,
  });
  const service = new UpgradeService({
    version: '0.1.0',
    records: (c) => Promise.resolve(records.upgrade(c)),
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
    checkpoint: () => Promise.resolve(),
    cancelExit: () => Promise.resolve(),
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

test('构造的格式6库迁移失败保留原副本，修复后原任务草稿可读，格式6业务备份仍可检查', async () => {
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
