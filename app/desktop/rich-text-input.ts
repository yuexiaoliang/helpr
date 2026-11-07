import type { Locator, Page } from 'playwright-core';

/** 一次整体替换内的有限步骤。空行/CR暂不进入多步输入，不能先写一部分再发现不支持。 */
export function richTextLines(value: string) {
  const lines = value.split('\n');
  if (
    value.length > 4000 ||
    value.includes('\r') ||
    lines.length > 32 ||
    (lines.length > 1 && lines.some((line) => !line))
  )
    throw Error('EXECUTION_CAPABILITY_REVOKED_OR_DENIED');
  return lines;
}

/** 检查只读；实际变更全部经过 Playwright 和逐条输入门。 */
export async function fillRichText(
  page: Page,
  target: Locator,
  value: string,
  checkpoint: (expected: string) => Promise<void>,
  initial?: string,
) {
  const lines = richTextLines(value);
  const element = await target.elementHandle();
  if (!element) throw Error('EXECUTION_LOCATOR_MISSING');
  try {
    const inspect = async (
      focused: boolean,
      expected?: string,
      breakPending = false,
    ) => {
      if (
        !(await target.evaluate(
          (current, args) => {
            const { pinned, focused, expected, breakPending } = args;
            if (
              current !== pinned ||
              !(current instanceof HTMLElement) ||
              !current.isConnected ||
              !current.isContentEditable ||
              current.getAttribute('aria-readonly') === 'true' ||
              current.getAttribute('aria-disabled') === 'true' ||
              (expected !== undefined &&
                current.innerText !== expected &&
                (!breakPending || current.innerText !== expected + '\n'))
            )
              return false;
            if (!focused) return true;
            const selection = current.ownerDocument.getSelection();
            if (
              current.ownerDocument.activeElement !== current ||
              (current.ownerDocument.defaultView?.frameElement &&
                !current.ownerDocument.hasFocus()) ||
              !selection ||
              !selection.isCollapsed ||
              selection.rangeCount !== 1 ||
              !current.contains(selection.anchorNode)
            )
              return false;
            // 光标后只能留下浏览器用于末尾换行的 BR，不能越过已有文字或段落。
            const tail = selection.getRangeAt(0).cloneRange();
            tail.setEnd(current, current.childNodes.length);
            const fragment = tail.cloneContents();
            return (
              (!fragment.textContent ||
                (breakPending &&
                  fragment.textContent === '\n' &&
                  current.innerText === expected + '\n')) &&
              Array.from(fragment.querySelectorAll('*')).every((node) =>
                [
                  'BR',
                  'P',
                  'DIV',
                  'SPAN',
                  'B',
                  'STRONG',
                  'I',
                  'EM',
                  'U',
                  'S',
                ].includes(node.tagName),
              ) &&
              fragment.querySelectorAll('br').length <= 1 &&
              (!breakPending ||
                current.innerText === expected ||
                fragment.querySelectorAll('br').length === 1 ||
                fragment.textContent === '\n')
            );
          },
          { pinned: element, focused, expected, breakPending },
        ))
      )
        throw Error('EXECUTION_CAPABILITY_REVOKED_OR_DENIED');
    };
    await inspect(false);
    // 先固定句柄，再由控制拥有者重新核对原backend节点及完整源值。
    if (initial !== undefined) {
      await checkpoint(initial);
      await inspect(false);
    }
    await element.fill(lines[0]!, { timeout: 7000 });
    let expected = lines[0]!;
    await checkpoint(expected);
    for (const line of lines.slice(1)) {
      await inspect(true, expected);
      await page.keyboard.press('Shift+Enter');
      // 末尾占位BR或文字LF可暂时多显示一个LF；只有下一行写入后的AX全文严格相符才续行。
      await inspect(true, expected + '\n', true);
      await page.keyboard.insertText(line);
      expected += '\n' + line;
      await checkpoint(expected);
    }
  } finally {
    await element.dispose();
  }
}
