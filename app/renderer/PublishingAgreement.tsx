import { useRef, useState, useSyncExternalStore } from 'react';
import type { Task } from '../shared/contracts';
import { agreementSummary, type AgreementUICommand } from '../shared/agreement';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function PublishingAgreement({
  task,
  store,
}: {
  task: Task;
  store: WorkspaceStore;
}) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const [text, setText] = useState('');
  const [period, setPeriod] = useState('');
  const [repeatOf, setRepeatOf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const composing = useRef(false);
  const pending = useRef<AgreementUICommand | null>(null);
  const e = task.execution;
  if (!e) return null;
  const a = e.agreements?.at(-1);
  const active = a?.acceptedAt !== null && a?.revokedAt === null;
  const works = view.state.tasks.flatMap((t) =>
    (t.execution?.materialWorks ?? [])
      .filter((w) => w.binding.agreementId === a?.id && w.status === 'complete')
      .map((w) => ({ work: w, task: t })),
  );
  const disabled = busy || !!task.executionControl?.system;
  const base = { taskId: task.id, requestId: crypto.randomUUID() };
  async function submit(c: AgreementUICommand) {
    if (busy || composing.current) return;
    const { requestId: _requestId, ...body } = c;
    const { requestId: _prior, ...prior } = pending.current ?? c;
    void _requestId;
    void _prior;
    if (JSON.stringify(body) !== JSON.stringify(prior) || !pending.current)
      pending.current = c;
    setBusy(true);
    setError('');
    try {
      await store.perform(pending.current);
      pending.current = null;
    } catch {
      setError(store.get().notice || '未能保存发布约定，请核对后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={styles.articleSources}>
      <summary>发布约定</summary>
      {a && (
        <>
          <p>
            第 {a.version} 版 ·{' '}
            {a.revokedAt !== null
              ? '已撤销'
              : a.acceptedAt !== null
                ? '已接受'
                : '待接受'}
          </p>
          <p>{agreementSummary(a.terms)}</p>
          {a.revokedAt === null && a.acceptedAt === null && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void submit({
                  ...base,
                  kind: 'agreement-accept',
                  versionId: a.versionId,
                })
              }
            >
              接受这个发布约定
            </button>
          )}
          {a.revokedAt === null && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void submit({
                  ...base,
                  kind: 'agreement-revoke',
                  versionId: a.versionId,
                })
              }
            >
              撤销发布约定
            </button>
          )}
          {active && (
            <>
              {a.terms.period === 'per-period' && (
                <label>
                  本次日期或期次
                  <input
                    value={period}
                    maxLength={100}
                    onChange={(v) => setPeriod(v.target.value)}
                  />
                </label>
              )}
              <button
                type="button"
                disabled={
                  disabled ||
                  (a.terms.period === 'per-period' && !period.trim())
                }
                onClick={() =>
                  void submit({
                    ...base,
                    kind: 'agreement-use',
                    versionId: a.versionId,
                    periodKey: period,
                    repeatOf: null,
                  })
                }
              >
                按约定处理新素材
              </button>
              {works.length > 0 && (
                <>
                  <label>
                    再次发布哪份已完成的工作
                    <select
                      value={repeatOf}
                      onChange={(v) => setRepeatOf(v.target.value)}
                    >
                      <option value="">选择已完成工作</option>
                      {works.map(({ work, task: source }) => (
                        <option key={work.id} value={work.id}>
                          {
                            source.execution?.materials?.find(
                              (m) => m.id === work.materialId,
                            )?.name
                          }{' '}
                          · {work.binding.periodKey || '同内容一次'} ·{' '}
                          {work.sha256.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={disabled || !repeatOf}
                    onClick={() => {
                      const work = works.find(
                        (w) => w.work.id === repeatOf,
                      )?.work;
                      if (work)
                        void submit({
                          ...base,
                          kind: 'agreement-use',
                          versionId: a.versionId,
                          periodKey: work.binding.periodKey,
                          repeatOf,
                        });
                    }}
                  >
                    明确再发一次
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
      <label>
        {a ? '用自然语言修改约定' : '以后如何自动发布'}
        <textarea
          rows={3}
          value={text}
          maxLength={4000}
          placeholder="说明素材文件夹、选择规则、网站入口、栏目、内容要求，以及文件变化后另发还是先确认。"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(v) => setText(v.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={
          disabled ||
          !text.trim() ||
          ['queued', 'checking', 'running'].includes(e.phase)
        }
        onClick={() =>
          void submit({
            ...base,
            kind: 'agreement-prepare',
            expectedVersion: e.version,
            text,
          })
        }
      >
        复述约定供我确认
      </button>
      <p>
        修改时先撤销旧约定，接受新复述后才用于后续工作。当前内容的单次确认独立保留。
      </p>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
