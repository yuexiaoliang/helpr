import { useState, useRef, type FormEvent } from 'react';
import { Heading } from 'react-aria-components';
import type { ModelSettings as Configuration } from '../shared/model';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';

export function ModelSettings({
  store,
  saved,
}: {
  store: WorkspaceStore;
  saved: Configuration | null | undefined;
}) {
  const [endpoint, setEndpoint] = useState(saved?.endpoint ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const version = useRef(saved?.version ?? 0);
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const draft = () => ({
    protocol: 'chat-completions' as const,
    endpoint,
    model,
    ...(key ? { apiKey: key } : {}),
    expectedVersion: version.current,
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult('');
    const signature = JSON.stringify(draft());
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      await store.perform({
        kind: 'model-save',
        requestId: pending.current.id,
        ...draft(),
      });
      version.current =
        store.get().state.modelSettings?.version ?? version.current;
      setKey('');
      pending.current = null;
      setResult('配置已保存。下一次请求使用新配置，进行中的回复仍使用原配置。');
    } catch {
      setResult(store.get().notice);
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    if (busy) return;
    setBusy(true);
    setResult('正在检查服务地址…');
    try {
      const value = await store.perform({ kind: 'model-test', ...draft() });
      if (
        typeof value === 'object' &&
        value &&
        'message' in value &&
        typeof value.message === 'string'
      )
        setResult(value.message);
    } catch {
      setResult(store.get().notice);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.modelSettings}
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <Heading slot="title">模型设置</Heading>
      <p>
        配置一次，供各项任务使用。提问时会把该任务的页面观察与相关对话发给你配置的服务。
      </p>
      <label>
        服务协议
        <select disabled={busy} value="chat-completions" onChange={() => {}}>
          <option value="chat-completions">
            OpenAI 兼容 · Chat Completions
          </option>
        </select>
      </label>
      <label>
        服务地址
        <input
          required
          type="url"
          disabled={busy}
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <label>
        模型名称
        <input
          required
          maxLength={200}
          disabled={busy}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="填写服务提供的模型名称"
        />
      </label>
      <label>
        API 密钥
        <input
          required={!saved}
          type="password"
          autoComplete="off"
          maxLength={4096}
          disabled={busy}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={saved ? '已受保护保存，留空沿用' : '仅在本机受保护保存'}
        />
      </label>
      <small>
        密钥不返回对话、普通日志或任务导出；暂时无法访问时会保留数据并停止依赖请求。
      </small>
      {result && (
        <p className={styles.notice} role="status">
          {result}
        </p>
      )}
      <div className={styles.settingsActions}>
        <button
          type="button"
          disabled={
            busy || !endpoint.trim() || !model.trim() || (!saved && !key)
          }
          onClick={() => {
            void test();
          }}
        >
          检查连接
        </button>
        <button className={styles.primary} disabled={busy}>
          {busy ? '处理中…' : '保存并使用'}
        </button>
      </div>
      <p className={styles.modelLimits}>
        每项任务最多 20 次发送，最多两项同时请求，每次最多 2048 个输出
        token。取消或缺失服务用量时保留未知消耗，不自动重试。
      </p>
    </form>
  );
}
