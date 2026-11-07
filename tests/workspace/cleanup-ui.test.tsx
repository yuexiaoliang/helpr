// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { setup } from './workflow-fixture';
import { WorkspaceStore } from '../../app/renderer/store';
import { CleanupSettings } from '../../app/renderer/CleanupSettings';
let dispose = () => {};
afterEach(() => {
  cleanup();
  dispose();
});
test('界面先显示影响，再显式提交；过期预览可重新检查，保存检查与清理分开', async () => {
  const f = await setup(),
    taskId = await f.add('界面清理');
  await f.approve(taskId);
  const records = f.records();
  let rechecks = 0;
  const store = new WorkspaceStore(
    {
      subscribe: () => () => {},
      request: async (c) => {
        await Promise.resolve();
        if (c.kind === 'snapshot') return records.snapshot();
        if (c.kind === 'storage-recheck') {
          rechecks++;
          return { state: records.checkpoint() };
        }
        return records.cleanup(c);
      },
    },
    records.snapshot(),
  );
  dispose = () => {
    store.dispose();
  };
  render(<CleanupSettings store={store} state={records.snapshot()} />);
  expect(screen.queryByText('确认清理所选副本')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('查看清理影响'));
  await screen.findByText(
    `预计释放 ${f.page(taskId).bytes.length} 字节，涉及 1 份素材副本。`,
  );
  records.checkpoint();
  fireEvent.click(screen.getByText('确认清理所选副本'));
  await screen.findByText(/清理预览后资料或引用发生变化/);
  expect(
    records.snapshot().tasks[0]!.execution!.historyCleanup,
  ).toBeUndefined();
  fireEvent.click(screen.getByText('查看清理影响'));
  await screen.findByText('确认清理所选副本');
  fireEvent.click(screen.getByText('确认清理所选副本'));
  await screen.findByText(/清理已完成/);
  expect(records.snapshot().tasks[0]!.execution!.historyCleanup).toBeDefined();
  fireEvent.click(screen.getByText('重新检查本机保存'));
  await waitFor(() => expect(rechecks).toBe(1));
});
