import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execute } from './engine.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });
const resultAction = { op: 'finish', target: { by: 'role', role: 'link', name: '查看结果' } };

test('正文变化导致可访问名称改变，不应丢失已成功输入的记录', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<p contenteditable="true" role="textbox" aria-label="空白" oninput="this.setAttribute(\'aria-label\', \'正文\')"></p>');
    await execute(page, { op: 'fill', target: { by: 'role', role: 'textbox', name: '空白' }, value: '{{body}}' }, { body: '新的正文', origin: 'null' });
    assert.equal(await page.getByRole('textbox', { name: '正文' }).innerText(), '新的正文');
  } finally { await page.close(); }
});

test('相同结果的双重提示可合并读取', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<a href="https://fixture.invalid/?id=1">查看结果</a><a href="https://fixture.invalid/?id=1">查看结果</a>');
    const result = await execute(page, resultAction, { origin: 'https://fixture.invalid' });
    assert.equal(result.resultUrl, 'https://fixture.invalid/?id=1');
    assert.equal(result.matchingResultLinks, 2);
  } finally { await page.close(); }
});

test('同名链接指向不同结果时拒绝认定成功', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<a href="https://fixture.invalid/?id=1">查看结果</a><a href="https://fixture.invalid/?id=2">查看结果</a>');
    await assert.rejects(execute(page, resultAction, { origin: 'https://fixture.invalid' }), /result-links-disagree/);
  } finally { await page.close(); }
});

test('同名写入目标存在歧义时，不点击其中任意一个', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button onclick="window.wrote=true">提交</button><button onclick="window.wrote=true">提交</button>');
    await assert.rejects(execute(page, { op: 'click', target: { by: 'role', role: 'button', name: '提交' } }, { origin: 'null' }), /strict mode violation/);
    assert.equal(await page.evaluate(() => window.wrote), undefined);
  } finally { await page.close(); }
});
