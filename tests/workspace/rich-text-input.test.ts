// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import type { Locator, Page } from 'playwright-core';
import { fillRichText, richTextLines } from '../../app/desktop/rich-text-input';

afterEach(() => document.body.replaceChildren());
function fixture() {
  const element = document.createElement('div');
  element.tabIndex = 0;
  Object.defineProperty(element, 'isContentEditable', { value: true });
  Object.defineProperty(element, 'innerText', {
    get: () => element.textContent,
  });
  document.body.append(element);
  let current = element;
  const writes: string[] = [];
  const end = () => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const handle = {
    fill: vi.fn((value: string) => {
      writes.push('fill:' + value);
      element.textContent = value;
      end();
      return Promise.resolve();
    }),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const locator = {
    elementHandle: () => Promise.resolve(handle),
    evaluate: (
      fn: (e: HTMLElement, a: unknown) => unknown,
      args: Record<string, unknown>,
    ) => Promise.resolve(fn(current, { ...args, pinned: element })),
  } as unknown as Locator;
  const page = {
    keyboard: {
      press: vi.fn(() => {
        writes.push('break');
        element.append('\n');
        end();
        return Promise.resolve();
      }),
      insertText: vi.fn((value: string) => {
        writes.push('text:' + value);
        element.append(value);
        end();
        return Promise.resolve();
      }),
    },
  } as unknown as Page;
  return {
    element,
    handle,
    writes,
    page,
    locator,
    replace: () => {
      current = document.createElement('div');
    },
  };
}
test('逐段等待独立确认，只使用fill、软换行和文字输入', async () => {
  const f = fixture(),
    checks: string[] = [];
  await fillRichText(
    f.page,
    f.locator,
    '中文<>&\n第二行\n第三行',
    (expected) => {
      checks.push(expected);
      expect(f.element.textContent).toBe(expected);
      return Promise.resolve();
    },
  );
  expect(f.writes).toEqual([
    'fill:中文<>&',
    'break',
    'text:第二行',
    'break',
    'text:第三行',
  ]);
  expect(checks).toEqual([
    '中文<>&',
    '中文<>&\n第二行',
    '中文<>&\n第二行\n第三行',
  ]);
  expect(f.handle.dispose).toHaveBeenCalledOnce();
});
test.each(['focus', 'replace', 'caret', 'readonly', 'rewrite'])(
  '%s变化停止后续输入且不重新fill',
  async (mode) => {
    const f = fixture();
    await expect(
      fillRichText(f.page, f.locator, '第一行\n第二行', () => {
        if (mode === 'focus') f.element.blur();
        if (mode === 'replace') f.replace();
        if (mode === 'caret')
          document.getSelection()!.collapse(f.element.firstChild, 0);
        if (mode === 'readonly')
          f.element.setAttribute('aria-readonly', 'true');
        if (mode === 'rewrite') f.element.textContent = '其它正文';
        return Promise.resolve();
      }),
    ).rejects.toThrow('EXECUTION_CAPABILITY_REVOKED_OR_DENIED');
    expect(f.writes).toEqual(['fill:第一行']);
  },
);
test('换行事件转移焦点后不向其它字段追加文字', async () => {
  const f = fixture();
  f.page.keyboard.press = vi.fn(() => {
    f.element.blur();
    return Promise.resolve();
  });
  await expect(
    fillRichText(f.page, f.locator, '甲\n乙', () => Promise.resolve()),
  ).rejects.toThrow();
  expect(f.writes).toEqual(['fill:甲']);
});
test('核对失败或停止只留下部分输入，不重填', async () => {
  const f = fixture();
  await expect(
    fillRichText(f.page, f.locator, '甲\n乙', () =>
      Promise.reject(Error('STOPPED')),
    ),
  ).rejects.toThrow('STOPPED');
  expect(f.writes).toEqual(['fill:甲']);
});
test.each([
  '\n甲',
  '甲\n',
  '甲\n\n乙',
  '甲\r乙',
  Array(33).fill('甲').join('\n'),
])('不支持的结构在首次变更前拒绝 %#', async (value) => {
  const f = fixture();
  expect(() => richTextLines(value)).toThrow();
  await expect(
    fillRichText(f.page, f.locator, value, () => Promise.resolve()),
  ).rejects.toThrow();
  expect(f.writes).toEqual([]);
});

test('软换行改写正文时不得追加下一行', async () => {
  const f = fixture();
  f.page.keyboard.press = vi.fn(() => {
    f.element.textContent = '网站改写\n';
    const range = document.createRange();
    range.selectNodeContents(f.element);
    range.collapse(false);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return Promise.resolve();
  });
  await expect(
    fillRichText(f.page, f.locator, '甲\n乙', () => Promise.resolve()),
  ).rejects.toThrow();
  expect(f.writes).toEqual(['fill:甲']);
});

test('pre-wrap的软换行允许光标后恰好一个占位LF', async () => {
  const f = fixture();
  f.page.keyboard.press = vi.fn(() => {
    f.element.textContent = '甲\n\n';
    const range = document.createRange();
    range.setStart(f.element.firstChild!, 2);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return Promise.resolve();
  });
  await fillRichText(f.page, f.locator, '甲\n乙', () => Promise.resolve());
  expect(f.writes).toEqual(['fill:甲', 'text:乙']);
});

test('子文档仍保留activeElement但实际焦点已在外层时不继续输入', async () => {
  const f = fixture();
  const frame = vi
    .spyOn(window, 'frameElement', 'get')
    .mockReturnValue(document.createElement('iframe'));
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  try {
    await expect(
      fillRichText(f.page, f.locator, '首行\n第二行', () => Promise.resolve()),
    ).rejects.toThrow('EXECUTION_CAPABILITY_REVOKED_OR_DENIED');
    expect(f.writes).toEqual(['fill:首行']);
  } finally {
    frame.mockRestore();
    focus.mockRestore();
  }
});
