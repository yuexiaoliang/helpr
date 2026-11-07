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
import { ScheduledPlan } from '../../app/renderer/ScheduledPlan';
import { ParticipationInbox } from '../../app/renderer/Participation';
import { WorkspaceStore } from '../../app/renderer/store';
import { snapshotSchema, type UICommand } from '../../app/shared/contracts';
import { type ScheduleTerms } from '../../app/shared/schedule';
afterEach(cleanup);
function fixture(missed: ScheduleTerms['missed'] = 'ask') {
  const versionId = randomUUID(),
    agreement = randomUUID(),
    planId = randomUUID();
  const state = snapshotSchema.parse({
    revision: 1,
    active: 'B',
    tasks: [
      {
        id: 'A',
        goal: '原计划任务',
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
          goal: '原计划任务',
          runId: null,
          resource: null,
          summary: '已停止',
          actions: [],
          agreements: [
            {
              id: randomUUID(),
              versionId: agreement,
              version: 1,
              requestId: 'agreement',
              request: '按约定发布',
              createdAt: 1,
              acceptedAt: 2,
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
          schedule: {
            revision: 1,
            cursor: Date.parse('2026-11-07T00:00:00Z'),
            restoreReview: false,
            rounds: [],
            versions: [
              {
                id: planId,
                versionId,
                version: 1,
                agreementVersionId: agreement,
                requestId: 'schedule',
                request: '每天九点',
                createdAt: 1,
                acceptedAt: null,
                cancelledAt: null,
                terms: {
                  zone: 'Asia/Shanghai',
                  startAt: '2026-11-07T00:00:00Z',
                  cadence: {
                    kind: 'calendar',
                    time: '09:00',
                    weekdays: [1, 2, 3, 4, 5, 6, 7],
                  },
                  overlap: 'ask',
                  gap: 'ask',
                  missed,
                  graceSeconds: 60,
                  periodKey: 'date',
                },
              },
            ],
          },
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
  return { state, task: state.tasks[0]!, commands, store, versionId, planId };
}
test('展示具体时间、时区、素材与错过规则，未选策略不能接受；IME 不提交', async () => {
  const f = fixture(null);
  render(<ScheduledPlan task={f.task} store={f.store} />);
  fireEvent.click(screen.getByText('定时计划'));
  expect(screen.getByText(/时区 Asia\/Shanghai/).textContent).toContain(
    '尚未约定',
  );
  expect(screen.getByText(/接下来的候选时间/).textContent).toContain(
    '2026-11-07T09:00:00+08:00',
  );
  const accept = screen.getByRole<HTMLButtonElement>('button', {
    name: '接受这个定时计划',
  });
  expect(accept.disabled).toBe(true);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '错过先问我' } });
  fireEvent.compositionStart(input);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: '复述定时计划' }),
  );
  expect(f.commands.some((c) => c.kind === 'schedule-prepare')).toBe(false);
  fireEvent.compositionEnd(input);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: '复述定时计划' }),
  );
  await waitFor(() =>
    expect(f.commands).toContainEqual(
      expect.objectContaining({
        kind: 'schedule-prepare',
        taskId: 'A',
        text: '错过先问我',
      }),
    ),
  );
});
test('跨任务待办回答只绑定原轮次，不批准内容或恢复旧任务', async () => {
  const f = fixture();
  const roundId = randomUUID();
  f.task.execution!.schedule!.rounds.push({
    id: roundId,
    planId: f.planId,
    versionId: f.versionId,
    occurrence: {
      key: '1',
      dueAt: 1,
      local: '2026-11-07T09:00+08:00[Asia/Shanghai]',
      date: '2026-11-07',
      ambiguity: null,
      treatment: 'run',
    },
    from: 0,
    checkedAt: 2,
    status: 'waiting',
    reason: '错过后先询问',
    links: [],
  });
  render(
    <ParticipationInbox
      tasks={f.state.tasks}
      store={f.store}
      close={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: '现在补做这个轮次一次',
    }),
  );
  await waitFor(() =>
    expect(f.commands).toContainEqual(
      expect.objectContaining({
        kind: 'schedule-decide',
        taskId: 'A',
        roundId,
        decision: 'run',
      }),
    ),
  );
  expect(
    f.commands.some(
      (c) =>
        c.kind === 'execution-intent' ||
        c.kind === 'participation-decision' ||
        c.kind === 'select',
    ),
  ).toBe(false);
});
