// 采集已完成的页面；此文件不参与功能结果的兼容性判断。
export async function collectScreenshots(host, name, directory) {
  const pages = host.pages.map((page, index) => ({ page, file: ['A', 'B'][index] + '.png' }));
  if (name === 'parallel-exploration') {
    pages.push(...host.control.contexts().flatMap(c => c.pages()).filter(p => p.url().includes('/result'))
      .map((page, index) => ({ page, file: 'result-' + index + '.png' })));
  }
  const evidence = [];
  for (const { page, file } of pages) {
    try {
      if (host.app) {
        const cdp = await page.context().newCDPSession(page);
        let targetId; try { targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await cdp.detach(); }
        await host.app.evaluate(({ BrowserWindow, webContents }, id) => {
          global.aiLab.show('split'); const wc = webContents.fromDevToolsTargetId(id);
          if (wc) BrowserWindow.fromWebContents(wc)?.showInactive();
        }, targetId);
      } else await page.bringToFront();
      await page.screenshot({ path: directory + '/' + file, timeout: 4000 });
      evidence.push({ file, ok: true });
    } catch (error) { evidence.push({ file, ok: false, error: error.message }); }
  }
  if (evidence.some(r => !r.ok)) throw Object.assign(new Error('screenshot-capture-failed'), { evidence });
  return evidence;
}
