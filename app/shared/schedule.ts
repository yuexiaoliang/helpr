import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

const instant = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      Temporal.Instant.from(v);
      return true;
    } catch {
      return false;
    }
  });
export const scheduleTermsSchema = z.strictObject({
  zone: z.string().min(1).max(100),
  startAt: instant,
  cadence: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('calendar'),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }),
    z.strictObject({
      kind: z.literal('interval'),
      seconds: z
        .number()
        .int()
        .min(60)
        .max(366 * 86400),
    }),
    z.strictObject({ kind: z.literal('once') }),
  ]),
  overlap: z.enum(['earlier', 'later', 'ask']).nullable(),
  gap: z.enum(['skip', 'earlier', 'later', 'ask']).nullable(),
  missed: z.enum(['latest', 'skip', 'ask']).nullable(),
  graceSeconds: z.number().int().min(0).max(300),
  periodKey: z.enum(['date', 'round']),
});
export type ScheduleTerms = z.infer<typeof scheduleTermsSchema>;
export const scheduleVersionSchema = z.strictObject({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  agreementVersionId: z.string().uuid(),
  terms: scheduleTermsSchema,
  requestId: z.string(),
  request: z.string(),
  createdAt: z.number(),
  acceptedAt: z.number().nullable(),
  cancelledAt: z.number().nullable(),
});
export const occurrenceSchema = z.strictObject({
  key: z.string(),
  dueAt: z.number().int(),
  local: z.string(),
  date: z.string(),
  ambiguity: z.enum(['overlap', 'gap']).nullable(),
  treatment: z.enum(['run', 'skip', 'ask']),
});
export type Occurrence = z.infer<typeof occurrenceSchema>;
export const scheduleRoundSchema = z.strictObject({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  versionId: z.string().uuid(),
  occurrence: occurrenceSchema,
  from: z.number(),
  checkedAt: z.number(),
  status: z.enum(['claimed', 'skipped', 'waiting']),
  reason: z.string(),
  links: z.array(
    z.strictObject({
      taskId: z.string(),
      created: z.boolean(),
      workId: z.string().uuid().nullable(),
      sha256: z.string().nullable(),
    }),
  ),
});
export type ScheduleRound = z.infer<typeof scheduleRoundSchema>;
export const scheduleStateSchema = z.strictObject({
  revision: z.number().int().positive(),
  cursor: z.number(),
  restoreReview: z.boolean(),
  versions: z.array(scheduleVersionSchema).min(1).max(100),
  rounds: z.array(scheduleRoundSchema),
});
export type ScheduleState = z.infer<typeof scheduleStateSchema>;
const base = { taskId: z.string(), requestId: z.string().min(1).max(100) };
export const scheduleUICommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('schedule-prepare'),
    text: z.string().trim().min(1).max(4000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('schedule-accept'),
    versionId: z.string().uuid(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('schedule-cancel'),
    versionId: z.string().uuid(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('schedule-resume'),
    versionId: z.string().uuid(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('schedule-decide'),
    roundId: z.string().uuid(),
    decision: z.enum(['run', 'skip']),
  }),
]);
export type ScheduleUICommand = z.infer<typeof scheduleUICommandSchema>;

