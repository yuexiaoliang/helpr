import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { validScheduleCatalog } from '../../app/records/schedule';
import { ExecutionService } from '../../app/desktop/execution-service';
import {
  calendarOccurrence,
  nextOccurrence,
  latestOccurrence,
  type ScheduleTerms,
} from '../../app/shared/schedule';
import type { AgreementTerms } from '../../app/shared/agreement';
import { readBackup } from '../../app/records/backup';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
const time: ScheduleTerms = {
  zone: 'Asia/Shanghai',
  startAt: '2026-01-01T00:00:00Z',
  cadence: { kind: 'calendar', time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] },
  overlap: 'ask',
  gap: 'ask',
  missed: 'ask',
  graceSeconds: 60,
  periodKey: 'date',
};

test('日历日与固定24小时在夏令时边界保持不同的承诺，主机时区不改时间', () => {
  const daily: ScheduleTerms = {
    ...time,
    zone: 'America/New_York',
    cadence: {
      kind: 'calendar',
      time: '09:00',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    },
  };
  const before = calendarOccurrence(daily, '2026-03-07');
  const after = nextOccurrence(daily, before.dueAt)!;
  expect((after.dueAt - before.dueAt) / 3600000).toBe(23);
  expect(after.local).toContain('T09:00:00-04:00');
  const interval = nextOccurrence(
    {
      ...daily,
      startAt: new Date(before.dueAt).toISOString(),
      cadence: { kind: 'interval', seconds: 86400 },
    },
    before.dueAt,
  )!;
  expect(interval.local).toContain('T10:00:00-04:00');
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    expect(nextOccurrence(daily, before.dueAt)).toEqual(after);
  } finally {
    if (original) process.env.TZ = original;
    else delete process.env.TZ;
  }
});
test('明确检测重复、不存在、半小时变化与整日跳过，下一天不继承位移', () => {
  const ny: ScheduleTerms = {
    ...time,
    zone: 'America/New_York',
    cadence: {
      kind: 'calendar',
      time: '02:30',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    },
  };
  const gap = calendarOccurrence(ny, '2026-03-08');
  expect(gap).toMatchObject({ ambiguity: 'gap', treatment: 'ask' });
  expect(
    calendarOccurrence({ ...ny, gap: 'skip' }, '2026-03-08').treatment,
  ).toBe('skip');
  expect(
    calendarOccurrence({ ...ny, gap: 'later' }, '2026-03-08').local,
  ).toContain('T03:30');
  expect(nextOccurrence({ ...ny, gap: 'later' }, gap.dueAt)?.local).toContain(
    'T02:30',
  );
  const overlap = {
    ...ny,
    cadence: {
      ...ny.cadence,
      kind: 'calendar' as const,
      time: '01:30',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    },
  };
  expect(calendarOccurrence(overlap, '2026-11-01').ambiguity).toBe('overlap');
  expect(
    calendarOccurrence({ ...overlap, overlap: 'later' }, '2026-11-01').dueAt -
      calendarOccurrence({ ...overlap, overlap: 'earlier' }, '2026-11-01')
        .dueAt,
  ).toBe(3600000);
  expect(
    calendarOccurrence(
      {
        ...ny,
        zone: 'Australia/Lord_Howe',
        cadence: {
          kind: 'calendar',
          time: '02:15',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      },
      '2026-10-04',
    ).ambiguity,
  ).toBe('gap');
  expect(
    calendarOccurrence({ ...ny, zone: 'Pacific/Apia' }, '2011-12-30').ambiguity,
  ).toBe('gap');
});
test('周历、固定起点与一次计划没有隐含追补历史，长时间间隔直接找最近候选', () => {
  expect(
    nextOccurrence(
      { ...time, cadence: { kind: 'calendar', time: '09:00', weekdays: [1] } },
      Date.parse('2026-11-06T08:00:00Z'),
    )?.date,
  ).toBe('2026-11-09');
  const once: ScheduleTerms = { ...time, cadence: { kind: 'once' } };
  expect(nextOccurrence(once, Date.parse(time.startAt))).toBeNull();
  expect(
    latestOccurrence(
      { ...time, cadence: { kind: 'interval', seconds: 60 } },
      Date.parse('2036-01-01T00:00:30Z'),
    )?.local,
  ).toContain('T08:00:00');
});

async function fixture(rule: AgreementTerms['selection']['rule'] = 'only') {
  let now = Date.parse('2026-11-07T00:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const dir = await mkdtemp(path.join(tmpdir(), 'helpr-schedule-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const material = path.join(dir, 'a.xlsx');
  await writeFile(
    material,
    await readFile('tests/workspace/fixtures/excel/report-a.xlsx'),
  );
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  cleanup.push(() => {
    records.close();
    return Promise.resolve();
  });
  const owner = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: '定时发布素材',
  }).taskId;
  records.execution({
    kind: 'intent',
    taskId: owner,
    intent: 'stop',
    requestId: randomUUID(),
  });
  const get = (id = owner) =>
    records.snapshot().tasks.find((t) => t.id === id)!.execution!;
  const agreement: AgreementTerms = {
    selection: {
      scope: dir,
      rule,
      name: null,
      extension: '.xlsx',
      ...(rule === 'date' ? { dateName: '{date}.xlsx' } : {}),
    },
    entryUrl: 'https://example.com/edit',
    destination: '公告',
    contentRules: '按原表列出事实',
    changedBytes: 'new-publication',
    period: 'once-per-material',
  };
  records.execution({
    kind: 'agreement-propose',
    taskId: owner,
    requestId: randomUUID(),
    expectedVersion: get().version,
    text: '按这份要求自动发布',
    terms: agreement,
  });
  records.execution({
    kind: 'agreement-accept',
    taskId: owner,
    requestId: randomUUID(),
    versionId: get().agreements![0]!.versionId,
  });
  const terms: ScheduleTerms = {
    ...time,
    cadence: { kind: 'interval', seconds: 60 },
    startAt: new Date(now + 60000).toISOString(),
    missed: 'latest',
  };
  const propose = async (overrides: Partial<ScheduleTerms> = {}) => {
    await records.scheduled({
      kind: 'schedule-propose',
      taskId: owner,
      requestId: randomUUID(),
      expectedRevision: get().schedule?.revision ?? 0,
      text: '每分钟，错过补最近一次',
      terms: { ...terms, ...overrides },
    });
    return get().schedule!.versions.at(-1)!;
  };
  const accept = () =>
    records.scheduled({
      kind: 'schedule-accept',
      taskId: owner,
      requestId: randomUUID(),
      versionId: get().schedule!.versions.at(-1)!.versionId,
    });
  const prepare = () =>
    records.scheduled({ kind: 'prepare', taskId: owner, now });
  const tick = async () => {
    const result = await prepare();
    if (result.token)
      await records.scheduled({ kind: 'commit', token: result.token });
  };
  return {
    dir,
    material,
    owner,
    get,
    terms,
    propose,
    accept,
    prepare,
    tick,
    records: () => records,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(dir, 'app/records/migrations');
    },
  };
}
test('未接受或缺错过策略的计划不领取；接受不追补已过去的起点', async () => {
  const f = await fixture();
  await f.propose({ missed: null });
  await expect(f.accept()).rejects.toThrow('SCHEDULE_POLICY_REQUIRED');
  f.advance(180000);
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(0);
  await f.propose();
  await f.accept();
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(0);
  f.advance(60000);
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(1);
});
test('轮次与素材领取原子去重，停止与隐藏原任务保持，新字节继续，冷开不重领', async () => {
  const f = await fixture();
  await f.propose();
  await f.accept();
  f.advance(60000);
  const active = f.records().snapshot().active;
  await Promise.all([f.tick(), f.tick()]);
  await f.tick();
  expect(f.records().snapshot().tasks).toHaveLength(2);
  expect(f.records().snapshot().active).toBe(active);
  const old = f.get().schedule!.rounds[0]!.links[0]!.taskId;
  f.records().execution({
    kind: 'intent',
    taskId: old,
    requestId: randomUUID(),
    intent: 'stop',
  });
  f.records().execute({
    kind: 'hide-task',
    taskId: old,
    requestId: randomUUID(),
  });
  await rename(f.material, path.join(f.dir, 'renamed.xlsx'));
  f.advance(60000);
  await f.tick();
  expect(f.get().schedule!.rounds.at(-1)!.links[0]).toMatchObject({
    taskId: old,
    created: false,
  });
  expect(f.get(old).intent).toBe('stopped');
  await writeFile(
    path.join(f.dir, 'renamed.xlsx'),
    await readFile('tests/workspace/fixtures/excel/report-b.xlsx'),
  );
  f.advance(60000);
  await f.tick();
  expect(f.records().snapshot().tasks).toHaveLength(3);
  expect(f.get(old).intent).toBe('stopped');
  f.reopen();
  await f.tick();
  expect(f.records().snapshot().tasks).toHaveLength(3);
  expect(
    validScheduleCatalog(
      f
        .records()
        .snapshot()
        .tasks.map((t) => ({ taskId: t.id, execution: t.execution })),
    ),
  ).toBe(true);
});
test.each(['latest', 'skip', 'ask'] as const)(
  '错过策略 %s 只针对未开始的最近轮次，保留范围与选择',
  async (missed) => {
    const f = await fixture();
    await f.propose({ missed });
    await f.accept();
    f.advance(10 * 60000 + 61000);
    await f.tick();
    // 当前最新轮次刚到点，按允许窗口执行；另做真正超窗的稀疏计划。
    expect(f.get().schedule!.rounds).toHaveLength(1);
    await f.propose({ missed, cadence: { kind: 'interval', seconds: 3600 } });
    await f.accept();
    f.advance(4 * 3600000 + 180000);
    await f.tick();
    const round = f.get().schedule!.rounds.at(-1)!;
    expect(round.status).toBe(
      missed === 'latest'
        ? 'claimed'
        : missed === 'skip'
          ? 'skipped'
          : 'waiting',
    );
    if (missed === 'ask') {
      const answer = await f.records().scheduled({
        kind: 'schedule-decide',
        taskId: f.owner,
        requestId: randomUUID(),
        roundId: round.id,
        decision: 'run',
      });
      await f.records().scheduled({ kind: 'commit', token: answer.token });
      expect(f.get().schedule!.rounds.at(-1)!.status).toBe('claimed');
    }
  },
);
test('取消和升级准备使已读取的候选失效，已开始的旧任务没有被新版本绕过', async () => {
  const f = await fixture();
  const v = await f.propose();
  await f.accept();
  f.advance(60000);
  const ready = await f.prepare();
  await f.records().scheduled({
    kind: 'schedule-cancel',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: v.versionId,
  });
  await f.records().scheduled({ kind: 'commit', token: ready.token });
  expect(f.records().snapshot().tasks).toHaveLength(1);
  await f.propose();
  await f.accept();
  f.advance(60000);
  const next = await f.prepare();
  f.records().upgrade({
    kind: 'prepare',
    requestId: randomUUID(),
    target: '0.3.0',
  });
  await expect(
    f.records().scheduled({ kind: 'commit', token: next.token }),
  ).rejects.toThrow('UPGRADE_PENDING');
  expect(f.records().snapshot().tasks).toHaveLength(1);
});
test('全部未完成素材各自取得所属任务，缺素材和多义产生参与请求而非空发', async () => {
  const f = await fixture('all-unprocessed');
  await writeFile(
    path.join(f.dir, 'b.xlsx'),
    await readFile('tests/workspace/fixtures/excel/report-b.xlsx'),
  );
  await f.propose();
  await f.accept();
  f.advance(60000);
  await f.tick();
  expect(f.get().schedule!.rounds[0]!.links).toHaveLength(2);
  const ids = f.get().schedule!.rounds[0]!.links.map((l) => l.taskId);
  f.advance(60000);
  await f.tick();
  expect(f.get().schedule!.rounds[1]!.links.map((l) => l.taskId)).toEqual(ids);
  await rm(f.material);
  await rm(path.join(f.dir, 'b.xlsx'));
  f.advance(60000);
  await f.tick();
  const missing = f.get().schedule!.rounds.at(-1)!.links[0]!;
  expect(f.get(missing.taskId).question?.text).toContain('没有找到');
});
test('日期选材按预定时区日期，取消计划不修改手动开始的重复旧工作', async () => {
  const f = await fixture('date');
  await rename(f.material, path.join(f.dir, '2026-11-07.xlsx'));
  const v = await f.propose();
  await f.accept();
  f.advance(60000);
  await f.tick();
  const child = f.get().schedule!.rounds[0]!.links[0]!.taskId;
  expect(f.get(child).materials?.[0]?.name).toBe('2026-11-07.xlsx');
  await f.records().scheduled({
    kind: 'schedule-cancel',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: v.versionId,
  });
  expect(f.get(child).intent).toBe('stopped');
});
test('备份完整保存计划轮次；旧备份恢复不覆盖新取消且恢复计划需逐项核对', async () => {
  const f = await fixture();
  const v = await f.propose();
  await f.accept();
  f.advance(60000);
  await f.tick();
  const file = path.join(f.dir, 'schedule.helpr-backup');
  const saved = await f
    .records()
    .backup({ kind: 'create', requestId: randomUUID(), file });
  expect(
    (await readBackup(file)).payload.tasks.find((t) => t.id === f.owner)!
      .execution!.schedule!.rounds,
  ).toHaveLength(1);
  await f.records().scheduled({
    kind: 'schedule-cancel',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: v.versionId,
  });
  await f.records().backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  expect(f.get().schedule!.restoreReview).toBe(true);
  expect(f.get().schedule!.versions[0]!.cancelledAt).not.toBeNull();
  f.advance(60000);
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(1);
  f.reopen();
  expect(f.get().schedule!.versions[0]!.cancelledAt).not.toBeNull();
});
test('统一控制入口在候选读取后遇到休眠不提交，解除后按既定错过策略处理', async () => {
  const f = await fixture();
  await f.propose();
  await f.accept();
  f.advance(60000);
  let state = f.records().snapshot();
  let reached!: () => void, release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ExecutionService({
    current: () => state,
    publish: (s) => {
      state = s;
    },
    records: (c) => Promise.resolve(f.records().execution(c)),
    scheduled: async (c) => {
      const r = await f.records().scheduled(c);
      if ((c as { kind: string }).kind === 'prepare') {
        reached();
        await waiting;
      }
      return r;
    },
    observe: () => Promise.reject(Error('PAGE_NOT_AVAILABLE')),
    propose: () => Promise.reject(Error('MODEL_NOT_CONFIGURED')),
    perform: async () => {},
    revoke: () => {},
    stopModels: () => {},
  });
  const tick = service.tickPlans(f.now());
  await reachedPromise;
  await service.setSystemCondition('sleeping', true);
  release();
  await tick;
  expect(f.get().schedule!.rounds).toHaveLength(0);
  await service.setSystemCondition('sleeping', false);
  await service.tickPlans(f.now());
  expect(f.get().schedule!.rounds).toHaveLength(1);
  await service.stopAll();
});

