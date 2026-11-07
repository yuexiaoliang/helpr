// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ParticipationForm } from '../../app/renderer/Participation';
import { WorkspaceStore } from '../../app/renderer/store';
import { executionSchema } from '../../app/shared/execution';
import type { UICommand, WorkspaceSnapshot } from '../../app/shared/contracts';

afterEach(cleanup);
test('逐字段预览与改稿保留所属任务和原映射，组字期间不提交，也不自动批准', async () => {
  const execution = executionSchema.parse({
    intent: 'automatic',
    phase: 'paused',
    version: 1,
    intentId: 'intent',
    goalVersion: 1,
    goal: '发布多字段内容',
    runId: null,
    resource: null,
    summary: '请确认',
    actions: [],
    question: {
      id: randomUUID(),
      type: 'review',
      goalVersion: 1,
      text: '请确认',
      url: 'https://example.test/edit',
    },
    publication: {
      content: '原标题\n\n原正文',
      fields: [
        { id: 'heading', name: '文章标题', value: '原标题' },
        { id: 'text', name: '文章正文', value: '原正文' },
      ],
      destination: '公告',
      origin: 'https://example.test',
      revision: 1,
      approvalId: null,
    },
  });
  const state: WorkspaceSnapshot = {
    revision: 1,
    active: 'A',
    tasks: [
      {
        id: 'A',
        goal: execution.goal,
        created: 1,
        url: 'https://example.test/edit',
        draft: '',
        hidden: false,
        minimized: false,
        phase: 'manual',
        error: '',
        version: 1,
        messages: [],
        execution,
      },
    ],
  };
  const commands: UICommand[] = [];
  const store = new WorkspaceStore(
    {
      subscribe: () => () => {},
      request: (c) => {
        if (c.kind === 'participation-decision') commands.push(c);
        return Promise.resolve(state);
      },
    },
    state,
  );
  render(<ParticipationForm task={state.tasks[0]!} store={store} inTask />);
  expect(screen.getByText('文章标题')).toBeTruthy();
  expect(screen.getByText('原正文')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '修改这段文字' }));
  const body = screen.getByRole('textbox', { name: '修改文章正文' });
  fireEvent.compositionStart(body);
  fireEvent.change(body, { target: { value: '修改后的正文' } });
  fireEvent.click(screen.getByRole('button', { name: '查看修改后的预览' }));
  expect(commands).toHaveLength(0);
  fireEvent.compositionEnd(body);
  fireEvent.click(screen.getByRole('button', { name: '查看修改后的预览' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toEqual({
    kind: 'participation-decision',
    taskId: 'A',
    questionId: execution.question!.id,
    operation: 'edit',
    content: '原标题\n\n修改后的正文',
    fields: [
      { id: 'heading', name: '文章标题', value: '原标题' },
      { id: 'text', name: '文章正文', value: '修改后的正文' },
    ],
  });
});
