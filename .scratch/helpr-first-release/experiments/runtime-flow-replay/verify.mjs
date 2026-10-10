import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// 结果核验属于这个测试用例的断言，不是执行器里的网站操作流程。
export async function verifyPublication(browser, url, params, directory) {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: params.title, level: 1, exact: true }).waitFor();
    const text = await page.locator('body').innerText();
    if (!text.includes(params.body) || !text.includes(params.category)) throw new Error('public-content-mismatch');
    const links = await page.locator('a[href]').evaluateAll(elements => elements.map(el => ({ href: el.href, download: el.hasAttribute('download') })));
    const candidates = [...new Set(links.filter(link => new URL(link.href).pathname.endsWith('.xlsx')).map(link => link.href))];
    if (candidates.length !== 1) throw new Error('expected-one-published-attachment');
    const attachmentUrl = candidates[0];
    if (new URL(attachmentUrl).origin !== params.origin) throw new Error('attachment-origin-mismatch');
    const downloadLink = page.locator('a[download]').filter({ visible: true });
    if (await downloadLink.count() !== 1) throw new Error('expected-one-download-control');
    const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
    const output = directory + '/download.xlsx';
    await download.saveAs(output);
    const source = await readFile(params.filePath), actual = await readFile(output);
    if (!source.equals(actual)) throw new Error('published-file-bytes-mismatch');
    await page.screenshot({ path: directory + '/public.png', fullPage: true });
    return { verified: true, unauthenticatedContext: true, url: page.url(), title: params.title, body: params.body,
      category: params.category, attachmentUrl, downloadedName: download.suggestedFilename(),
      sourceBytes: source.length, downloadedBytes: actual.length,
      sha256: createHash('sha256').update(actual).digest('hex'), exactBytesMatch: true };
  } finally { await context.close(); }
}
