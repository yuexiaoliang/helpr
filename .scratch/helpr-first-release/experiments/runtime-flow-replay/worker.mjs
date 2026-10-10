import { mkdir, readFile, writeFile, appendFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { loadConfig, createClient } from '../model-api/client.mjs';
import { observe, execute, locate, bind, parameterize, plannerInstruction } from './engine.mjs';
import { verifyPublication } from './verify.mjs';

const mode = process.argv[2], root = path.resolve(process.argv[3]);
if (!['learn', 'replay', 'repair', 'updated'].includes(mode)) throw new Error('invalid-mode');
const directory = path.join(root, mode), runId = path.basename(root);
await mkdir(directory, { recursive: true });
const fileName = `${mode}-${runId}.xlsx`, filePath = path.join(directory, fileName);
await copyFile(`materials/${mode}.xlsx`, filePath);
const params = {
  origin: 'http://home.ts-ali.internal:38080',
  entryUrl: 'http://home.ts-ali.internal:38080/wp-admin/',
  title: `流程复用实验 ${mode} ${runId}`,
  body: `此文及附件均为虚构测试数据。批次 ${mode}，实验 ${runId}。`,
  category: 'Excel 验证', filePath, fileName, fileStem: fileName.replace(/\.xlsx$/, '')
};
const goal = '在已登录的测试后台新建一篇文章，标题为 {{title}}，正文为 {{body}}，把本次 {{filePath}} 上传并加入正文供读者下载，分类为 {{category}}（不选 Uncategorized）。发布文章并取得实际公开文章链接。所有内容和本次发布都已经授权。这不是更新已有文章。';
const result = { mode, runId, pid: process.pid, startedAt: new Date().toISOString(), params,
  modelPurposeCounts: { understanding: 0, content: 0, exploration: 0, replay: 0, repair: 0 }, modelCalls: [], actions: [], failures: [] };
result.runtime = { node: process.version, platform: process.platform, arch: process.arch };
result.sourceHashes = Object.fromEntries(await Promise.all(['worker.mjs', 'engine.mjs', 'verify.mjs', '../model-api/client.mjs'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const allowModel = mode === 'learn' || mode === 'repair';
let request;
if (allowModel) {
  const { config, apiKey } = await loadConfig('../model-api/config.example.json', '../model-api/.env.local');
  config.requestOptions = { ...config.requestOptions, max_tokens: 1500 };
  result.modelConfig = config;
  request = createClient(config, apiKey, result.modelCalls).request;
} else {
  // 冷重放进程不加载 Key，也不能回退到模型。违反即实验失败。
  request = () => { throw new Error('model-disabled-during-replay'); };
}
let page, browser, candidate;
let stopRequested = false;
process.on('SIGTERM', () => { stopRequested = true; });
process.on('SIGINT', () => { stopRequested = true; });
const journal = async row => appendFile(path.join(directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
async function plan(purpose, snapshot, failedAction) {
  if (stopRequested) throw new Error('experiment-stopped');
  result.modelPurposeCounts[purpose]++;
  const input = { goal, params, history: result.actions.slice(-16), recentFailures: result.failures.slice(-3),
    lastFailure: result.failures.at(-1),
    ...(failedAction ? { instruction: '只替换这一条失败动作，保持原意图。', failedAction } : {}), currentPage: snapshot };
  const answer = await request(`${purpose}-${result.modelPurposeCounts[purpose]}`, {
    messages: [{ role: 'system', content: plannerInstruction }, { role: 'user', content: JSON.stringify(input) }],
    response_format: { type: 'json_object' }, temperature: 0
  });
  const decision = JSON.parse(answer.content);
  await journal({ type: 'decision', purpose, input, decision });
  return { ...decision, action: parameterize(decision.action, params) };
}

// 受控 UI 变更只发生在测试层。目标从原始学习记录中取得，不写入通用执行器。
async function applyFixtureChange(original) {
  const step = original.steps.find(step => step.action.op === 'fill' && step.action.value === '{{title}}');
  if (!step) throw new Error('no-title-step-for-mutation');
  const target = locate(page, bind(step.action.target, params));
  await target.waitFor({ state: 'visible', timeout: 18000 });
  const before = await target.evaluate(el => ({ label: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), role: el.getAttribute('role') }));
  await target.evaluate(el => {
    el.setAttribute('aria-label', '文章标题（新版）');
    if (el.hasAttribute('placeholder')) el.setAttribute('placeholder', '文章标题（新版）');
    if (el.hasAttribute('data-placeholder')) el.setAttribute('data-placeholder', '文章标题（新版）');
  });
  const mutation = { target: step.action.target, before, afterLabel: '文章标题（新版）', scope: '当前测试页面的标题控件属性；未修改服务器或站点代码' };
  await journal({ type: 'fixture-change', ...mutation });
  result.fixtureChange = mutation;
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'private/auth.json', viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  result.pageIdentity = { context: 'new-context-per-process', initialPageCount: context.pages().length, browserVersion: browser.version() };
  await page.goto(params.entryUrl, { waitUntil: 'domcontentloaded' });
  if (!page.url().startsWith(params.entryUrl)) throw new Error('test-login-not-ready');
  let finished;
  if (mode === 'learn') {
    candidate = { schema: 1, version: 1, entryUrl: '{{entryUrl}}', origin: '{{origin}}',
      requiredParams: Object.keys(params), goal, createdAt: new Date().toISOString(), source: 'live-model-exploration', steps: [] };
    for (let i = 0; i < 55 && !finished; i++) {
      const snapshot = await observe(page), decision = await plan('exploration', snapshot);
      console.log(JSON.stringify({ mode, step: i, action: decision.action, note: decision.note }));
      try {
        const outcome = await execute(page, decision.action, params);
        const row = { action: decision.action, intent: decision.note, urlBefore: snapshot.url, urlAfter: page.url(), outcome };
        candidate.steps.push({ action: decision.action, intent: decision.note });
        result.actions.push(row); await journal({ type: 'success', ...row });
        finished = outcome.resultUrl;
      } catch (error) {
        const failure = { action: decision.action, message: error.message.slice(0, 1800), pageUrl: page.url() };
        result.failures.push(failure); await journal({ type: 'failure', ...failure });
        console.log(JSON.stringify({ mode, failure }));
        if (result.failures.length >= 8) throw new Error('exploration-failure-limit');
      }
    }
    if (!finished) throw new Error('exploration-step-limit');
  } else {
    const sourcePath = path.join(root, mode === 'updated' ? 'workflow-v2.json' : 'workflow-v1.json');
    const source = await readFile(sourcePath);
    candidate = JSON.parse(source);
    result.loadedWorkflow = { path: sourcePath, version: candidate.version, sha256: createHash('sha256').update(source).digest('hex') };
    for (const name of candidate.requiredParams) if (!(name in params)) throw new Error('missing-parameter:' + name);
    const original = mode === 'updated' ? JSON.parse(await readFile(path.join(root, 'workflow-v1.json'))) : candidate;
    for (let i = 0; i < candidate.steps.length; i++) {
      let step = candidate.steps[i];
      if (['repair', 'updated'].includes(mode) && step.action.op === 'fill' && step.action.value === '{{title}}') await applyFixtureChange(original);
      console.log(JSON.stringify({ mode, step: i, action: step.action }));
      let outcome;
      try { outcome = await execute(page, step.action, params); }
      catch (error) {
        const failure = { step: i, action: step.action, message: error.message.slice(0, 1800), pageUrl: page.url() };
        result.failures.push(failure); await journal({ type: 'failure', ...failure });
        if (mode !== 'repair') throw error;
        const decision = await plan('repair', await observe(page), step);
        // 原流程保持不变。候选版本只有实际结果核对成功后才写入新版本文件。
        outcome = await execute(page, decision.action, params);
        result.repair = { index: i, old: step, replacement: decision, promotedAfterVerification: false };
        step = { action: decision.action, intent: decision.note };
        candidate.steps[i] = step;
      }
      result.actions.push({ index: i, action: step.action, outcome, pageUrl: page.url() });
      await journal({ type: 'success', ...result.actions.at(-1) });
      finished = outcome.resultUrl || finished;
    }
    if (!finished) throw new Error('workflow-missing-result');
  }
  result.publication = await verifyPublication(browser, finished, params, directory);
  if (mode === 'learn') await writeFile(path.join(root, 'workflow-v1.json'), JSON.stringify(candidate, null, 2) + '\n');
  if (mode === 'repair') {
    if (!result.repair) throw new Error('expected-repair-not-triggered');
    candidate.version = 2;
    candidate.parent = result.loadedWorkflow;
    candidate.verifiedBy = result.publication;
    candidate.updatedAt = new Date().toISOString();
    await writeFile(path.join(root, 'workflow-v2.json'), JSON.stringify(candidate, null, 2) + '\n');
    result.repair.promotedAfterVerification = true;
  }
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = { name: error.name, message: error.message.slice(0, 4000) };
  if (page) {
    await writeFile(path.join(directory, 'failure-page.json'), JSON.stringify(await observe(page), null, 2)).catch(() => {});
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  result.endedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  await browser?.close();
  console.log(JSON.stringify({ mode, passed: result.passed, modelPurposeCounts: result.modelPurposeCounts, publication: result.publication, error: result.error }));
}
