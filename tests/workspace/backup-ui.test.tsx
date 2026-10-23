// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { WorkspaceStore } from '../../app/renderer/store';
import { BackupSettings } from '../../app/renderer/BackupSettings';
import { BackupService } from '../../app/desktop/backup-service';
import { randomUUID } from 'node:crypto';
import type { BackupStatus } from '../../app/shared/backup';
import type { WorkspaceEvent } from '../../app/shared/contracts';

let dispose = () => {};
afterEach(() => {
  cleanup();
  dispose();
});

test('备份界面从文件选择到恢复使用公开入口，恢复后明确核对才能选择继续', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-backup-ui-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const taskId = records.execute({
    kind: 'create',
    requestId: 'A',
    goal: '保存当前任务',
  }).taskId;
  records.execution({
    kind: 'intent',
    taskId,
    requestId: 'start',
    intent: 'start',
  });
  let state = records.snapshot(),
    selected = '';
  const listeners = new Set<(event: WorkspaceEvent) => void>();
  const publish = () => {
    state = records.snapshot();
    listeners.forEach((listener) => listener({ state }));
  };
  const service = new BackupService({
    choose: (mode) => Promise.resolve(mode === 'directory' ? folder : selected),
    records: async (command) => records.backup(command),
    current: () => state,
    publish: () => publish(),
    hold: () => {
      records.execution({ kind: 'backup-pause', taskId });
      publish();
      return Promise.resolve();
    },
    release: () => Promise.resolve(),
    ready: () => true,
  });
  const store = new WorkspaceStore(
    {
      request: async (command) => {
        if (command.kind === 'snapshot') return state;
        if (command.kind.startsWith('backup-')) {
          const result = await service.handle(command);
          if (result.archive) selected = result.archive.file;
          return result;
        }
        throw Error('UNEXPECTED_COMMAND');
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
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
  const view = render(<BackupSettings store={store} state={state} />);
  fireEvent.click(screen.getByRole('button', { name: '选择本机位置' }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '创建本机备份' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '创建本机备份' }));
  await screen.findByText('本机备份已完成并通过完整性检查。');
  fireEvent.click(screen.getByRole('button', { name: '选择并检查备份' }));
  await screen.findByText(/备份检查通过。恢复前/);
  fireEvent.click(screen.getByRole('button', { name: '保留当前资料并恢复' }));
  await screen.findByText(/资料已恢复，当前资料副本已保留/);
  view.rerender(<BackupSettings store={store} state={state} />);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '选择继续本项' })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '核对实际结果' })
      .disabled,
  ).toBe(false);
});

test('外层回执超时后仍显示原操作进行中，并持续取得完成状态', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-backup-pending-ui-'));
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const state = records.snapshot();
  const requestId = randomUUID();
  let status: BackupStatus = {
    location: folder,
    selection: null,
    phase: 'working',
    operation: 'create',
    requestId,
    message: '原备份正在保存',
  };
  const sent: string[] = [];
  const store = new WorkspaceStore(
    {
      request: (command) => {
        if (command.kind === 'snapshot') return Promise.resolve(state);
        if (command.kind === 'backup-status')
          return Promise.resolve(structuredClone(status));
        if (command.kind === 'backup-create') {
          sent.push(command.requestId);
          return Promise.reject(Error('UNEXPECTED_DUPLICATE'));
        }
        return Promise.reject(Error('UNEXPECTED_COMMAND'));
      },
      subscribe: () => () => {},
    },
    state,
  );
  dispose = () => {
    store.dispose();
    records.close();
    rmSync(folder, { recursive: true, force: true });
  };
  render(<BackupSettings store={store} state={state} />);
  await screen.findByText('原备份正在保存');
  const create = screen.getByRole<HTMLButtonElement>('button', {
    name: '创建本机备份',
  });
  expect(create.disabled).toBe(true);
  fireEvent.click(create);
  expect(sent).toEqual([]);
  status = { ...status, phase: 'complete', message: '原备份已完成' };
  await screen.findByText('原备份已完成');
  expect(create.disabled).toBe(false);
});