test('领取事务保存失败不会留下孤立任务或轮次，重试仍只产生一份工作', async () => {
  const f = await fixture();
  await f.propose();
  await f.accept();
  f.advance(60000);
  const external = new Database(path.join(f.dir, 'workspace.sqlite'));
  try {
    external.exec(
      "CREATE TRIGGER fail_schedule BEFORE INSERT ON task_executions BEGIN SELECT RAISE(ABORT, 'TEST_STORAGE_FAILURE'); END",
    );
    await expect(f.tick()).rejects.toThrow('TEST_STORAGE_FAILURE');
    expect(f.records().snapshot().tasks).toHaveLength(1);
    expect(f.get().schedule!.rounds).toHaveLength(0);
    external.exec('DROP TRIGGER fail_schedule');
    await f.tick();
    await f.tick();
    expect(f.records().snapshot().tasks).toHaveLength(2);
    expect(f.get().schedule!.rounds).toHaveLength(1);
  } finally {
    external.close();
  }
});

test('改版与时钟回拨不重领轮次，篡改轮次和工作引用在冷开前可检测', async () => {
  const f = await fixture();
  await f.propose();
  await f.accept();
  f.advance(60000);
  await f.tick();
  const original = f.get().schedule!.rounds[0]!;
  await f.propose({ zone: 'Europe/Berlin' });
  await f.accept();
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(1);
  f.advance(-30000);
  await f.tick();
  expect(f.get().schedule!.rounds).toHaveLength(1);
  const rows = f
    .records()
    .snapshot()
    .tasks.map((t) => ({ taskId: t.id, execution: t.execution }));
  expect(validScheduleCatalog(rows)).toBe(true);
  rows.find(
    (r) => r.taskId === f.owner,
  )!.execution!.schedule!.rounds[0]!.links[0]!.taskId = f.owner;
  expect(validScheduleCatalog(rows)).toBe(false);
  expect(f.get().schedule!.rounds[0]!.id).toBe(original.id);
});

