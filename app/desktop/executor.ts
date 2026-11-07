import {
  chromium,
  type ConnectOverCDPTransport,
  type Locator,
  type Page,
  type Frame,
} from 'playwright-core';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fillLocatorSchema } from '../shared/web-action';
import { fillRichText } from './rich-text-input';
import { materialPayloadSchema } from '../shared/material';
import { webActionSchema, actionFailureCodeSchema } from '../shared/execution';

const port = process.parentPort;
if (!port) throw Error('WORKER_CHANNEL_REQUIRED');
let started = false;
let checkSequence = 0;
let checked: { id: number; resolve: () => void } | undefined;
function checkpoint(expected: string): Promise<void> {
  const id = ++checkSequence;
  return new Promise((resolve) => {
    checked = { id, resolve };
    port.postMessage({ richTextCheck: { id, expected } });
  });
}
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
  target: z.infer<typeof fillLocatorSchema>,
): Locator {
  const frame = selectFrame(page, target.frameUrl);
  if ('richTextNodeId' in target) return frame.locator('css=' + target.path);
  const root = target.within
    ? frame.getByRole(target.within.role, {
        name: target.within.name,
        exact: target.within.exact,
      })
    : frame;
  return root.getByRole(target.role, {
    name: target.name,
    exact: target.exact,
  });
}
function selectFrame(page: Page, url?: string): Frame {
  if (!url) return page.mainFrame();
  const matches = page.frames().filter((f) => f.url() === url);
  if (matches.length !== 1) throw Error('FRAME_NOT_UNIQUE');
  return matches[0]!;
}
port.on('message', ({ data }: { data: unknown }) => {
  const receipt = z
    .object({ richTextChecked: z.number().int() })
    .safeParse(data);
  if (receipt.success) {
    if (checked?.id === receipt.data.richTextChecked) {
      const pending = checked;
      checked = undefined;
      pending.resolve();
    }
    return;
  }
  const incoming = z
    .object({ protocol: z.record(z.string(), z.unknown()) })
    .safeParse(data);
  if (incoming.success) {
    transport.onmessage?.(incoming.data.protocol);
    return;
  }
  const job = z
    .object({
      job: webActionSchema,
      payload: materialPayloadSchema.optional(),
      richText: z.boolean().default(false),
      richTextInitial: z.string().optional(),
    })
    .safeParse(data);
  if (!job.success || started) return;
  started = true;
  void (async () => {
    let phase: 'connect' | 'act' = 'connect';
    let selectionStage: 'inspect' | 'choose' | undefined;
    try {
      const browser = await chromium.connectOverCDP(transport, {
        noDefaults: true,
        timeout: 7000,
      });
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages.length !== 1) throw Error('SINGLE_OWNED_PAGE_REQUIRED');
      const page = pages[0]!;
      page.setDefaultTimeout(7000);
      const action = job.data.job;
      phase = 'act';
      if (action.kind === 'upload') {
        const payload = materialPayloadSchema.parse(job.data.payload);
        const buffer = Buffer.from(payload.base64, 'base64');
        if (
          createHash('sha256').update(buffer).digest('hex') !== payload.sha256
        )
          throw Error('MATERIAL_CORRUPT');
        const target = selectFrame(page, action.target.frameUrl)
          .locator('input[type="file"]')
          .nth(action.target.fileIndex);
        await target.setInputFiles(
          { name: payload.name, mimeType: 'application/octet-stream', buffer },
          { timeout: 7000 },
        );
        port.postMessage({ done: true });
        return;
      }
      const target = locate(page, action.target);
      if ((await target.count()) !== 1)
        throw Error('EXECUTION_LOCATOR_MISSING');
      if (action.kind === 'click') await target.click({ timeout: 7000 });
      else if (action.kind === 'fill') {
        // 实际节点若是富文本，必须已有独立观察；不允许模糊名称或未核对的frame绕过。
        const editable = await target.evaluate(
          (element) =>
            element instanceof HTMLElement && element.isContentEditable,
        );
        if (editable !== job.data.richText)
          throw Error('EXECUTION_CAPABILITY_REVOKED_OR_DENIED');
        if (job.data.richText)
          await fillRichText(
            page,
            target,
            action.value,
            checkpoint,
            job.data.richTextInitial,
          );
        else await target.fill(action.value, { timeout: 7000 });
      } else if (action.kind === 'check')
        await target.setChecked(action.checked, { timeout: 7000 });
      else {
        // Playwright 按标签选择前，拒绝重复标签、多选与自定义组合框。
        selectionStage = 'inspect';
        const unique = await target.evaluate((element, label) => {
          if (element.tagName !== 'SELECT') return false;
          const select = element as HTMLSelectElement;
          const options = Array.from(select.options).filter(
            (o) => o.label === label,
          );
          return (
            !select.multiple &&
            options.length === 1 &&
            !options[0]!.disabled &&
            !options[0]!.closest('optgroup[disabled]')
          );
        }, action.value);
        if (!unique) throw Error('EXECUTION_SELECTION_UNAVAILABLE');
        selectionStage = 'choose';
        await target.selectOption({ label: action.value }, { timeout: 7000 });
      }
      port.postMessage({ done: true });
    } catch (error) {
      // 只返回固定分类，禁止把含网页内容、定位文字的原始异常发到日志。
      const message = error instanceof Error ? error.message : '';
      const reason = message.includes('EXECUTION_SELECTION_UNAVAILABLE')
        ? 'SELECTION_UNAVAILABLE'
        : message.includes('EXECUTION_LOCATOR_MISSING')
          ? 'LOCATOR_MISSING'
          : message.includes('intercepts pointer events')
            ? 'OBSCURED'
            : message.includes('waiting for scheduled navigations to finish')
              ? 'NAVIGATION'
              : message.includes('element is not stable')
                ? 'UNSTABLE'
                : message.includes('element is not visible')
                  ? 'INVISIBLE'
                  : message.includes('outside of the viewport')
                    ? 'VIEWPORT'
                    : message.includes('EXECUTION_CAPABILITY_REVOKED_OR_DENIED')
                      ? 'CAPABILITY'
                      : error instanceof Error && error.name === 'TimeoutError'
                        ? selectionStage === 'inspect'
                          ? 'SELECTION_INSPECT_TIMEOUT'
                          : selectionStage === 'choose'
                            ? 'SELECTION_CHOOSE_TIMEOUT'
                            : message.includes('performing click action')
                              ? 'INPUT_WAIT'
                              : message.includes('done scrolling')
                                ? 'HIT_TARGET_WAIT'
                                : message.includes(
                                      'scrolling into view if needed',
                                    ) ||
                                    (message.includes(
                                      'attempting click action',
                                    ) &&
                                      !message.includes(
                                        'waiting for element to be',
                                      ))
                                  ? 'SCROLL_WAIT'
                                  : message.includes(
                                        'waiting for element to be',
                                      ) &&
                                      !message.includes('element is visible')
                                    ? 'STABILITY_WAIT'
                                    : 'TIMEOUT'
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
