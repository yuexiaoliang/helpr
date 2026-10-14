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
