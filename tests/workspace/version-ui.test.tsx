// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { WorkspaceStore } from '../../app/renderer/store';
import { App } from '../../app/renderer/App';
import { VersionSettings } from '../../app/renderer/VersionSettings';
import type { WorkspaceEvent, UICommand } from '../../app/shared/contracts';
import type { VersionStatus } from '../../app/shared/version';

let dispose = () => {};
afterEach(() => {
  cleanup();
  dispose();
});
function setup() {
  let status: VersionStatus = {
    revision: 2,
    current: {
      version: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '14.8.3',
      dataFormat: 6,
      stateModel: 1,
    },
    source:
      'https://raw.githubusercontent.com/yuexiaoliang/helpr/refs/heads/codex/updates-stable/macos-arm64.json',
    phase: 'done',
    origin: 'automatic',
    checkedAt: 1000,
    result: {
      kind: 'available',
      release: {
        schema: 1,
        version: '0.2.0',
        platform: 'darwin',
        arch: 'arm64',
        minOS: '14.0.0',
        dataFormats: [6],
        stateModels: [1],
        notes: ['改进结果查看'],
        downloadURL:
          'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0',
      },
    },
    lastSuccess: { version: '0.2.0', kind: 'available', checkedAt: 1000 },
    noticeVisible: true,
    openFailed: false,
  };
  const commands: UICommand[] = [],
    listeners = new Set<(event: WorkspaceEvent) => void>();
  const state = { revision: 0, active: null, tasks: [] };
  const emit = (event: WorkspaceEvent) =>
    listeners.forEach((listener) => listener(event));
  const store = new WorkspaceStore(
    {
      request(command) {
        commands.push(command);
        if (command.kind === 'snapshot') return Promise.resolve(state);
        if (command.kind === 'version-status') return Promise.resolve(status);
        if (command.kind === 'version-check') {
          status = {
            ...status,
            revision: status.revision + 1,
            phase: 'checking',
            noticeVisible: false,
          };
          emit({ version: status });
          return Promise.resolve(status);
        }
        if (command.kind === 'version-dismiss') {
          status = {
            ...status,
            revision: status.revision + 1,
            noticeVisible: false,
          };
          emit({ version: status });
          return Promise.resolve(status);
        }
        if (command.kind === 'version-open') return Promise.resolve(status);
        if (command.kind === 'panel') {
          emit({ panel: command });
          return Promise.resolve(null);
        }
        throw Error('UNEXPECTED_TASK_CHANGE');
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    state,
  );
  dispose = () => store.dispose();
  return {
    emit,
    store,
    commands,
    update: (patch: Partial<VersionStatus>, notice = false) => {
      status = { ...status, ...patch, revision: status.revision + 1 };
      emit({ version: status, versionNotice: notice });
    },
    get: () => status,
  };
}

test('后台新版投影只显示提醒和入口标记，不主动开设置；稍后不会发任务命令', async () => {
  const f = setup();
  render(
    <>
      <App store={f.store} surface="chrome" />
      <App store={f.store} surface="toast" />
    </>,
  );
  act(() => f.update({}, true));
  expect(
    screen.getByRole('button', { name: '关于与新版' }).textContent,
  ).toContain('有新版');
  expect(f.commands.filter((c) => c.kind === 'panel')).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '稍后' }));
  await act(async () => {});
  expect(f.get().noticeVisible).toBe(false);
  expect(f.commands.some((c) => c.kind === 'version-dismiss')).toBe(true);
  expect(
    f.commands.every((c) => ['snapshot', 'version-dismiss'].includes(c.kind)),
  ).toBe(true);
});

test('设置检查失败明确保留历史，检查中和失败后均不开放旧下载链接', async () => {
  const f = setup();
  render(<VersionSettings store={f.store} />);
  await screen.findByText('helpr 0.2.0 · 可手动下载');
  fireEvent.click(screen.getByRole('button', { name: '打开手动下载页 ↗' }));
  await act(async () => {});
  expect(f.commands.find((c) => c.kind === 'version-open')).toEqual({
    kind: 'version-open',
    revision: 2,
  });
  fireEvent.click(screen.getByRole('button', { name: '检查新版' }));
  await screen.findByText('正在检查新版…');
  expect(screen.queryByRole('button', { name: '打开手动下载页 ↗' })).toBeNull();
  act(() => f.update({ phase: 'done', result: { kind: 'offline' } }));
  await screen.findByText('未能检查新版');
  expect(screen.getByText(/这是历史结果/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开手动下载页 ↗' })).toBeNull();
  expect(
    f.commands.filter((c) =>
      ['quit', 'execution-intent', 'backup-create'].includes(c.kind),
    ),
  ).toEqual([]);
});

test('旧版本投影不覆盖新的失败，迟到状态不会重新显示可下载入口', async () => {
  const f = setup();
  render(<VersionSettings store={f.store} />);
  await screen.findByText('helpr 0.2.0 · 可手动下载');
  const old = structuredClone(f.get());
  act(() => f.update({ phase: 'done', result: { kind: 'data' } }));
  await screen.findByText('新版暂不能接续当前资料');
  act(() => f.emit({ version: old }));
  const status = f.store.get().version;
  expect(status?.revision).toBeGreaterThan(old.revision);
  expect(screen.queryByRole('button', { name: '打开手动下载页 ↗' })).toBeNull();
});
