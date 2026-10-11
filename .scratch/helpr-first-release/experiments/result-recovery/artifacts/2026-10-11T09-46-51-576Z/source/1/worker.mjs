// 一次性实验：重放既有动作与数据化条件；不包含站点发布接口或结果查询接口。
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../runtime-flow-replay/node_modules/playwright/index.mjs';
import { execute, observe } from '../runtime-flow-replay/engine.mjs';
import { locate, checkAll } from '../workflow-reliability/executor.mjs';
import { bind } from '../workflow-reliability/contract.mjs';
import { directory, authFile, load, save, hash, ensure, event, readRecord, saveRecord } from './common.mjs';

const contract = await load(path.join(directory, 'recovery-contract.json'));
const flow = await load(path.join(directory, 'workflow.json'));
const send = value => process.send?.(value);
const halt = async phase => { send({ checkpoint: phase }); await new Promise(() => {}); };
const canonical = value => { const url = new URL(value); url.searchParams.sort(); return url.href; };

async function draftReady(page, task, root) {
  await checkAll(page, contract.draftChecks, task, root, () => ensure(new URL(page.url()).origin === task.origin, 'draft-origin'), 15000);
  const rule = bind(contract.draftArtifact, task.inputs);
  const target = locate(page, rule.target);
  const end = Date.now() + 20000;
  do {
    if (await target.count() === 1) {
      const href = await target.getAttribute('href');
      if (href && new URL(href, page.url()).origin === task.origin) {
        const response = await page.request.get(new URL(href, page.url()).href, { timeout: 10000 });
        if (response.ok() && hash(await response.body()) === rule.expected) return { artifactUrl: new URL(href, page.url()).href, sha256: rule.expected };
      }
    }
    await delay(150);
  } while (Date.now() < end);
  throw new Error('draft-artifact-not-confirmed');
}

async function collect(page, root) {
  try { await page.screenshot({ path: path.join(root, 'page.png'), fullPage: true, timeout: 4000 }); await save(path.join(root, 'capture.json'), { status: 'passed' }); }
  catch (error) { await save(path.join(root, 'capture.json'), { status: 'failed', error: error.name }); }
}

async function recover(browser, page, task, record, root, options) {
  const searchRoot = bind(contract.rows, task.inputs);
  ensure(new URL(contract.listUrl).origin === task.origin, 'list-origin');
  await page.goto(contract.listUrl, { waitUntil: 'domcontentloaded' });
  await locate(page, contract.search).fill(task.inputs.post_title.value);
  await locate(page, contract.searchButton).click();
  await page.waitForLoadState('domcontentloaded');
  const rows = locate(page, searchRoot), candidates = [];
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i), edit = locate(row, bind(contract.editLink, task.inputs));
    if (await edit.count() !== 1) continue;
    const href = await edit.getAttribute('href');
    if (!href) continue;
    const editorUrl = new URL(href, page.url()).href;
    const view = locate(row, bind(contract.viewLink, task.inputs));
    const resultHref = await view.count() === 1 ? await view.getAttribute('href') : undefined;
    candidates.push({ editorUrl, text: await row.innerText(), resultUrl: resultHref ? new URL(resultHref, page.url()).href : null });
  }
  await save(path.join(root, 'candidates.json'), candidates);
  const own = candidates.filter(c => canonical(c.editorUrl) === canonical(record.editorUrl));
  const base = { taskId: task.id, executionId: task.executionId, intent: record.intent, previousPhase: record.phase,
    candidates, decision: 'uncertain', automaticAction: 'none', pid: process.pid };
  if (own.length !== 1) return { ...base, reason: 'record-not-uniquely-observed' };
  const candidate = own[0];
  if (candidate.resultUrl || options.resultUrl) {
    const url = options.resultUrl || candidate.resultUrl;
    ensure(new URL(url).origin === task.origin, 'result-origin');
    const context = await browser.newContext({ acceptDownloads: true }), publicPage = await context.newPage();
    try {
      await publicPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      ensure(new URL(publicPage.url()).origin === task.origin, 'result-origin');
      const evidence = await checkAll(publicPage, contract.resultChecks, task, root, () => {}, 1500);
      const outcome = { ...base, decision: record.intent === 'running' ? 'completed' : 'held', observedEffect: 'completed', resultUrl: url, evidence };
      await save(path.join(root, 'result.json'), outcome);
      await collect(publicPage, root);
      return outcome;
    } catch (error) { return { ...base, resultUrl: url, reason: 'result-not-confirmed', error: error.code || error.message, detail: error.detail }; }
    finally { await context.close(); }
  }
  // 本地已派发的记录，即便页面显示草稿，也不证明旧请求永远不会生效。
  if (record.phase !== 'prepared') return { ...base, reason: 'dispatch-may-have-happened' };
  if (!candidate.text.includes(contract.draftText)) return { ...base, reason: 'draft-state-not-confirmed' };
  await page.goto(candidate.editorUrl, { waitUntil: 'domcontentloaded' });
  try {
    const evidence = await draftReady(page, task, root);
    return { ...base, observedEffect: 'draft-ready', editorUrl: candidate.editorUrl, evidence,
      decision: record.intent === 'running' ? 'ready-to-continue' : 'held',
      automaticAction: record.intent === 'running' ? 'resume-final-step-only' : 'none' };
  } catch (error) { return { ...base, reason: 'draft-not-confirmed', error: error.code || error.message, detail: error.detail }; }
}