export function validateSchedule(t: ScheduleTerms, accepting = false) {
  // 只接受命名时区，绝不跟随机器时区或隐含 offset。
  if (/^[+-]/.test(t.zone)) throw Error('SCHEDULE_ZONE_REQUIRED');
  try {
    Temporal.Instant.from(t.startAt).toZonedDateTimeISO(t.zone);
  } catch {
    throw Error('SCHEDULE_ZONE_REQUIRED');
  }
  if (
    accepting &&
    (!t.missed || (t.cadence.kind === 'calendar' && (!t.overlap || !t.gap)))
  )
    throw Error('SCHEDULE_POLICY_REQUIRED');
}
function at(t: ScheduleTerms, ms: number): Occurrence {
  const zoned = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(
    t.zone,
  );
  return {
    key: String(ms),
    dueAt: ms,
    local: zoned.toString(),
    date: zoned.toPlainDate().toString(),
    ambiguity: null,
    treatment: 'run',
  };
}
/** 库只给候选；跳过、询问和位移来自已展示的计划字段。 */
export function calendarOccurrence(t: ScheduleTerms, date: string): Occurrence {
  if (t.cadence.kind !== 'calendar') throw Error('INVALID_REQUEST');
  const local = Temporal.PlainDate.from(date).toPlainDateTime(t.cadence.time);
  const early = local.toZonedDateTime(t.zone, { disambiguation: 'earlier' });
  const late = local.toZonedDateTime(t.zone, { disambiguation: 'later' });
  const ambiguity =
    early.epochMilliseconds === late.epochMilliseconds
      ? null
      : early.toPlainDateTime().equals(local)
        ? 'overlap'
        : 'gap';
  const policy =
    ambiguity === 'overlap'
      ? t.overlap
      : ambiguity === 'gap'
        ? t.gap
        : 'earlier';
  const selected =
    policy === 'earlier' || (ambiguity === 'overlap' && policy === 'ask')
      ? early
      : late;
  return {
    ...at(t, selected.epochMilliseconds),
    date,
    ambiguity,
    treatment:
      policy === 'skip'
        ? 'skip'
        : policy === 'ask' || policy === null
          ? 'ask'
          : 'run',
  };
}
export function nextOccurrence(
  t: ScheduleTerms,
  after: number,
): Occurrence | null {
  validateSchedule(t);
  const start = Temporal.Instant.from(t.startAt).epochMilliseconds;
  const floor = Math.max(start - 1, after);
  if (t.cadence.kind === 'once') return start > after ? at(t, start) : null;
  if (t.cadence.kind === 'interval') {
    const step = t.cadence.seconds * 1000;
    return at(
      t,
      start + Math.max(0, Math.floor((floor - start) / step) + 1) * step,
    );
  }
  let date = Temporal.Instant.fromEpochMilliseconds(floor)
    .toZonedDateTimeISO(t.zone)
    .toPlainDate();
  for (let n = 0; n < 9; n++, date = date.add({ days: 1 })) {
    if (!t.cadence.weekdays.includes(date.dayOfWeek)) continue;
    const candidate = calendarOccurrence(t, date.toString());
    if (candidate.dueAt > floor) return candidate;
  }
  throw Error('SCHEDULE_TIME_INVALID');
}
export function latestOccurrence(
  t: ScheduleTerms,
  now: number,
): Occurrence | null {
  const start = Temporal.Instant.from(t.startAt).epochMilliseconds;
  if (now < start) return null;
  if (t.cadence.kind === 'once') return at(t, start);
  if (t.cadence.kind === 'interval') {
    const step = t.cadence.seconds * 1000;
    return at(t, start + Math.floor((now - start) / step) * step);
  }
  let date = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(t.zone)
    .toPlainDate();
  for (let n = 0; n < 9; n++, date = date.subtract({ days: 1 })) {
    if (!t.cadence.weekdays.includes(date.dayOfWeek)) continue;
    const candidate = calendarOccurrence(t, date.toString());
    if (candidate.dueAt <= now && candidate.dueAt >= start) return candidate;
  }
  return null;
}
export function scheduleSummary(t: ScheduleTerms) {
  const time =
    t.cadence.kind === 'calendar'
      ? `每周 ${t.cadence.weekdays.join('、')} 的 ${t.cadence.time}（1 为周一，7 为周日）`
      : t.cadence.kind === 'interval'
        ? `从起点每隔 ${t.cadence.seconds} 秒（固定时长）`
        : '只执行一次';
  const policies = {
    earlier: '取较早时刻',
    later: '取较晚时刻',
    ask: '先询问',
    skip: '跳过',
    latest: '补最近一次',
  };
  return `时区 ${t.zone}，起点 ${t.startAt}，${time}。到点 ${t.graceSeconds} 秒内视为准时，超过后${t.missed ? policies[t.missed] : '尚未约定，不能启用'}；多个未开始轮次只处理最近一次，较早轮次记为跳过。重复时刻${t.overlap ? policies[t.overlap] : '尚未约定'}，不存在时刻${t.gap ? policies[t.gap] : '尚未约定'}。按期次发布时使用${t.periodKey === 'date' ? '计划时区的日期' : '预定轮次时刻'}。接受后只安排接受时刻之后的轮次；修改不重建已开始的工作。电脑与应用须保持运行，休眠或退出期间不保证按时执行。`;
}
