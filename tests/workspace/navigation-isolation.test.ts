import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ExecutionService } from '../../app/desktop/execution-service';
import type { WorkspaceSnapshot } from '../../app/shared/contracts';

test('A导航事实慢保存只阻止退出，不暂停B的系统执行资格；退出等待原保存', async () => {
  const state: WorkspaceSnapshot = { revision: 0, active: null, tasks: [] };
  let release!: (value: unknown) => void;
  const service = new ExecutionService({
    current: () => state,
    publish: () => {},
    records: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    observe: () => Promise.reject(Error('UNEXPECTED_OBSERVE')),
    propose: () => Promise.reject(Error('UNEXPECTED_PROPOSAL')),
    perform: () => Promise.reject(Error('UNEXPECTED_ACTION')),
    revoke: () => {},
    stopModels: () => {},
  });
  const saving = service.recordNavigation({
    taskId: 'A',
    runId: 'run',
    actionId: 'action',
    navigation: {
      id: randomUUID(),
      association: 'during-action',
      targetId: 'page-A',
      sourceGeneration: 1,
      generation: 2,
      url: 'https://example.com/result',
      mainFrame: true,
      sameDocument: false,
      inputEpoch: 1,
      observedAt: 1,
    },
  });
  try {
    expect(service.systemReady()).toBe(true);
    expect(service.canExit()).toBe(false);
    let settled = false;
    const waiting = service.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ state });
    await saving;
    await waiting;
    expect(service.canExit()).toBe(true);
  } finally {
    release({ state });
    await saving;
  }
});