process.once('message', async options => {
  const { root, output, mode, proxy, stopAt } = options;
  await mkdir(output, { recursive: true });
  let browser;
  try {
    const { record, task } = await readRecord(root);
    browser = await chromium.launch({ headless: true, proxy: { server: proxy } });
    const context = await browser.newContext({ storageState: authFile, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const cdp = await browser.newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    send({ browserPids: processes.processInfo.map(p => p.id) }); await cdp.detach();
    await event(output, { type: 'start', mode, taskId: task.id, executionId: task.executionId, versions: { chromium: browser.version(), node: process.version } });
    if (mode === 'recover') {
      const outcome = await recover(browser, page, task, record, output, options);
      await save(path.join(output, 'result.json'), outcome);
      send({ result: outcome });
    } else {
      ensure(record.intent === 'running', 'intent-blocks-execution');
      if (mode === 'prepare') {
        ensure(record.phase === 'preparing', 'case-already-started');
        await page.goto(task.entryUrl, { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < contract.prepareSteps; i++) {
          await event(output, { type: 'step-start', index: i }); send({ progress: i });
          await execute(page, flow.steps[i].action, task.params);
          await event(output, { type: 'step-complete', index: i });
        }
        await draftReady(page, task, output);
        // 为恢复实验增加的准备动作，来自网页 Save draft；不改已学流程。
        await execute(page, contract.saveDraft, task.params);
        await page.waitForURL(url => url.searchParams.has(contract.savedRecordQuery), { timeout: 20000 });
        await page.waitForLoadState('networkidle');
        await draftReady(page, task, output);
        record.phase = 'prepared'; record.editorUrl = page.url(); record.lastCompletedStep = contract.prepareSteps - 1;
        await saveRecord(root, record);
        await save(path.join(output, 'prepared-observation.json'), await observe(page));
        if (stopAt === 'prepared') await halt('prepared');
      } else {
        ensure(mode === 'resume' && record.phase === 'prepared', 'not-resumable');
        const verdict = await recover(browser, page, task, record, output, options);
        await save(path.join(output, 'pre-resume-check.json'), verdict);
        ensure(verdict.decision === 'ready-to-continue', 'resume-not-confirmed');
      }
      await execute(page, flow.steps[contract.publishSteps[0]].action, task.params);
      record.phase = 'dispatching'; record.lastCompletedStep = contract.publishSteps[0];
      await saveRecord(root, record);
      if (stopAt === 'dispatch-gap') await halt('dispatch-gap');
      await execute(page, flow.steps[contract.publishSteps[1]].action, task.params);
      const result = await execute(page, flow.steps[contract.finishStep].action, task.params);
      record.phase = 'observed'; record.resultUrl = result.resultUrl;
      await saveRecord(root, record);
      await save(path.join(output, 'observed.json'), { ...result, observation: await observe(page) });
      if (stopAt === 'observed') await halt('observed');
      send({ result: { taskId: task.id, phase: record.phase, resultUrl: result.resultUrl } });
    }
  } catch (error) {
    const failure = { error: error.code || error.name, message: error.message, detail: error.detail };
    await save(path.join(output, 'failure.json'), failure); send({ failure }); process.exitCode = 1;
  } finally { await browser?.close(); process.disconnect?.(); }
});
