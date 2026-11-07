import { useState } from 'react';
import {
  cleanupPreviewSchema,
  cleanupReceiptSchema,
  type CleanupPreview,
} from '../shared/cleanup';
import type { WorkspaceSnapshot } from '../shared/contracts';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function CleanupSettings({
  store,
  state,
}: {
  store: WorkspaceStore;
  state: WorkspaceSnapshot;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [request, setRequest] = useState<{
    taskIds: string[];
    token: string;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function run(commit: boolean, saved?: NonNullable<typeof request>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      if (!commit) {
        const next = cleanupPreviewSchema.parse(
          await store.perform({ kind: 'cleanup-preview', taskIds: selected }),
        );
        setPreview(next);
        setRequest(null);
      } else if (preview || saved) {
        const command = saved ??
          request ?? {
            taskIds: selected,
            token: preview!.token,
            requestId: crypto.randomUUID(),
          };
        setRequest(command);
        const result = cleanupReceiptSchema
          .strip()
          .parse(await store.perform({ kind: 'cleanup-commit', ...command }));
        setMessage(
          result.phase === 'complete'
            ? '清理已完成。处理完成事实和结果证明仍保留，已处理素材不会变回未处理。'
            : '清理记录已保存，部分副本尚未释放。可核对并重试原清理；不会重新执行任务。',
        );
        if (result.phase === 'complete') {
          setPreview(null);
          setSelected([]);
          setRequest(null);
        }
      }
    } catch (error) {
      setMessage(store.get().notice);
      if (
        error instanceof Error &&
        [
          'CLEANUP_CHANGED',
          'CLEANUP_PROTECTED',
          'CLEANUP_BUSY',
          'CLEANUP_FILE_CHANGED',
          'INVALID_REQUEST',
        ].includes(error.message)
      ) {
        setRequest(null);
        setPreview(null);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="主动清理资料">
      <h3>主动清理资料</h3>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void store
            .perform({ kind: 'storage-recheck' })
            .then(() =>
              setMessage(
                '本机关键保存检查通过。原停止与暂停保持；请逐项核对后明确继续。',
              ),
            )
            .catch(() => setMessage(store.get().notice))
            .finally(() => setBusy(false));
        }}
      >
        重新检查本机保存
      </button>
      <p>
        默认保留全部历史。这里只释放已核对完成、没有其它引用的任务素材副本。清理后不能从原任务读取或再次上传该副本；会话、素材完成事实、发布与选择证明、流程、计划和已有备份继续保留。网站登录与缓存不在清理范围内。
      </p>
      {state.tasks.map((task) => (
        <label className={styles.backupTask} key={task.id}>
          <input
            type="checkbox"
            checked={selected.includes(task.id)}
            disabled={busy || !!request}
            onChange={(event) => {
              setPreview(null);
              setSelected(
                event.target.checked
                  ? [...selected, task.id]
                  : selected.filter((id) => id !== task.id),
              );
            }}
          />
          {task.goal}
          {task.execution?.historyCleanup ? '（素材副本已清理）' : ''}
        </label>
      ))}
      <button
        disabled={busy || !selected.length || !!request}
        onClick={() => {
          void run(false);
        }}
      >
        查看清理影响
      </button>
      {preview && (
        <div>
          <p>
            预计释放 {preview.bytes} 字节，涉及 {preview.files.length}{' '}
            份素材副本。
          </p>
          {preview.tasks.map((task) => (
            <p key={task.taskId}>
              {state.tasks.find((t) => t.id === task.taskId)?.goal}：
              {task.reason}
            </p>
          ))}
          <p>
            确认后无法通过撤销取回副本；备份恢复也会保留较新的清理决定。需要再次发布时，请另建任务并重新指定来源。
          </p>
          <button
            disabled={
              busy ||
              preview.tasks.some((t) => !t.eligible) ||
              !preview.files.length
            }
            onClick={() => {
              void run(true);
            }}
          >
            {request ? '核对并重试原清理' : '确认清理所选副本'}
          </button>
        </div>
      )}
      {[
        ...new Set(
          state.tasks.flatMap((t) =>
            t.execution?.historyCleanup
              ? [t.execution.historyCleanup.requestId]
              : [],
          ),
        ),
      ].map((id) => {
        const tasks = state.tasks.filter(
          (t) => t.execution?.historyCleanup?.requestId === id,
        );
        return (
          <button
            key={id}
            disabled={busy}
            onClick={() => {
              void run(true, {
                taskIds: tasks.map((t) => t.id),
                requestId: id,
                token: tasks[0]!.execution!.historyCleanup!.token,
              });
            }}
          >
            核对上次清理：{tasks.map((t) => t.goal).join('、')}
          </button>
        );
      })}
      <p role="status">{message}</p>
    </section>
  );
}
