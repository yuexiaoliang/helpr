// 用已有真实学习序列采集条件的正反样本；是测试准备，不执行发布。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { execute, observe, locate, bind } from '../runtime-flow-replay/engine.mjs';
import { checkAll } from './executor.mjs';
import { hash } from './contract.mjs';

const directory = path.resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const flow = JSON.parse(await readFile('../runtime-flow-replay/artifacts/2026-10-10T10-25-45-629Z/workflow-v1.json'));
const fileName = 'condition-witness-' + path.basename(directory) + '.xlsx', filePath = directory + '/' + fileName;
await copyFile('../runtime-flow-replay/materials/replay.xlsx', filePath);
const params = { origin: 'http://home.ts-ali.internal:38080', entryUrl: 'http://home.ts-ali.internal:38080/wp-admin/',
  title: 'File', body: '这是候选条件的虚构正文。不能把固定搜索词 File 当作标题引用。', category: 'Excel 验证', filePath, fileName, fileStem: fileName.replace(/\.xlsx$/, '') };
const browser = await chromium.launch({ headless: true });
const evidence = { params, snapshots: [], source: 'previously-learned-runtime-steps', publishes: 0, events: [] };
const candidate = process.argv[3] ? JSON.parse(await readFile(process.argv[3])) : undefined;
const task = { origin: params.origin, inputs: {
  title: { type: 'string', value: params.title }, body: { type: 'string', value: params.body }, category: { type: 'string', value: params.category },
  file: { type: 'file', path: filePath, name: fileName, stem: params.fileStem, sha256: hash(await readFile(filePath)) }
} };
async function evaluate(page, checks) {
  try { return { passed: true, evidence: await checkAll(page, checks, task, directory, () => {}, 0) }; }
  catch (e) { return { passed: false, error: e.code, evidence: e.detail?.evidence }; }
}
let page;
try {
  const context = await browser.newContext({ storageState: '../runtime-flow-replay/private/auth.json', viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('requestfailed', req => evidence.events.push({ type: 'request-failed', at: new Date().toISOString(), pathname: new URL(req.url()).pathname, error: req.failure()?.errorText }));
  let release, held;
  const heldSignal = new Promise(r => { held = r; });
  const gate = new Promise(r => { release = r; });
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST' && (req.headers()['content-type'] || '').startsWith('multipart/form-data')) { held(); await gate; }
    await route.continue().catch(() => {});
  });
  await page.goto(params.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  async function capture(phase) {
    const snapshot = await observe(page);
    snapshot.dom = [];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && !frame.name()) continue;
      snapshot.dom.push({ frame: frame.name() || 'main', fields: await frame.locator('h1,p,[contenteditable="true"],input,select,textarea,[role="status"],.components-notice').evaluateAll(els => els.filter(el => el.getClientRects().length)
        .map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label'), classes: el.className,
          type: el.getAttribute('type'), dataType: el.getAttribute('data-type'), value: 'value' in el ? el.value : el.textContent,
          html: el.outerHTML.slice(0, 1400) })).slice(0, 70)) });
    }
    evidence.snapshots.push({ phase, snapshot });
  }
  for (const step of flow.steps) {
    if (step.action.op === 'click' && step.action.target.name === 'Publish') break;
    if (step.action.op === 'wait') continue;
    evidence.events.push({ type: 'action-start', at: new Date().toISOString(), action: step.action });
    if (step.action.op === 'click' && step.action.target.role === 'link') {
      await locate(page, bind(step.action.target, params)).click({ timeout: 60000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    } else await execute(page, step.action, params);
    evidence.events.push({ type: 'action-end', at: new Date().toISOString() });
    if (step.action.op === 'fill' && step.action.value === '{{title}}') await capture('title-filled');
    if (step.action.op === 'upload') {
      await Promise.race([heldSignal, new Promise((_, reject) => setTimeout(() => reject(new Error('no-upload-request')), 15000))]);
      await capture('upload-pending');
      evidence.oldChecksWhilePending = await evaluate(page, flow.steps.filter(s => s.action.op === 'wait').map(s => ({ kind: 'visible', target: s.action.target })));
      if (candidate) evidence.candidateChecksWhilePending = await evaluate(page, candidate.commitChecks);
      release();
      await page.getByText('Upload complete', { exact: true }).waitFor({ timeout: 15000 });
      await capture('upload-complete');
      if (candidate) evidence.candidateChecksWhenComplete = await evaluate(page, candidate.commitChecks);
      await page.screenshot({ path: directory + '/complete.png', fullPage: true });
    }
  }
  evidence.passed = candidate ? evidence.oldChecksWhilePending.passed && !evidence.candidateChecksWhilePending.passed && evidence.candidateChecksWhenComplete.passed : true;
} catch (error) {
  evidence.error = { name: error.name, message: error.message.slice(0, 1500) };
  if (page) { evidence.failure = await observe(page); await page.screenshot({ path: directory + '/failure.png' }).catch(() => {}); }
  process.exitCode = 1;
}
finally { await writeFile(directory + '/evidence.json', JSON.stringify(evidence, null, 2)); await browser.close(); }
console.log(JSON.stringify({ directory, passed: evidence.passed, phases: evidence.snapshots.map(s => s.phase), error: evidence.error }));
