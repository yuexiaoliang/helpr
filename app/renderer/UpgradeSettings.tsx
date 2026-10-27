import { useEffect, useState, useSyncExternalStore } from 'react';
import { WorkspaceStore } from './store';
import type { UICommand } from '../shared/contracts';
import styles from './Workspace.module.css';

export function UpgradeSettings({ store }: { store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const status = view.upgrade;
  const [requestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    void store.perform({ kind: 'upgrade-status' }).catch(() => {});
  }, [store]);
  useEffect(() => {
    if (!status?.working) return;
    const timer = setInterval(() => {
      void store.perform({ kind: 'upgrade-status' }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [store, status?.working]);
  const send = (c: UICommand) => {
    void store.perform(c).catch(() => {});
  };
  const version = view.version;
  const available =
    version?.phase === 'done' && version.result?.kind === 'available';
  if (!status)
    return (
      <section aria-label="手动升级">
        <h3>手动升级</h3>
        <p role="status">正在读取升级准备记录…</p>
      </section>
    );
  const preparing =
    !status.reopening &&
    ['preparing', 'ready', 'blocked'].includes(status.phase);
  return (
    <section aria-label="手动升级">
      <hr />
      <h3>手动升级 · 保存原来的工作</h3>
      <div className={styles.versionResult} role="status">
        <strong>
          {
            {
              idle: '方便时再准备升级',
              preparing: '正在保存与备份',
              ready: '已准备好，可以退出',
              checking: '先检查，再核对恢复',
              blocked: '仍有事项需要处理',
              complete: '启动基础检查已完成',
            }[status.phase]
          }
        </strong>
        <p>{status.message}</p>
      </div>
      <p>
        当前 {status.installedVersion ?? '待核对'}
        {status.target ? ` · 准备安装 ${status.target}` : ''}
      </p>
      {status.continuity === 'retained' && (
        <p>
          原受保护密钥和会话资料摘要保持。网站实际登录与操作结果仍由各任务核对。
        </p>
      )}
      {status.continuity === 'renewed' && (
        <p>原会话已到期，用户重新登录后继续核对；本次不记作原有效会话延续。</p>
      )}
      {status.dirtyTasks.map((taskId) => {
        const page = status.pages.find((p) => p.taskId === taskId);
        const name =
          view.state.tasks.find((t) => t.id === taskId)?.goal ?? taskId;
        return (
          <article className={styles.backupTask} key={taskId}>
            <strong>任务 {name} 的网页现场</strong>
            <p>先在该网页保存手动编辑。仅查看或切换任务不会替你确认已保存。</p>
            <div className={styles.settingsActions}>
              <button
                onClick={() => {
                  send({
                    kind: 'select',
                    taskId,
                    requestId: crypto.randomUUID(),
                  });
                  send({ kind: 'panel', panel: 'none' });
                }}
              >
                查看任务 {name}
              </button>
              <button
                disabled={status.working || !page}
                onClick={() => {
                  if (page)
                    send({
                      kind: 'upgrade-page-saved',
                      taskId,
                      generation: page.generation,
                      epoch: page.epoch,
                    });
                }}
              >
                我已在网页保存任务 {name}，核对现场
              </button>
            </div>
          </article>
        );
      })}
      {status.backup && (
        <p className={styles.versionURL}>
          升级前业务备份：{status.backup.file}
          <br />
          完整性已核对。备份不含模型密钥、服务配置和网站登录；原存储分别检查。
        </p>
      )}
      <div className={styles.settingsActions}>
        {available && !status.reopening && status.phase !== 'ready' && (
          <button
            className={styles.primary}
            disabled={status.working}
            onClick={() =>
              send({
                kind: 'upgrade-prepare',
                requestId: status.requestId ?? requestId,
                versionRevision: version.revision,
              })
            }
          >
            {preparing ? '重新准备升级' : '准备升级'}
          </button>
        )}
        {status.phase === 'ready' && (
          <button
            className={styles.primary}
            disabled={status.working}
            onClick={() =>
              send({ kind: 'upgrade-exit', revision: status.recordRevision })
            }
          >
            退出，准备手动安装
          </button>
        )}
        {preparing && (
          <button
            disabled={status.working}
            onClick={() => send({ kind: 'upgrade-cancel' })}
          >
            取消本次准备，核对后返回工作
          </button>
        )}
        {status.reopening && status.phase !== 'complete' && (
          <button
            className={styles.primary}
            disabled={status.working}
            onClick={() => send({ kind: 'upgrade-check' })}
          >
            {status.working
              ? '正在检查…'
              : status.error === 'UPGRADE_LOGIN_EXPIRED'
                ? '已完成网页登录，重新检查'
                : '检查原资料、凭据与网页控制'}
          </button>
        )}
        <button
          disabled={status.working}
          onClick={() => send({ kind: 'upgrade-status' })}
        >
          刷新现场状态
        </button>
      </div>
      <p>
        准备期间停止新的自动操作，保存与备份完成后由你退出，在 Finder
        中手动替换并重新打开。新版检查后，原自动任务先核对网站实际结果；停止、接管和待确认分别保留。
      </p>
      <p>
        资料、原密钥、有效登录或控制检查失败时保留现场。更换旧程序不代表数据和网站结果可以安全回退。
      </p>
    </section>
  );
}
