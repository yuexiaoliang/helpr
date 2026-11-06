// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { WorkspaceStore } from '../../app/renderer/store';
import { App } from '../../app/renderer/App';
import type {
  WorkspaceBridge,
  WorkspaceEvent,
} from '../../app/shared/contracts';

let dispose = () => {};
afterEach(() => {
  cleanup();
  dispose();
});
test('任务 A 的中文对话草稿不会进入 B，输入法确认键不会提前发送', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-ui-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const a = records.execute({
    kind: 'create',
    requestId: 'a',
    goal: '发布周报',
  }).taskId;
  const b = records.execute({
    kind: 'create',
    requestId: 'b',
    goal: '整理资料',
  }).taskId;
  const listeners = new Set<(event: WorkspaceEvent) => void>();
  const bridge: WorkspaceBridge = {
    request(command) {
      if (command.kind === 'snapshot')
        return Promise.resolve(records.snapshot());
      const result = records.execute(command);
      listeners.forEach((listener) => listener({ state: result.state }));
      return Promise.resolve(result);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const store = new WorkspaceStore(bridge, records.snapshot());
  dispose = () => {
    store.dispose();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  };
  const view = render(<App store={store} surface="chat" taskId={a} />);
  const input = screen.getByRole('textbox', { name: '给这项任务的要求' });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '手动接管测试' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(
    records
      .snapshot()
      .tasks.find((t) => t.id === a)
      ?.messages.filter((m) => m.role === 'user'),
  ).toHaveLength(1);
  fireEvent.compositionEnd(input);
  await waitFor(() =>
    expect(records.snapshot().tasks.find((t) => t.id === a)?.draft).toBe(
      '手动接管测试',
    ),
  );
  view.unmount();
  render(<App store={store} surface="chat" taskId={b} />);
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: '给这项任务的要求',
    }).value,
  ).toBe('');
  expect(records.snapshot().tasks.find((t) => t.id === a)?.draft).toBe(
    '手动接管测试',
  );
});

test('在标签旁停止只关闭所属任务，历史列表可以回看原任务', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-close-ui-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const { taskId: a, state } = records.execute({
    kind: 'create',
    goal: '把周报分别发到校刊和公告栏',
    requestId: 'ab',
  });
  const listeners = new Set<(e: WorkspaceEvent) => void>();
  const emit = (e: WorkspaceEvent) => listeners.forEach((l) => l(e));
  const store = new WorkspaceStore(
    {
      request(c) {
        if (c.kind === 'snapshot') return Promise.resolve(records.snapshot());
        if (c.kind === 'panel') {
          emit({ panel: c });
          return Promise.resolve();
        }
        const result =
          c.kind === 'stop-and-close'
            ? records.execution({
                kind: 'intent',
                intent: 'stop',
                taskId: c.taskId,
                requestId: c.requestId,
                closeAtVersion: c.executionVersion,
              })
            : records.execute(c);
        emit({ state: result.state });
        return Promise.resolve(result);
      },
      subscribe(l) {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    },
    state,
  );
  dispose = () => {
    store.dispose();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  };
  render(
    <>
      <App surface="chrome" store={store} />
      <App surface="panel" store={store} />
    </>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: '关闭任务 把周报发到校刊' }),
  );
  const fold = await screen.findByRole('button', { name: '收起任务' });
  await waitFor(() => expect(document.activeElement).toBe(fold));
  fireEvent.keyDown(fold, { key: 'Escape', code: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '关闭任务' })).toBeNull(),
  );
  expect(records.snapshot().tasks[0]).toMatchObject({
    id: a,
    archived: false,
    hidden: false,
    execution: null,
  });
  fireEvent.click(
    screen.getByRole('button', { name: '关闭任务 把周报发到校刊' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '停止任务' }));
  await waitFor(() =>
    expect(records.snapshot().tasks[0]).toMatchObject({
      id: a,
      archived: true,
      hidden: true,
      execution: { intent: 'stopped' },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '关闭任务' })).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: '查看全部任务' }));
  fireEvent.click(await screen.findByRole('button', { name: '历史记录' }));
  fireEvent.click(
    screen.getByRole('button', { name: /把周报发到校刊.*已停止/ }),
  );
  await waitFor(() => expect(records.snapshot().active).toBe(a));
  expect(records.snapshot().tasks[0]).toMatchObject({
    archived: true,
    hidden: false,
    execution: { intent: 'stopped' },
  });
});
