import { useRef, useState } from 'react';
import type { Task } from '../shared/contracts';
import { agreementSummary } from '../shared/agreement';
import {
  nextOccurrence,
  scheduleSummary,
  type ScheduleUICommand,
} from '../shared/schedule';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function ScheduledPlan({
  task,
  store,
  pendingOnly = false,
}: {
  task: Task;
  store: WorkspaceStore;
  pendingOnly?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const composing = useRef(false);
  const retry = useRef<ScheduleUICommand | null>(null);
  const s = task.execution?.schedule,
    v = s?.versions.at(-1);
  const a =
    task.execution?.agreements?.find(
      (a) => a.versionId === v?.agreementVersionId,
    ) ?? task.execution?.agreements?.at(-1);
  if (!a) return null;
  const base = { taskId: task.id, requestId: crypto.randomUUID() };
  const disabled = busy || !!task.executionControl?.system;
  async function submit(c: ScheduleUICommand) {
    if (busy || composing.current) return;
    const canonical = (c: ScheduleUICommand) =>
      JSON.stringify({ ...c, requestId: '' });
    if (!retry.current || canonical(retry.current) !== canonical(c))
      retry.current = c;
    setBusy(true);
    setError('');
    try {
      await store.perform(retry.current);
      retry.current = null;
    } catch {
      setError(store.get().notice || '计划尚未保存，请核对后重试。');
    } finally {
      setBusy(false);
    }
  }
  const rounds =
    s?.rounds
      .filter((r) => !pendingOnly || r.status === 'waiting')
      .slice(-8)
      .reverse() ?? [];
  let next: string[] = [];
  if (v && v.cancelledAt === null) {
    try {
      let after = s!.cursor;
      for (let n = 0; n < 3; n++) {
        const occurrence = nextOccurrence(v.terms, after);
        if (!occurrence) break;
        next.push(
          occurrence.local +
            (occurrence.ambiguity
              ? `（${occurrence.ambiguity === 'gap' ? '不存在时刻' : '重复时刻'}：${occurrence.treatment === 'ask' ? '待询问' : occurrence.treatment === 'skip' ? '跳过' : '按选择处理'}）`
              : ''),
        );
        after = occurrence.dueAt;
      }
    } catch {
      next = ['时间表达需补充，尚未启用。'];
    }
  }
  const contents = (
    <>
      {v && !pendingOnly && (
        <>
          <p>
            第 {v.version} 版 ·{' '}
            {v.cancelledAt !== null
              ? '已取消'
              : s?.restoreReview
                ? '恢复后待核对与选择'
                : v.acceptedAt === null
                  ? '待接受'
                  : '已启用'}
          </p>
          <p>{agreementSummary(a.terms)}</p>
          <p>{scheduleSummary(v.terms)}</p>
          {next.length > 0 && (
            <p>
              接下来的候选时间：
              <br />
              {next.join('；\n')}
            </p>
          )}
          {v.cancelledAt === null && v.acceptedAt === null && (
            <button
              type="button"
              disabled={
                disabled ||
                !v.terms.missed ||
                (v.terms.cadence.kind === 'calendar' &&
                  (!v.terms.gap || !v.terms.overlap))
              }
              onClick={() =>
                void submit({
                  ...base,
                  kind: 'schedule-accept',
                  versionId: v.versionId,
                })
              }
            >
              接受这个定时计划
            </button>
          )}
          {v.cancelledAt === null && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void submit({
                  ...base,
                  kind: 'schedule-cancel',
                  versionId: v.versionId,
                })
              }
            >
              取消定时计划
            </button>
          )}
          {s?.restoreReview &&
            v.cancelledAt === null &&
            v.acceptedAt !== null && (
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void submit({
                    ...base,
                    kind: 'schedule-resume',
                    versionId: v.versionId,
                  })
                }
              >
                核对原工作后继续这个计划
              </button>
            )}
        </>
      )}
      {rounds.map((r) => (
        <div key={r.id}>
          <p>
            {r.occurrence.local} ·{' '}
            {
              { claimed: '已处理轮次', skipped: '已跳过', waiting: '等待选择' }[
                r.status
              ]
            }
            <br />
            {r.reason}
          </p>
          {r.links.map((link, i) => (
            <p key={i}>
              {link.created ? '本轮任务' : '保留原任务'}：
              {store.get().state.tasks.find((t) => t.id === link.taskId)
                ?.execution?.summary ?? link.taskId}
            </p>
          ))}
          {r.status === 'waiting' && (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void submit({
                    ...base,
                    kind: 'schedule-decide',
                    roundId: r.id,
                    decision: 'run',
                  })
                }
              >
                现在补做这个轮次一次
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void submit({
                    ...base,
                    kind: 'schedule-decide',
                    roundId: r.id,
                    decision: 'skip',
                  })
                }
              >
                跳过这个轮次
              </button>
            </>
          )}
        </div>
      ))}
      {!pendingOnly && (
        <>
          <label>
            用自然语言设置或修改时间、时区和错过策略
            <textarea
              rows={3}
              maxLength={4000}
              value={text}
              placeholder="例如每天北京时间 09:00，错过补最近一次；夏令时重复或不存在的时刻先问我。取材与发布要求沿用上面的约定。"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={
              disabled ||
              !text.trim() ||
              a.acceptedAt === null ||
              a.revokedAt !== null
            }
            onClick={() =>
              void submit({
                ...base,
                kind: 'schedule-prepare',
                expectedRevision: s?.revision ?? 0,
                text,
              })
            }
          >
            复述定时计划
          </button>
          <p>
            修改先停用旧计划，新复述需接受。停止或关闭某一次任务不取消未来计划；原等待、停止和结果不明的工作保留在原任务。
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
  return pendingOnly ? (
    <section aria-label="定时计划待办">{contents}</section>
  ) : (
    <details className={styles.articleSources}>
      <summary>定时计划</summary>
      {contents}
    </details>
  );
}
