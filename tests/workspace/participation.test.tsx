// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import { WorkspaceStore } from '../../app/renderer/store';
import { App } from '../../app/renderer/App';
import type {
  WorkspaceBridge,
  WorkspaceEvent,
} from '../../app/shared/contracts';

afterEach(cleanup);
test('B 保持选中，A 提问后冷重开，从全局待办回答，只有 A 消费一次答复', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-participation-'));
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  const url = 'https://example.test/articles';
  const a = records.execute({
    kind: 'create',
    requestId: 'team',
    goal: '发布团队简报 ' + url,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: 'ready',
    taskId: a,
    url,
    phase: 'manual',
  });
  const b = records.execute({
    kind: 'create',
    requestId: 'docs',
    goal: '资料核对',
  }).taskId;
  const listeners = new Set<(e: WorkspaceEvent) => void>();
  let state = records.snapshot();
  const replies: string[] = [];
  const question = '简报要发到哪个栏目？';
  const service = new ExecutionService({
    current: () => state,
    publish: (next) => {
      state = next;
      listeners.forEach((l) => l({ state }));
    },
    records: (c) => Promise.resolve(records.execution(c)),
    stopModels: () => {},
    revoke: () => {},
    observe: () =>
      Promise.resolve({
        binding: { targetId: 'page-A', generation: 1 },
        observation: {
          url,
          title: '简报',
          text: '团队简报',
          fingerprint: 'same',
          truncated: false,
          generation: 1,
          observedAt: 1,
        },
      }),
    propose: ({ taskId, clarifications }) => {
      expect(taskId).toBe(a);
      const answer = clarifications?.at(-1);
      if (answer) {
        expect(answer.question).toBe(question);
        replies.push(answer.answer);
      }
      return Promise.resolve({
        decision: answer ? 'complete' : 'ask',
        summary: answer ? '完成核对' : question,
        evidence: ['团队简报'],
        previous: null,
        action: null,
      });
    },
    perform: () => Promise.reject(Error('UNEXPECTED_ACTION')),
  });
  const bridge: WorkspaceBridge = {
    async request(c) {
      if (c.kind === 'snapshot') return state;
      if (c.kind === 'participation-reply') return service.reply(c);
      if (c.kind === 'panel' || c.kind === 'participation-draft') return;
      throw Error('UNEXPECTED_COMMAND');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const store = new WorkspaceStore(bridge, state);
  try {
    const start = {
      kind: 'execution-intent' as const,
      taskId: a,
      requestId: 'start',
      intent: 'start' as const,
    };
    await service.intent(start);
    await service.settled();
    const q = state.tasks.find((t) => t.id === a)?.execution?.question;
    expect(q?.text).toBe(question);
    const reply = {
      kind: 'participation-reply' as const,
      taskId: a,
      questionId: q!.id,
      text: '公告',
    };
    await expect(service.reply({ ...reply, taskId: b })).rejects.toThrow(
      'PARTICIPATION_EXPIRED',
    );
    await expect(
      service.intent({ ...start, intent: 'continue', requestId: 'continue' }),
    ).rejects.toThrow('PARTICIPATION_REQUIRED');
    records.close();
    records = new WorkspaceRecords(folder, 'app/records/migrations');
    await service.recordsRestored(records.snapshot());
    listeners.forEach((l) =>
      l({ panel: { kind: 'panel', panel: 'participation' } }),
    );
    render(<App surface="panel" store={store} />);
    fireEvent.change(screen.getByRole('textbox', { name: question }), {
      target: { value: '公告' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回复' }));
    await waitFor(() =>
      expect(state.tasks.find((t) => t.id === a)?.execution?.phase).toBe(
        'complete',
      ),
    );
    await service.reply(reply);
    await service.settled();
    await expect(service.reply({ ...reply, text: '新闻' })).rejects.toThrow(
      'REQUEST_CONTENT_CONFLICT',
    );
    expect(replies).toEqual(['公告']);
    const saved = records.snapshot();
    expect(saved.active).toBe(b);
    expect(
      saved.tasks
        .find((t) => t.id === a)
        ?.messages.filter((m) => m.text === '公告'),
    ).toHaveLength(1);
    expect(
      saved.tasks
        .find((t) => t.id === b)
        ?.messages.some((m) => [question, '公告'].includes(m.text)),
    ).toBe(false);
    await service.intent({
      ...start,
      intent: 'revise',
      text: '整理新简报',
      requestId: 'revise',
    });
    await service.settled();
    const latest = state.tasks.find((t) => t.id === a)?.execution?.question;
    expect(latest?.id).toBeTruthy();
    await service.intent({ ...start, intent: 'stop', requestId: 'stop' });
    await expect(
      service.reply({ ...reply, questionId: latest!.id }),
    ).rejects.toThrow('PARTICIPATION_EXPIRED');
    expect(
      records.snapshot().tasks.find((t) => t.id === a)?.execution?.phase,
    ).toBe('stopped');
  } finally {
    cleanup();
    store.dispose();
    service.disable();
    await service.settled();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('独立待办改稿后只接受新预览；重开后同一确认仍只准提交一次', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-review-'));
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  const url = 'https://example.test/news';
  const taskId = records.execute({
    kind: 'create',
    requestId: 'a',
    goal: '发布简报 ' + url,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: 'page',
    taskId,
    url,
    phase: 'manual',
  });
  const b = records.execute({
    kind: 'create',
    requestId: 'b',
    goal: '核对资料',
  }).taskId;
  const execute = (c: object) => records.execution({ taskId, ...c });
  const owner = () => records.snapshot().tasks.find((t) => t.id === taskId)!;
  const runId = 'first',
    questionId = crypto.randomUUID();
  execute({ kind: 'intent', intent: 'start', requestId: 'start' });
  execute({ kind: 'claim', runId });
  const publication = { destination: '内部公告', content: '初稿' };
  execute({
    kind: 'ask',
    runId,
    questionId,
    url,
    type: 'review',
    publication,
    text: '请确认发布。',
  });
  const store = new WorkspaceStore(
    {
      subscribe: () => () => {},
      request(c) {
        if (c.kind === 'snapshot') return Promise.resolve(records.snapshot());
        if (c.kind === 'participation-decision')
          return Promise.resolve(execute(c));
        if (c.kind === 'dismiss-notice' || c.kind === 'participation-draft')
          return Promise.resolve();
        throw Error('UNEXPECTED_COMMAND');
      },
    },
    records.snapshot(),
  );
  try {
    render(<App surface="inbox" store={store} />);
    expect(screen.getByText('初稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改这段文字' }));
    const content = '三份资料已核对。';
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: content },
    });
    fireEvent.click(screen.getByRole('button', { name: '查看修改后的预览' }));
    await screen.findByText(/第 2 版/);
    const edited = owner().execution!.question!.id;
    const approve = {
      kind: 'participation-decision',
      operation: 'approve',
      questionId: edited,
    };
    expect(() => execute({ ...approve, questionId })).toThrow(
      'REQUEST_CONTENT_CONFLICT',
    );
    expect(() => execute({ ...approve, taskId: b })).toThrow(
      'PARTICIPATION_EXPIRED',
    );
    expect(owner().execution!.publication!.approvalId).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认发布这一版' }));
    await screen.findByText('当前没有需要回复的问题。');
    records.close();
    records = new WorkspaceRecords(folder, 'app/records/migrations');
    execute(approve);
    expect(records.snapshot().active).toBe(b);
    expect(
      owner().messages.filter((m) => m.text.startsWith('确认发布')),
    ).toHaveLength(1);
    expect(owner().execution!.publication).toMatchObject({
      content,
      revision: 2,
      approvalId: edited,
    });
    execute({ kind: 'recover', expectedVersion: owner().execution!.version });
    execute({ kind: 'claim', runId: 'new' });
    const source = {
      url,
      title: '内部公告',
      text: '内部公告 ' + content,
      fingerprint: 'page',
      truncated: false,
      generation: 1,
      observedAt: 1,
    };
    const click = {
      kind: 'reserve',
      id: 'publish',
      runId: 'new',
      summary: '发布',
      approvalId: edited,
      publication: { ...publication, content },
      binding: { targetId: 'A', generation: 1 },
      source,
      action: { kind: 'click', target: { role: 'button', name: '发布' } },
    };
    expect(() => execute({ ...click, publication })).toThrow(
      'PARTICIPATION_REQUIRED',
    );
    expect(() =>
      execute({ ...click, source: { ...source, text: '内部公告 初稿' } }),
    ).toThrow('EXECUTION_EVIDENCE_MISSING');
    expect(() =>
      execute({ ...click, source: { ...source, text: '其它栏目 ' + content } }),
    ).toThrow('EXECUTION_EVIDENCE_MISSING');
    execute(click);
    execute({ kind: 'dispatch', runId: 'new', id: 'publish' });
    execute({
      kind: 'resolve',
      runId: 'new',
      id: 'publish',
      source: { ...source, text: '发布成功' },
      evidence: ['发布成功'],
    });
    expect(() => execute({ ...click, id: 'again' })).toThrow(
      'PARTICIPATION_REQUIRED',
    );
  } finally {
    cleanup();
    store.dispose();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('登录待办只打开所属网页；之后的新停止使旧核对按钮失效', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-login-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const url = 'https://example.test/account';
  const taskId = records.execute({
    kind: 'create',
    requestId: 'a',
    goal: '核对账号 ' + url,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: 'page',
    taskId,
    url,
    phase: 'manual',
  });
  const execute = (c: object) => records.execution({ taskId, ...c });
  const questionId = crypto.randomUUID();
  execute({ kind: 'intent', intent: 'start', requestId: 'start' });
  execute({ kind: 'claim', runId: 'first' });
  execute({
    kind: 'ask',
    runId: 'first',
    questionId,
    url,
    type: 'login',
    text: '请到所属网站登录。',
  });
  const opened: string[] = [];
  const store = new WorkspaceStore(
    {
      subscribe: () => () => {},
      request(c) {
        if (c.kind === 'snapshot') return Promise.resolve(records.snapshot());
        if (c.kind === 'participation-open' && c.questionId === questionId) {
          opened.push(c.taskId);
          return Promise.resolve();
        }
        return Promise.reject(Error('UNEXPECTED_COMMAND'));
      },
    },
    records.snapshot(),
  );
  try {
    render(<App surface="inbox" store={store} />);
    expect(
      screen.queryByRole('button', { name: '已登录，核对后继续' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去所属网页登录' }));
    await waitFor(() => expect(opened).toEqual([taskId]));
    const execution = () =>
      records.snapshot().tasks.find((t) => t.id === taskId)!.execution!;
    expect(execution().question?.id).toBe(questionId);
    execute({ kind: 'intent', intent: 'stop', requestId: 'stop' });
    expect(() =>
      execute({
        kind: 'intent',
        intent: 'continue',
        requestId: 'login:' + questionId,
        loginQuestionId: questionId,
      }),
    ).toThrow('PARTICIPATION_EXPIRED');
    expect(execution().phase).toBe('stopped');
    expect(execution().loginOrigin).toBe(new URL(url).origin);
  } finally {
    cleanup();
    store.dispose();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
