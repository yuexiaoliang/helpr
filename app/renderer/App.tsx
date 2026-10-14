import {
  useSyncExternalStore,
  useState,
  useRef,
  useEffect,
  type FormEvent,
} from 'react';
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
} from 'react-aria-components';
import type { Task, UICommand } from '../shared/contracts';
import { WorkspaceStore } from './store';
import styles from './Workspace.module.css';
import plus from './assets/plus.svg';
import close from './assets/x.svg';
import tasksIcon from './assets/squares-four.svg';
import exit from './assets/sign-out.svg';
import globe from './assets/globe.svg';

const phaseLabel = (task: Task) =>
  ({
    'no-page': '等待打开网页',
    loading: '正在打开',
    manual: '可手动操作',
    error: '需要查看',
  })[task.phase];
function Icon({ src }: { src: string }) {
  return <img src={src} alt="" className={styles.icon} />;
}
const requestId = () => crypto.randomUUID();
export function App({
  store,
  surface,
  taskId,
}: {
  store: WorkspaceStore;
  surface: 'chrome' | 'chat' | 'panel' | 'toast';
  taskId?: string;
}) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const send = (command: UICommand) => {
    void store.perform(command).catch(() => {});
  };
  const task = view.state.tasks.find(
    (t) => t.id === (taskId ?? view.state.active),
  );
  if (surface === 'chat')
    return task ? <Chat key={task.id} store={store} task={task} /> : null;
  if (surface === 'panel') return <Panel store={store} />;
  if (surface === 'toast')
    return (
      <div className={styles.toast} role="status">
        {view.notice}
        <button
          aria-label="收起提示"
          onClick={() => send({ kind: 'dismiss-notice' })}
        >
          ×
        </button>
      </div>
    );
  return (
    <>
      <header className={styles.header}>
        <span className={styles.logo}>helpr</span>
        <nav className={styles.tabs} aria-label="任务标签页">
          {view.state.tasks
            .filter((t) => !t.hidden)
            .map((t) => (
              <TaskTab
                key={t.id}
                store={store}
                task={t}
                active={t.id === view.state.active}
              />
            ))}
        </nav>
        <button
          className={styles.iconButton}
          onClick={() => send({ kind: 'panel', panel: 'new' })}
          aria-label="新建任务"
        >
          <Icon src={plus} />
        </button>
        <div className={styles.tools}>
          <button
            onClick={() => send({ kind: 'panel', panel: 'tasks' })}
            aria-label="查看全部任务"
          >
            <Icon src={tasksIcon} />
            <span>任务 {view.state.tasks.length}</span>
          </button>
          <button
            className={styles.iconButton}
            onClick={() => send({ kind: 'panel', panel: 'quit' })}
            aria-label="退出 helpr"
          >
            <Icon src={exit} />
          </button>
        </div>
      </header>
      {task && !task.hidden ? (
        <AddressBar key={task.id} task={task} store={store} />
      ) : (
        <div className={styles.empty}>
          <span>从一个目标开始</span>
          <h1>把网页工作交给 helpr</h1>
          <p>先创建任务，打开网站并手动使用。每项任务有自己的对话和记录。</p>
          <button
            className={styles.primary}
            onClick={() => send({ kind: 'panel', panel: 'new' })}
          >
            新建任务
          </button>
        </div>
      )}
      {task && !task.hidden && !task.url && (
        <div className={styles.noPage}>
          <Icon src={globe} />
          <h2>目标已保存</h2>
          <p>AI 网站识别尚未接入。你可以在上方地址栏打开目标网站。</p>
        </div>
      )}
    </>
  );
}
function TaskTab({
  store,
  task,
  active,
}: {
  store: WorkspaceStore;
  task: Task;
  active: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tab = useRef<HTMLDivElement>(null);
  const keyboardPreview = useRef(false);
  const send = (command: UICommand) => {
    void store.perform(command).catch(() => {});
  };
  const preview = (focus = false) =>
    send({
      kind: 'panel',
      panel: 'preview',
      focus,
      taskId: task.id,
      x: button.current?.getBoundingClientRect().left ?? 100,
    });
  useEffect(() => {
    const reveal = () => {
      if (active)
        tab.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    reveal();
    window.addEventListener('resize', reveal);
    const unsubscribe = store.subscribe(() => {
      if (
        keyboardPreview.current &&
        store.get().panel.panel === 'none' &&
        store.get().saving === 0
      ) {
        keyboardPreview.current = false;
        button.current?.focus();
      }
    });
    return () => {
      window.removeEventListener('resize', reveal);
      unsubscribe();
    };
  }, [active, store]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div
      ref={tab}
      className={`${styles.tab} ${active ? styles.selected : ''}`}
      onMouseEnter={() => {
        timer.current = setTimeout(() => preview(), 280);
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        send({ kind: 'panel', panel: 'none', delayed: true });
      }}
    >
      <Icon src={globe} />
      <button
        ref={button}
        className={styles.selectTask}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          send({ kind: 'panel', panel: 'none' });
          send({ kind: 'select', requestId: requestId(), taskId: task.id });
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            preview(true);
            keyboardPreview.current = true;
          }
          if (event.key === 'Escape') send({ kind: 'panel', panel: 'none' });
        }}
      >
        <span className={styles.taskName} title={task.goal}>
          {task.goal}
        </span>
        <span className={styles.status}>
          <i />
          {phaseLabel(task)}
        </span>
      </button>
      <button
        className={styles.closeTab}
        aria-label={`收起任务 ${task.goal}`}
        onClick={() =>
          send({ kind: 'panel', panel: 'close-task', taskId: task.id })
        }
      >
        <Icon src={close} />
      </button>
    </div>
  );
}
function AddressBar({ task, store }: { task: Task; store: WorkspaceStore }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current && document.activeElement !== input.current)
      input.current.value = task.url;
  }, [task.url]);
  const open = (event: FormEvent) => {
    event.preventDefault();
    void store
      .perform({
        kind: 'navigate',
        requestId: requestId(),
        taskId: task.id,
        url: input.current?.value ?? '',
      })
      .catch(() => {});
  };
  return (
    <form className={styles.address} onSubmit={open}>
      <button
        type="button"
        aria-label="重新打开网页"
        onClick={() => {
          void store
            .perform({ kind: 'reload', taskId: task.id })
            .catch(() => {});
        }}
      >
        ↻
      </button>
      <Icon src={globe} />
      <input
        ref={input}
        defaultValue={task.url}
        aria-label="网站地址"
        placeholder="输入网站地址"
      />
      <button>打开</button>
      <span>手动工作区</span>
    </form>
  );
}
function Chat({ task, store }: { task: Task; store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const [text, setText] = useState(task.draft);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const composing = useRef(false);
  const pending = useRef<{ text: string; id: string } | null>(null);
  const saveDraft = (value: string) => {
    void store
      .perform({
        kind: 'draft',
        taskId: task.id,
        requestId: requestId(),
        text: value,
      })
      .then(() => setFailed(false))
      .catch(() => setFailed(true));
  };
  async function sendMessage() {
    if (!text.trim() || busy || composing.current) return;
    setBusy(true);
    const value = text;
    const id =
      pending.current?.text === value ? pending.current.id : requestId();
    pending.current = { text: value, id };
    try {
      await store.perform({
        kind: 'message',
        taskId: task.id,
        requestId: id,
        text: value,
      });
      setText((current) => (current === value ? '' : current));
      pending.current = null;
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.chat}
      aria-label={`任务 ${task.goal} 的独立对话`}
    >
      <header>
        <span className={styles.avatar}>{task.goal.slice(0, 1)}</span>
        <div>
          <strong title={task.goal}>{task.goal}</strong>
          <small>独立对话 · {phaseLabel(task)}</small>
        </div>
        <button
          aria-label={task.minimized ? '展开对话' : '收起对话'}
          onClick={() => {
            void store
              .perform({
                kind: 'minimize',
                requestId: requestId(),
                taskId: task.id,
              })
              .catch(() => {});
          }}
        >
          {task.minimized ? '+' : '−'}
        </button>
      </header>
      {!task.minimized && (
        <>
          <div className={styles.feed} aria-label="对话记录">
            {task.messages.map((message, i) => (
              <div
                key={i}
                className={
                  message.role === 'user'
                    ? styles.userMessage
                    : styles.systemMessage
                }
              >
                {message.text}
              </div>
            ))}
          </div>
          {view.notice && (
            <div className={styles.notice} role="status">
              {view.notice}
            </div>
          )}
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              aria-label="给这项任务的要求"
              placeholder="给这项任务补充要求…"
              value={text}
              maxLength={20000}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                saveDraft(event.currentTarget.value);
              }}
              onChange={(event) => {
                setText(event.target.value);
                if (!composing.current) saveDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <div>
              <small>
                {failed ? '尚未保存' : view.saving ? '保存中…' : '已保存'}
              </small>
              {failed && (
                <button type="button" onClick={() => saveDraft(text)}>
                  重试保存
                </button>
              )}
              <button
                className={styles.primary}
                disabled={busy || !text.trim()}
              >
                发送
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
function Panel({ store }: { store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const previewRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.panel.panel === 'preview' && view.panel.focus)
      previewRoot.current?.focus();
  }, [view.panel]);
  const closePanel = () => {
    if (view.saving) return;
    const cancel =
      view.panel.panel === 'new'
        ? store.perform({
            kind: 'cancel-create',
            requestId: store.getCreationId(),
          })
        : Promise.resolve();
    void cancel
      .then(() => {
        if (view.panel.panel === 'new') store.renewCreationId();
        return store.perform({ kind: 'panel', panel: 'none' });
      })
      .catch(() => {});
  };
  if (view.panel.panel === 'none') return null;
  if (view.panel.panel === 'preview') {
    const task = view.state.tasks.find((t) => t.id === view.panel.taskId);
    return task ? (
      <div
        ref={previewRoot}
        tabIndex={-1}
        role="dialog"
        aria-label="任务卡片"
        className={styles.preview}
        onMouseEnter={() => {
          void store.perform(view.panel).catch(() => {});
        }}
        onMouseLeave={closePanel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') closePanel();
        }}
      >
        <header>
          <Icon src={globe} />
          <h2>{task.goal}</h2>
          <button aria-label="收起任务卡片" onClick={closePanel}>
            ×
          </button>
        </header>
        <p className={styles.status}>
          <i />
          {phaseLabel(task)}
        </p>
        <p>{task.url ? new URL(task.url).hostname : '尚未打开网站'}</p>
        <div className={styles.latest}>
          <small>最近动态</small>
          <p>{task.messages.at(-1)?.text}</p>
        </div>
      </div>
    ) : null;
  }
  return (
    <ModalOverlay
      isOpen
      isDismissable={view.saving === 0}
      onOpenChange={(open) => {
        if (!open) closePanel();
      }}
      className={styles.backdrop}
    >
      <Modal className={styles.modal}>
        <Dialog
          aria-label={
            view.panel.panel === 'new'
              ? '新建任务'
              : view.panel.panel === 'tasks'
                ? '全部任务'
                : '退出 helpr'
          }
        >
          <button
            className={styles.dismiss}
            disabled={view.saving > 0}
            aria-label="关闭弹窗"
            onClick={closePanel}
          >
            ×
          </button>
          {view.panel.panel === 'new' ? (
            <NewTask store={store} close={closePanel} />
          ) : view.panel.panel === 'tasks' ? (
            <>
              <Heading slot="title">全部任务</Heading>
              <p>
                收起标签后，任务和对话仍保留。同一网站的登录会话在任务间共用。
              </p>
              {view.state.tasks.map((task) => (
                <button
                  key={task.id}
                  className={styles.taskRow}
                  onClick={() => {
                    void store
                      .perform({
                        kind: 'select',
                        requestId: requestId(),
                        taskId: task.id,
                      })
                      .then(closePanel)
                      .catch(() => {});
                  }}
                >
                  <span>{task.goal}</span>
                  <small>{phaseLabel(task)}</small>
                </button>
              ))}
            </>
          ) : view.panel.panel === 'close-task' ? (
            <>
              <Heading slot="title">收起这项任务？</Heading>
              <p>网页现场、对话与记录仍保留。需要时从顶部的全部任务中找回。</p>
              <div className={styles.actions}>
                <Button onPress={closePanel}>返回</Button>
                <Button
                  className={styles.primary}
                  onPress={() => {
                    if (view.panel.taskId)
                      void store
                        .perform({
                          kind: 'hide-task',
                          taskId: view.panel.taskId,
                          requestId: requestId(),
                        })
                        .then(closePanel)
                        .catch(() => {});
                  }}
                >
                  收起任务
                </Button>
              </div>
            </>
          ) : (
            <>
              <Heading slot="title">退出 helpr？</Heading>
              <p>任务与对话保存在本机。下次打开仍可找回这些记录。</p>
              <p className={styles.warning}>
                网站中尚未保存的编辑可能丢失。请先回网页保存；浏览器登录由网站会话决定是否仍然有效。
              </p>
              {view.notice && (
                <p role="status" className={styles.notice}>
                  {view.notice}
                </p>
              )}
              <div className={styles.actions}>
                <Button onPress={closePanel}>回到网页</Button>
                <Button
                  className={styles.primary}
                  isDisabled={view.saving > 0}
                  onPress={() => {
                    void store.perform({ kind: 'quit' }).catch(() => {});
                  }}
                >
                  放弃网页编辑并退出
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
function NewTask({
  store,
  close: onClose,
}: {
  store: WorkspaceStore;
  close: () => void;
}) {
  const [goal, setGoal] = useState(store.getNewGoal());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useRef(store.getCreationId());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await store.perform({ kind: 'create', requestId: id.current, goal });
      store.cacheNewGoal('');
      onClose();
    } catch {
      setError(
        store.get().notice ||
          '暂未确认保存结果，当前输入仍保留。请重试或取消后核对任务列表。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Heading slot="title">你想完成什么？</Heading>
      <p>描述目标即可。当前版本可以先保存委托、手动打开网站。</p>
      <label className={styles.goalLabel}>
        目标
        <textarea
          autoFocus
          disabled={busy}
          value={goal}
          onChange={(event) => {
            setGoal(event.target.value);
            store.cacheNewGoal(event.target.value);
          }}
          maxLength={600}
          placeholder="例如：把本周经营周报发布到公司网站"
        />
      </label>
      {error && (
        <p role="alert" className={styles.notice}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button isDisabled={busy} onPress={onClose}>
          取消
        </Button>
        <button className={styles.primary} disabled={busy || !goal.trim()}>
          {busy ? '正在保存…' : '创建任务'}
        </button>
      </div>
    </form>
  );
}
