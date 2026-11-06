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
import type { WorkspaceSnapshot, UICommand } from '../../app/shared/contracts';
import { executionSchema } from '../../app/shared/execution';
import { ARTICLE_PROMPT_VERSION, EXCEL_PARSER } from '../../app/shared/article';

afterEach(cleanup);
test('所属任务预览展示原表位置、不确定公式及人工修改边界；改目标通过新委托保存', async () => {
  const articleId = randomUUID(),
    sourceId = randomUUID(),
    materialId = randomUUID();
  const execution = executionSchema.parse({
    intent: 'automatic',
    phase: 'paused',
    version: 1,
    intentId: 'intent',
    goalVersion: 1,
    goal: '读取表格发到公告',
    runId: null,
    resource: null,
    summary: '请确认',
    actions: [],
    question: {
      id: randomUUID(),
      type: 'review',
      goalVersion: 1,
      text: '请确认',
      url: 'https://example.com/edit',
    },
    publication: {
      articleId,
      content: '甲：7。',
      destination: '公告',
      origin: 'https://example.com',
      revision: 2,
      approvalId: null,
    },
    contentSources: [
      {
        id: sourceId,
        materialId,
        materialSha256: 'a'.repeat(64),
        goalVersion: 1,
        createdAt: 1,
        requirements: {
          id: randomUUID(),
          goal: '读取表格发到公告',
          answers: [],
        },
        sha256: 'b'.repeat(64),
        parser: EXCEL_PARSER,
        dateSystem: '1900',
        recalculated: false,
        notices: ['公式不重算，空白不是零。'],
        sheets: [
          {
            name: '数据',
            hidden: false,
            cells: [
              {
                address: 'B2',
                type: 'n',
                raw: 7,
                display: '7',
                format: '',
                formula: null,
                status: 'value',
                master: null,
              },
              {
                address: 'B4',
                type: 'n',
                raw: null,
                display: '公式结果未核对',
                format: '',
                formula: 'SUM(B2:B3)',
                status: 'formula-unverified',
                master: null,
              },
            ],
          },
        ],
      },
    ],
    articles: [
      {
        id: articleId,
        parentId: null,
        sourceId,
        goalVersion: 1,
        content: '甲：7。',
        destination: '公告',
        author: 'user',
        modelCallId: null,
        promptVersion: ARTICLE_PROMPT_VERSION,
        createdAt: 1,
        blocks: [
          {
            kind: 'fact',
            text: '甲：7。',
            citations: [{ sheet: '数据', address: 'B2', quote: '7' }],
          },
        ],
      },
    ],
  });
  const state: WorkspaceSnapshot = {
    revision: 1,
    active: 'A',
    tasks: [
      {
        id: 'A',
        goal: execution.goal,
        created: 1,
        url: 'https://example.com/edit',
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
      request: (command) => {
        commands.push(command);
        return Promise.resolve(state);
      },
    },
    state,
  );
  render(<ParticipationForm task={state.tasks[0]!} store={store} inTask />);
  fireEvent.click(screen.getByText('查看表格来源与不确定项'));
  expect(screen.getByText(/数据!B2：7/)).toBeTruthy();
  expect(screen.getByText(/新增或改写的文字未自动取得表格来源/)).toBeTruthy();
  expect(screen.getByText('公式未重算')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '修改目标或处理要求' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: '修改本次目标与处理要求' }),
    { target: { value: '保留表格来源，改发到通知栏目' } },
  );
  fireEvent.click(screen.getByRole('button', { name: '按新要求重新准备' }));
  await waitFor(() =>
    expect(
      commands.some(
        (c) =>
          c.kind === 'execution-intent' &&
          c.intent === 'revise' &&
          c.taskId === 'A' &&
          c.text === '保留表格来源，改发到通知栏目',
      ),
    ).toBe(true),
  );
  expect(
    commands.some(
      (c) => c.kind === 'participation-decision' && c.operation === 'approve',
    ),
  ).toBe(false);
});
