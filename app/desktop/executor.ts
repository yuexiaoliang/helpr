import {
  chromium,
  type ConnectOverCDPTransport,
  type Locator,
  type Page,
} from 'playwright-core';
import { z } from 'zod';
import {
  webActionSchema,
  elementLocatorSchema,
  actionFailureCodeSchema,
} from '../shared/execution';

const port = process.parentPort;
if (!port) throw Error('WORKER_CHANNEL_REQUIRED');
let started = false;
const transport: ConnectOverCDPTransport = {
  send: (packet) => port.postMessage({ protocol: packet }),
  close: () => {
    transport.onclose?.();
  },
  onmessage: undefined,
  onclose: undefined,
};
function locate(
  page: Page,
  target: z.infer<typeof elementLocatorSchema>,
): Locator {
  const root = target.within
    ? page.getByRole(target.within.role, {
        name: target.within.name,
        exact: target.within.exact,
      })
    : page;
  return root.getByRole(target.role, {
    name: target.name,
    exact: target.exact,
  });
}
port.on('message', ({ data }: { data: unknown }) => {
  const incoming = z
    .object({ protocol: z.record(z.string(), z.unknown()) })
    .safeParse(data);
  if (incoming.success) {
    transport.onmessage?.(incoming.data.protocol);
    return;
  }
  const job = z.object({ job: webActionSchema }).safeParse(data);
  if (!job.success || started) return;
  started = true;
  void (async () => {
    let phase: 'connect' | 'act' = 'connect';
    try {
      const browser = await chromium.connectOverCDP(transport, {
        noDefaults: true,
        timeout: 7000,
      });
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages.length !== 1) throw Error('SINGLE_OWNED_PAGE_REQUIRED');
      const page = pages[0]!;
      page.setDefaultTimeout(7000);
      const action = job.data.job,
        target = locate(page, action.target);
      phase = 'act';
      if (action.kind === 'click') await target.click({ timeout: 7000 });
      else if (action.kind === 'fill')
        await target.fill(action.value, { timeout: 7000 });
      else if (action.kind === 'check')
        await target.setChecked(action.checked, { timeout: 7000 });
      else
        await target.selectOption({ label: action.value }, { timeout: 7000 });
      port.postMessage({ done: true });
    } catch (error) {
      // 只返回固定分类，禁止把含网页内容、定位文字的原始异常发到日志。
      const message = error instanceof Error ? error.message : '';
      const reason = message.includes('element is not stable')
        ? 'UNSTABLE'
        : message.includes('element is not visible')
          ? 'INVISIBLE'
          : message.includes('outside of the viewport')
            ? 'VIEWPORT'
            : message.includes('EXECUTION_CAPABILITY_REVOKED_OR_DENIED')
              ? 'CAPABILITY'
              : error instanceof Error && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'UNAVAILABLE';
      port.postMessage({
        failed: true,
        code: actionFailureCodeSchema.parse(
          `EXECUTION_${phase.toUpperCase()}_${reason}`,
        ),
      });
    }
  })();
});
process.on('disconnect', () => process.exit(0));
