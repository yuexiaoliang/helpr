// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { afterEach, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PublishingAgreement } from '../../app/renderer/PublishingAgreement';
import { WorkspaceStore } from '../../app/renderer/store';
import { snapshotSchema, type UICommand } from '../../app/shared/contracts';

afterEach(cleanup);
test('完整复述展示素材、目标、变化与期次，接受只发约定命令；中文组字不提交', async () => {
  const versionId = randomUUID();
  const state = snapshotSchema.parse({
    revision: 1,
    active: 'A',
    tasks: [
      {
        id: 'A',
        goal: '约定文章发布',
        created: 1,
        url: 'https://example.com/new',
        draft: '',
        hidden: false,
        minimized: false,
        phase: 'manual',
        error: '',
        version: 1,
        messages: [],
        execution: {
          intent: 'stopped',
          phase: 'stopped',
          version: 2,
          intentId: 'stop',
          goalVersion: 1,
          goal: '约定文章发布',
          runId: null,
          resource: null,
          summary: '已停止',
          actions: [],
          agreements: [
            {
              id: randomUUID(),
              versionId,
              version: 1,
              requestId: randomUUID(),
              request: '以后自动发布',
              createdAt: 1,
              acceptedAt: null,
              revokedAt: null,
              revocation: null,
              terms: {
                selection: {
                  scope: '/Users/test/reports',
                  rule: 'only',
                  name: null,
                  extension: '.xlsx',
                },
                entryUrl: 'https://example.com/new',
                destination: '公告',
                contentRules: '逐行说明数量',
                changedBytes: 'ask',
                period: 'per-period',
              },
            },
          ],
        },
      },
    ],
  });
  const commands: UICommand[] = [];
  const store = new WorkspaceStore(
    {
      subscribe: () => () => {},
      request: (c) => {
        commands.push(c);
        return Promise.resolve(state);
      },
    },
    state,
  );
  render(<PublishingAgreement task={state.tasks[0]!} store={store} />);
  fireEvent.click(screen.getByText('发布约定'));
  expect(screen.getByText(/素材字节变化后先确认再发布/).textContent).toContain(
    '每个明确期次分别处理',
  );
  expect(screen.getByText(/从“\/Users\/test\/reports”/).textContent).toContain(
    '公告',
  );
  fireEvent.click(screen.getByRole('button', { name: '接受这个发布约定' }));
  await waitFor(() =>
    expect(
      commands.some(
        (c) => c.kind === 'agreement-accept' && c.versionId === versionId,
      ),
    ).toBe(true),
  );
  expect(
    commands.some(
      (c) => c.kind === 'participation-decision' || c.kind === 'agreement-use',
    ),
  ).toBe(false);
  const input = screen.getByRole('textbox', { name: '用自然语言修改约定' });
  fireEvent.change(input, { target: { value: '改为通知栏目，其它要求相同' } });
  fireEvent.compositionStart(input);
  fireEvent.click(screen.getByRole('button', { name: '复述约定供我确认' }));
  expect(commands.some((c) => c.kind === 'agreement-prepare')).toBe(false);
  fireEvent.compositionEnd(input);
  fireEvent.click(screen.getByRole('button', { name: '复述约定供我确认' }));
  await waitFor(() =>
    expect(
      commands.some(
        (c) =>
          c.kind === 'agreement-prepare' &&
          c.text === '改为通知栏目，其它要求相同',
      ),
    ).toBe(true),
  );
});
