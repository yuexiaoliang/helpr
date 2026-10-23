import { useEffect, useSyncExternalStore } from 'react';
import { Heading } from 'react-aria-components';
import { versionLabels } from '../shared/version';
import { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function VersionSettings({ store }: { store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const status = view.version;
  useEffect(() => {
    void store.perform({ kind: 'version-status' }).catch(() => {});
  }, [store]);
  const result = status?.result,
    release = result?.release;
  const checking = status?.phase === 'checking';
  const available = !checking && result?.kind === 'available' && release;
  const send = (command: Parameters<WorkspaceStore['perform']>[0]) => {
    void store.perform(command).catch(() => {});
  };
  return (
    <section className={styles.modelSettings}>
      <Heading slot="title">关于与新版</Heading>
      <p>运行时自动检查适用新版，发现后提醒。下载与安装由你手动完成。</p>
      {status ? (
        <>
          <h3>当前版本 {status.current.version}</h3>
          <p>
            macOS {status.current.osVersion} ·{' '}
            {status.current.arch === 'arm64'
              ? 'Apple Silicon'
              : status.current.arch}{' '}
            · 本机自用
          </p>
          <div className={styles.settingsActions}>
            <button
              disabled={checking}
              onClick={() => send({ kind: 'version-check' })}
            >
              {checking ? '检查中…' : '检查新版'}
            </button>
          </div>
          <div className={styles.versionResult} role="status">
            <strong>
              {checking
                ? '正在检查新版…'
                : result
                  ? versionLabels[result.kind].title
                  : '尚未检查新版'}
            </strong>
            <p>
              {checking
                ? '正在读取可信来源的版本信息。可以关闭弹窗返回任务，检查在后台完成。'
                : result
                  ? versionLabels[result.kind].detail
                  : '可以手动检查，自动检查将在后台进行。'}
            </p>
          </div>
          {status.checkedAt && !checking && (
            <small>
              最近完成：{new Date(status.checkedAt).toLocaleString('zh-CN')}
            </small>
          )}
          {status.lastSuccess &&
            !['available', 'latest', 'older'].includes(result?.kind ?? '') && (
              <p>
                上次成功检查：{status.lastSuccess.version}
                。这是历史结果，本次未确认可用入口。
              </p>
            )}
          <p>
            启动后后台检查，持续运行每24小时再查。失败不立即循环重试，也可以主动再查。
          </p>
          {available && (
            <>
              <hr />
              <h3>helpr {release.version} · 可手动下载</h3>
              <ul>
                {release.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
              <p>
                Apple Silicon · 最低 macOS {release.minOS}
                <br />
                支持当前资料格式与任务状态接续。
              </p>
              <p className={styles.versionURL}>
                下载入口：{release.downloadURL}
              </p>
              <button
                className={styles.primary}
                onClick={() =>
                  send({ kind: 'version-open', revision: status.revision })
                }
              >
                打开手动下载页 ↗
              </button>
              <p>
                仅在浏览器打开可信入口，不自动下载、暂停任务或准备退出。安装前须先保存现场和备份；升级准备由后续功能提供。
              </p>
            </>
          )}
          {status.openFailed && (
            <p role="alert">未能打开下载页。任务保留，可以再次点击打开。</p>
          )}
          <hr />
          <details>
            <summary>检查发送什么信息？</summary>
            <p>
              只读取版本渠道文件，不发送任务、素材、网站登录、模型地址或凭据。版本和兼容性在本机比较。
            </p>
            <p>
              当前资料格式 {status.current.dataFormat} · 任务状态版本{' '}
              {status.current.stateModel}
            </p>
            <p className={styles.versionURL}>版本来源：{status.source}</p>
          </details>
        </>
      ) : (
        <p role="status">正在读取新版检查状态…</p>
      )}
    </section>
  );
}
