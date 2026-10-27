// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { WorkspaceStore } from '../../app/renderer/store';
import { UpgradeSettings } from '../../app/renderer/UpgradeSettings';
import type { UpgradeStatus } from '../../app/shared/upgrade';
import type { UICommand } from '../../app/shared/contracts';

let dispose = () => {};
afterEach(() => {
  cleanup();
  dispose();
});

test.each([
  { phase: 'checking' as const, continuity: 'retained' as const },
  { phase: 'blocked' as const, continuity: 'retained' as const },
  { phase: 'checking' as const, continuity: 'renewed' as const },
  { phase: 'blocked' as const, continuity: 'renewed' as const },
])(
  '本轮 $phase 不把上轮 $continuity 显示为当前凭据或登录检查成功',
  async ({ phase, continuity }) => {
    const status: UpgradeStatus = {
      revision: 9,
      recordRevision: 7,
      reopening: true,
      phase,
      installedVersion: '0.2.0',
      fromVersion: '0.1.0',
      target: '0.2.0',
      requestId: 'old-preparation',
      fingerprint: null,
      backup: null,
      error: phase === 'blocked' ? 'UPGRADE_CREDENTIAL_CHANGED' : '',
      continuity,
      dirtyTasks: [],
      pages: [],
      message: '本轮基础核对尚未通过。',
      working: false,
    };
    const store = new WorkspaceStore({
      subscribe: () => () => {},
      request: (c) =>
        Promise.resolve(
          c.kind === 'snapshot'
            ? { revision: 0, active: null, tasks: [] }
            : status,
        ),
    });
    dispose = () => store.dispose();
    render(<UpgradeSettings store={store} />);
    await screen.findByRole('button', {
      name: '检查原资料、凭据与网页控制',
    });
    expect(
      screen.queryByText(
        '原受保护密钥和会话资料摘要保持。网站实际登录与操作结果仍由各任务核对。',
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        '原会话已到期，用户重新登录后继续核对；本次不记作原有效会话延续。',
      ),
    ).toBeNull();
  },
);

test('完成一次核对后为后续新版建立新准备身份，而不是重用旧回执', async () => {
  const status: UpgradeStatus = {
    revision: 8,
    recordRevision: 6,
    reopening: false,
    phase: 'complete',
    installedVersion: '0.2.0',
    fromVersion: '0.1.0',
    target: '0.2.0',
    requestId: 'old-preparation',
    fingerprint: null,
    backup: null,
    error: '',
    continuity: 'retained',
    dirtyTasks: [],
    pages: [],
    message: '已完成基础核对。',
    working: false,
  };
  const commands: UICommand[] = [];
  const store = new WorkspaceStore({
    subscribe: () => () => {},
    request: (c) => {
      commands.push(c);
      if (c.kind === 'snapshot')
        return Promise.resolve({ revision: 0, active: null, tasks: [] });
      if (c.kind === 'version-status')
        return Promise.resolve({
          revision: 9,
          current: {
            version: '0.2.0',
            platform: 'darwin',
            arch: 'arm64',
            osVersion: '14.8.3',
            dataFormat: 7,
            stateModel: 1,
          },
          source: 'https://example.com/version.json',
          phase: 'done',
          origin: 'manual',
          result: {
            kind: 'available',
            release: {
              schema: 1,
              version: '0.3.0',
              platform: 'darwin',
              arch: 'arm64',
              minOS: '14.0.0',
              dataFormats: [7],
              stateModels: [1],
              notes: [],
              downloadURL:
                'https://github.com/yuexiaoliang/helpr/releases/tag/v0.3.0',
            },
          },
          checkedAt: 1,
          lastSuccess: null,
          noticeVisible: false,
          openFailed: false,
        });
      return Promise.resolve(status);
    },
  });
  dispose = () => store.dispose();
  await store.perform({ kind: 'version-status' });
  render(<UpgradeSettings store={store} />);
  fireEvent.click(await screen.findByRole('button', { name: '准备升级' }));
  await waitFor(() =>
    expect(commands.some((c) => c.kind === 'upgrade-prepare')).toBe(true),
  );
  const sent = commands.find((c) => c.kind === 'upgrade-prepare');
  expect(sent).toMatchObject({ versionRevision: 9 });
  if (sent?.kind === 'upgrade-prepare')
    expect(sent.requestId).not.toBe('old-preparation');
});
test('两项网页现场分别确认，A的回答不清除B，也不出现可退出按钮', async () => {
  let status: UpgradeStatus = {
    revision: 3,
    recordRevision: 3,
    reopening: false,
    phase: 'blocked',
    installedVersion: '0.1.0',
    fromVersion: '0.1.0',
    target: '0.2.0',
    requestId: 'prepare',
    fingerprint: null,
    backup: null,
    error: 'UPGRADE_PAGE_UNSAVED',
    continuity: 'unchecked',
    dirtyTasks: ['A', 'B'],
    message: '请分别处理网页现场。',
    working: false,
    pages: [
      { taskId: 'A', generation: 2, epoch: 3, dirty: true },
      { taskId: 'B', generation: 4, epoch: 5, dirty: true },
    ],
  };
  const commands: UICommand[] = [];
  const store = new WorkspaceStore({
    subscribe: () => () => {},
    request: (c) => {
      commands.push(c);
      if (c.kind === 'snapshot')
        return Promise.resolve({ revision: 0, active: null, tasks: [] });
      if (c.kind === 'upgrade-page-saved') {
        status = {
          ...status,
          dirtyTasks: ['B'],
          pages: status.pages.map((p) =>
            p.taskId === 'A' ? { ...p, dirty: false } : p,
          ),
        };
      }
      return Promise.resolve(status);
    },
  });
  dispose = () => store.dispose();
  render(<UpgradeSettings store={store} />);
  await screen.findByRole('button', { name: '我已在网页保存任务 A，核对现场' });
  fireEvent.click(
    screen.getByRole('button', { name: '我已在网页保存任务 A，核对现场' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '我已在网页保存任务 A，核对现场' }),
    ).toBeNull(),
  );
  expect(
    screen.getByRole('button', { name: '我已在网页保存任务 B，核对现场' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: '退出，准备手动安装' }),
  ).toBeNull();
  expect(commands.find((c) => c.kind === 'upgrade-page-saved')).toMatchObject({
    taskId: 'A',
    epoch: 3,
    generation: 2,
  });
});
