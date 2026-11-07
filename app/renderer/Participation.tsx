import { ScheduledPlan } from './ScheduledPlan';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { Task, UICommand } from '../shared/contracts';
import type { WorkspaceStore } from './store';
import styles from './Workspace.module.css';
import { ArticleSources } from './ArticleSources';

type Props = {
  task: Task;
  store: WorkspaceStore;
  onAccepted?: () => void;
  inTask?: boolean;
};

export function ParticipationForm({
  task,
  store,
  onAccepted,
  inTask = false,
}: Props) {
  const question = task.execution?.question;
  const preview = task.execution?.publication;
  const view = useSyncExternalStore(store.subscribe, store.get);
  const draft = question ? view.replyDrafts[question.id] : undefined;
  const answer = draft ?? '';
  const editing = question?.type === 'review' && draft !== undefined;
  const setAnswer = (value: string) => {
    if (question) store.saveReplyDraft(task.id, question.id, value);
  };
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [changingGoal, setChangingGoal] = useState(false);
  const [goal, setGoal] = useState(task.execution?.goal ?? task.goal);
  const composing = useRef(false);
  if (!question) return null;
  const control = task.executionControl;
  const login = question.type === 'login';
  const review = question.type === 'review';
  const blocked =
    control?.system ||
    (control?.blocked &&
      !(
        login &&
        control.stopSaved &&
        ['takeover', 'page-change'].includes(control.reason ?? '')
      ));
  const ids = { taskId: task.id, questionId: question.id };
  async function submit(command: UICommand) {
    if (sending || composing.current) return;
    setSending(true);
    setError('');
    try {
      await store.perform(command);
      if (command.kind !== 'participation-open') onAccepted?.();
    } catch {
      setError(store.get().notice || '未能保存，请重试。');
    } finally {
      setSending(false);
    }
  }
  const openTask = () => void submit({ kind: 'participation-open', ...ids });
  return (
    <form
      className={styles.replyForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || composing.current) return;
        if (login) {
          if (inTask)
            void submit({
              kind: 'participation-decision',
              ...ids,
              operation: 'login-check',
            });
          return;
        }
        if (review) {
          if (changingGoal) {
            if (goal.trim())
              void submit({
                kind: 'execution-intent',
                taskId: task.id,
                requestId: crypto.randomUUID(),
                intent: 'revise',
                text: goal,
              });
            return;
          }
          if (editing && !answer.trim()) return;
          void submit(
            editing
              ? {
                  kind: 'participation-decision',
                  ...ids,
                  operation: 'edit',
                  content: answer,
                }
              : {
                  kind: 'participation-decision',
                  ...ids,
                  operation: 'approve',
                },
          );
          return;
        }
        if (answer.trim())
          void submit({ kind: 'participation-reply', ...ids, text: answer });
      }}
    >
      {review && preview && (
        <>
          <strong>
            {preview.origin} · {preview.destination} · 第 {preview.revision} 版
          </strong>
          <p className={styles.previewContent}>{preview.content}</p>
          {task.execution && <ArticleSources execution={task.execution} />}
          {preview.attachment && (
            <p>
              本次附件：
              {
                task.execution?.materials?.find(
                  (m) => m.id === preview.attachment!.materialId,
                )?.name
              }
              <br />
              编辑目标：{preview.attachment.targetUrl}
              <br />
              附件位置：{preview.attachment.url}
            </p>
          )}
        </>
      )}
      {login && (
        <p>
          {question.text} {task.execution?.loginOrigin}
          {task.execution?.coordination?.account && (
            <>
              {' '}
              原账号：{task.execution.coordination.account.name}
              。恢复后会分别核对相关任务；已停止或已接管的任务仍需明确继续。
            </>
          )}
        </p>
      )}
      {(!question.type || editing) && (
        <label>
          {editing ? '修改本次发布的完整文字' : question.text}
          <textarea
            rows={editing ? 4 : 2}
            maxLength={4000}
            value={answer}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </label>
      )}
      {review && changingGoal && (
        <label>
          修改本次目标与处理要求
          <textarea
            value={goal}
            maxLength={20000}
            rows={4}
            onChange={(event) => setGoal(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {(!login || inTask) && (
        <button
          type="submit"
          className={styles.primary}
          disabled={
            sending ||
            blocked ||
            ((!question.type || editing) && !answer.trim()) ||
            (changingGoal && !goal.trim())
          }
        >
          {sending
            ? '正在保存…'
            : login
              ? '已登录，核对后继续'
              : review
                ? changingGoal
                  ? '按新要求重新准备'
                  : editing
                    ? '查看修改后的预览'
                    : '确认发布这一版'
                : '提交回复'}
        </button>
      )}
      {review && !editing && !changingGoal && (
        <button
          type="button"
          disabled={sending || blocked}
          onClick={() => {
            setAnswer(preview?.content ?? '');
          }}
        >
          修改这段文字
        </button>
      )}
      {review && !editing && (
        <button
          type="button"
          disabled={sending || blocked}
          onClick={() => setChangingGoal(!changingGoal)}
        >
          {changingGoal ? '取消修改要求' : '修改目标或处理要求'}
        </button>
      )}
      {!inTask && (
        <button type="button" disabled={sending} onClick={openTask}>
          {login ? '去所属网页登录' : '查看所属网页'}
        </button>
      )}
    </form>
  );
}

export function ParticipationInbox({
  tasks,
  store,
  close,
}: {
  tasks: Task[];
  store: WorkspaceStore;
  close: () => void;
}) {
  const pending = tasks.filter((t) => t.execution?.question);
  const plans = tasks.filter((t) =>
    t.execution?.schedule?.rounds.some((r) => r.status === 'waiting'),
  );
  return (
    <section
      aria-label="待回复"
      className={styles.replyInbox}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) close();
      }}
    >
      <header>
        <strong>待回复</strong>
        <button type="button" aria-label="收起待回复" onClick={close}>
          ×
        </button>
      </header>
      {pending.length === 0 && plans.length === 0 && (
        <p role="status">当前没有需要回复的问题。</p>
      )}
      {plans.map((task) => (
        <ScheduledPlan key={task.id} task={task} store={store} pendingOnly />
      ))}
      {pending.map((task) => (
        <div key={task.execution!.question!.id}>
          <strong>{task.goal}</strong>
          <ParticipationForm
            task={task}
            store={store}
            onAccepted={() => {
              if (!store.get().state.tasks.some((t) => t.execution?.question))
                close();
            }}
          />
        </div>
      ))}
    </section>
  );
}
