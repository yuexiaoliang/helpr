import { useEffect, useState } from 'react';
import { Heading } from 'react-aria-components';
import { backupStatusSchema, type BackupStatus } from '../shared/backup';
import type { UICommand, WorkspaceSnapshot } from '../shared/contracts';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function BackupSettings({
  store,
  state,
}: {
  store: WorkspaceStore;
  state: WorkspaceSnapshot;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void store
      .perform({ kind: 'backup-status' })
      .then((result) => {
        if (active) setStatus(backupStatusSchema.parse(result));
      })
      .catch(() => {
        if (active) setError(store.get().notice);
      });
    return () => {
      active = false;
    };
  }, [store]);
  useEffect(() => {
    if (status?.phase !== 'working') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = backupStatusSchema.parse(
          await store.perform({ kind: 'backup-status' }),
        );
        if (!active) return;
        setStatus(next);
        if (next.phase !== 'working') return;
      } catch {
        if (active) setError(store.get().notice);
      }
      if (active)
        timer = setTimeout(() => {
          void refresh();
        }, 500);
    }
    timer = setTimeout(() => {
      void refresh();
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [store, status?.phase]);
  async function run(command: UICommand) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await store.perform(command);
      if (
        command.kind !== 'backup-review' &&
        command.kind !== 'execution-intent' &&
        command.kind !== 'select'
      )
        setStatus(backupStatusSchema.parse(result));
    } catch {
      setError(store.get().notice);
      try {
        setStatus(
          backupStatusSchema.parse(
            await store.perform({ kind: 'backup-status' }),
          ),
        );
      } catch {
        /* 保留原错误与当前资料。 */
      }
    } finally {
      setBusy(false);
    }
  }
  const requestId = (operation: 'create' | 'restore') =>
    ['uncertain', 'working'].includes(status?.phase ?? '') &&
    status?.operation === operation
      ? status.requestId!
      : crypto.randomUUID();
  const unresolved =
    status?.phase === 'uncertain' || status?.phase === 'working';
  return (
    <section className={styles.modelSettings}>
      <Heading slot="title">备份与恢复</Heading>
      <p>把已有任务、执行记录和必要证据保存在你选择的本机位置。</p>
      <h3>创建一份备份</h3>
      <p>{status?.location || '尚未选择保存位置'}</p>
      <div className={styles.settingsActions}>
        <button
          disabled={busy || unresolved}
          onClick={() => {
            void run({ kind: 'backup-location' });
          }}
        >
          选择本机位置
        </button>
        <button
          className={styles.primary}
          disabled={
            busy ||
            status?.phase === 'working' ||
            !status?.location ||
            (unresolved && status?.operation !== 'create')
          }
          onClick={() => {
            void run({ kind: 'backup-create', requestId: requestId('create') });
          }}
        >
          {status?.phase === 'uncertain' && status.operation === 'create'
            ? '核对原备份'
            : '创建本机备份'}
        </button>
      </div>
      <small>
        不包含模型密钥、认证头或网站登录。业务内容可能敏感，备份不承诺整包自动加密，也不会自动上传云端。
      </small>
      <hr />
      <h3>从备份恢复资料</h3>
      <button
        disabled={busy || unresolved}
        onClick={() => {
          void run({ kind: 'backup-open' });
        }}
      >
        选择并检查备份
      </button>
      {status?.selection && (
        <div>
          <p>{status.selection.archive.file}</p>
          <p>
            {new Date(status.selection.archive.created).toLocaleString('zh-CN')}{' '}
            · {status.selection.archive.tasks} 项任务 · 格式与完整性检查通过
          </p>
          <p>
            恢复前先暂停自动工作并保留当前资料。同一任务的当前记录和较新停止、目标及结果会保留，网站不会回退。
          </p>
          <button
            className={styles.primary}
            disabled={
              busy ||
              status.phase === 'working' ||
              (unresolved && status.operation !== 'restore')
            }
            onClick={() => {
              void run({
                kind: 'backup-restore',
                selection: status.selection!.token,
                requestId: requestId('restore'),
              });
            }}
          >
            {status.phase === 'uncertain' && status.operation === 'restore'
              ? '核对本次恢复'
              : '保留当前资料并恢复'}
          </button>
        </div>
      )}
      {busy && (
        <p role="status">正在处理，请保留窗口；任务停止仍可立即生效。</p>
      )}
      {status?.message && (
        <p className={styles.notice} role="status">
          {status.message}
        </p>
      )}
      {status?.archive && <small>已核验的文件：{status.archive.file}</small>}
      {status?.safety && (
        <small>恢复前当前资料副本：{status.safety.file}</small>
      )}
      {error && (
        <p className={styles.notice} role="alert">
          {error}
        </p>
      )}
      {state.tasks.some((t) => t.execution?.restoreReview) && (
        <>
          <hr />
          <h3>逐项核对与选择</h3>
          <p>
            核对只读取实际网页结果，不发送网页动作。新环境可能需要补模型设置和重新登录；补充后不会自动继续。
          </p>
          {state.tasks
            .filter((t) => t.execution?.restoreReview)
            .map((task) => (
              <article key={task.id} className={styles.backupTask}>
                <strong>{task.goal}</strong>
                <p>{task.execution?.summary}</p>
                <small>
                  {task.execution?.intent === 'stopped'
                    ? '原停止保持'
                    : '自动工作保持暂停'}
                </small>
                <div className={styles.settingsActions}>
                  <button
                    disabled={busy || unresolved}
                    onClick={() => {
                      void run({ kind: 'backup-review', taskId: task.id });
                    }}
                  >
                    核对实际结果
                  </button>
                  <button
                    disabled={
                      busy ||
                      unresolved ||
                      task.execution?.restoreReview !== 'ready'
                    }
                    onClick={() => {
                      void run({
                        kind: 'execution-intent',
                        requestId: crypto.randomUUID(),
                        taskId: task.id,
                        intent: 'continue',
                      });
                    }}
                  >
                    {task.execution?.restoreReview === 'complete'
                      ? '已核对完成'
                      : '选择继续本项'}
                  </button>
                  <button
                    onClick={() => {
                      void store
                        .perform({
                          kind: 'execution-intent',
                          requestId: crypto.randomUUID(),
                          taskId: task.id,
                          intent: 'stop',
                        })
                        .catch(() => {});
                    }}
                  >
                    停止本项
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void run({
                        kind: 'select',
                        requestId: crypto.randomUUID(),
                        taskId: task.id,
                      })
                        .then(() =>
                          store.perform({ kind: 'panel', panel: 'none' }),
                        )
                        .catch(() => {});
                    }}
                  >
                    返回任务网页
                  </button>
                </div>
              </article>
            ))}
        </>
      )}
      <p>
        恢复业务资料与更换应用版本是两件事；应用降级不代表资料可以安全回退。流程、素材和计划随对应功能扩充备份范围。
      </p>
    </section>
  );
}