test('已停止的旧工作不因询问补做而继续，计划取消只停止自己新建的工作', async () => {
  const f = await fixture();
  const agreement = f.get().agreements![0]!;
  const old = f.records().execution({
    kind: 'agreement-use',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: agreement.versionId,
    periodKey: '',
    repeatOf: null,
  }).taskId as string;
  await f
    .records()
    .material({ kind: 'agreement-select', taskId: old, expectedVersion: 1 });
  f.records().execution({
    kind: 'intent',
    taskId: old,
    requestId: randomUUID(),
    intent: 'stop',
  });
  const v = await f.propose({
    missed: 'ask',
    cadence: { kind: 'interval', seconds: 3600 },
  });
  await f.accept();
  f.advance(130000);
  await f.tick();
  const round = f.get().schedule!.rounds[0]!;
  const prepared = await f.records().scheduled({
    kind: 'schedule-decide',
    taskId: f.owner,
    requestId: randomUUID(),
    roundId: round.id,
    decision: 'run',
  });
  await f.records().scheduled({ kind: 'commit', token: prepared.token });
  expect(f.get().schedule!.rounds[0]!.links[0]).toMatchObject({
    taskId: old,
    created: false,
  });
  const version = f.get(old).version;
  await f.records().scheduled({
    kind: 'schedule-cancel',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: v.versionId,
  });
  expect(f.get(old).version).toBe(version);
  expect(f.get(old).intent).toBe('stopped');
});
