import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { WebExecutor } from '../../app/desktop/web-executor';
import type {
  BoundObservation,
  WebActionJob,
} from '../../app/desktop/execution-service';
import type { ExecutionProtocol } from '../../app/desktop/execution-protocol';
const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }));
function fixture(subframe = false) {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
  });
  mocks.fork.mockReturnValue(worker);
  const binding = { targetId: 'page', generation: 1 };
  const observed = (textValue: string): BoundObservation => ({
    binding,
    observation: {
      url: 'https://example.test/',
      title: '正文',
      text: '正文',
      fingerprint: 'fingerprint',
      generation: 1,
      observedAt: Date.now(),
      truncated: false,
      controls: [
        {
          role: 'textbox',
          name: '正文',
          frameUrl: subframe
            ? 'https://example.test/body'
            : 'https://example.test/',
          disabled: false,
          readOnly: false,
          textValue,
          richText: {
            rule: 'contenteditable-ax-v1',
            backendNodeId: 11,
            valueSource: 'ax',
          },
        },
      ],
    },
  });
  let live = true;
  const abort = new AbortController();
  const job: WebActionJob = {
    taskId: 'A',
    runId: 'run',
    actionId: 'fill',
    binding,
    source: observed('旧正文').observation,
    action: {
      kind: 'fill',
      target: {
        role: 'textbox',
        name: '正文',
        exact: true,
        ...(subframe ? { frameUrl: 'https://example.test/body' } : {}),
      },
      value: '甲\n乙',
    },
    signal: abort.signal,
    qualified: () => live,
  };
  const observe = vi.fn(() => Promise.resolve(observed('旧正文')));
  const protocol = {
    open: vi.fn(() => ({})),
    close: vi.fn(),
    command: vi.fn(),
  } as unknown as ExecutionProtocol;
  const executor = new WebExecutor(protocol, observe, {}, () => {});
  const work = executor.perform(job);
  const outcome = work.then(
    () => 'done',
    () => 'unknown',
  );
  return {
    worker,
    observed,
    observe,
    abort,
    protocol,
    executor,
    outcome,
    revoke: () => {
      live = false;
    },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  await expect
    .poll(() => mocks.fork.mock.results.at(-1)?.value === f.worker)
    .toBe(true);
  await new Promise((r) => setTimeout(r, 0));
}
test.each([false, true])(
  '同一backend节点精确前缀逐段核对（子frame=%s）',
  async (subframe) => {
    const f = fixture(subframe);
    await ready(f);
    f.observe.mockResolvedValue(f.observed('甲'));
    f.worker.emit('message', { richTextCheck: { id: 1, expected: '甲' } });
    await expect.poll(() => f.worker.postMessage.mock.calls.length).toBe(1);
    f.observe.mockResolvedValue(f.observed('甲\n乙'));
    f.worker.emit('message', { richTextCheck: { id: 2, expected: '甲\n乙' } });
    await expect.poll(() => f.worker.postMessage.mock.calls.length).toBe(2);
    f.worker.emit('message', { done: true });
    expect(await f.outcome).toBe('done');
  },
);
test.each([
  'text',
  'node',
  'page',
  'generation',
  'duplicate',
  'early-done',
  'session',
  'frame',
])('%s不符拒绝续写', async (mode) => {
  const f = fixture();
  await ready(f);
  const next = f.observed('甲');
  if (mode === 'frame') next.observation.controls![0]!.frameUrl += 'different';
  if (mode === 'session')
    next.session = {} as NonNullable<BoundObservation['session']>;
  if (mode === 'text') next.observation.controls![0]!.textValue = '甲\n';
  if (mode === 'node')
    next.observation.controls![0]!.richText!.backendNodeId = 12;
  if (mode === 'page') next.observation.url += 'changed';
  if (mode === 'generation') next.binding = { ...next.binding, generation: 2 };
  f.observe.mockResolvedValue(next);
  f.worker.emit(
    'message',
    mode === 'early-done'
      ? { done: true }
      : {
          richTextCheck: { id: mode === 'duplicate' ? 2 : 1, expected: '甲' },
        },
  );
  expect(await f.outcome).toBe('unknown');
  expect(f.worker.postMessage).not.toHaveBeenCalled();
});
test.each(['stop', 'takeover'])(
  '观察等待中%s，迟到核对不能释放下一段',
  async (mode) => {
    const f = fixture();
    await ready(f);
    let release!: (value: BoundObservation) => void;
    f.observe.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    f.worker.emit('message', { richTextCheck: { id: 1, expected: '甲' } });
    if (mode === 'stop') f.abort.abort();
    else f.revoke();
    release(f.observed('甲'));
    expect(await f.outcome).toBe('unknown');
    expect(f.worker.postMessage).not.toHaveBeenCalled();
  },
);
