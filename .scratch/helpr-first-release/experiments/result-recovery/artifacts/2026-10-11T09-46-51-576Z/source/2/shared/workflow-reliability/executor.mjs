import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { observe } from '../runtime-flow-replay/engine.mjs';
import { Fault, hash, bind, validateWorkflow, validateMaterials, applyRepair } from './contract.mjs';

export function locate(page, target) {
  const frame = target.frame && target.frame !== 'main' ? page.frameLocator('iframe[name=' + JSON.stringify(target.frame) + ']') : page;
  const root = target.within ? locate(page, { ...target.within, frame: target.frame }) : frame;
  switch (target.by) {
    case 'role': return root.getByRole(target.role, { name: target.name, exact: true, ...(target.level ? { level: target.level } : {}) });
    case 'label': return root.getByLabel(target.name, { exact: true });
    case 'placeholder': return root.getByPlaceholder(target.name, { exact: true });
    case 'text': return root.getByText(target.name, { exact: true });
    case 'css': return root.locator(target.selector);
    default: throw new Fault('invalid-locator');
  }
}

async function unique(page, spec, task, { hidden = false, timeout = 12000 } = {}) {
  const target = locate(page, bind(spec, task.inputs));
  try { await target.waitFor({ state: hidden ? 'attached' : 'visible', timeout }); }
  catch (error) { throw new Fault('target-unavailable', { target: spec, reason: error.message.slice(0, 300) }); }
  if (await target.count() !== 1) throw new Fault('target-ambiguous', { target: spec });
  const origin = await target.evaluate(el => el.ownerDocument.defaultView.origin);
  if (origin !== task.origin) throw new Fault('target-origin-mismatch');
  return target;
}

async function check(page, condition, task, directory) {
  const c = bind(condition, task.inputs), target = locate(page, c.target), count = await target.count();
  if (c.kind === 'absent') return { ok: count === 0 || (count === 1 && !(await target.isVisible())), count };
  // 存在性条件只要求至少一个可见对象；值读取与写动作仍要求唯一。
  if (c.kind === 'visible') return { ok: count > 0 && await target.filter({ visible: true }).count() > 0, count };
  if (count !== 1) return { ok: false, count };
  if (c.kind === 'checked') return { ok: (await target.isChecked()) === c.expected, actual: await target.isChecked() };
  if (c.kind === 'download') {
    const href = await target.getAttribute('href');
    if (!href || new URL(href, page.url()).origin !== task.origin) return { ok: false, reason: 'download-origin' };
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), target.click({ timeout: 1500 })]);
    const output = directory + '/runtime-download.bin';
    await download.saveAs(output);
    const actual = hash(await readFile(output));
    return { ok: actual === c.expected, actual, downloadedName: download.suggestedFilename() };
  }
  const actual = c.kind === 'text' ? (await target.innerText()).trim()
    : c.kind === 'value' ? await target.evaluate(el => 'value' in el ? el.value : el.textContent)
    : await target.getAttribute(c.attribute);
  const expected = c.expected;
  const ok = c.compare === 'originEquals' ? typeof actual === 'string' && new URL(actual, page.url()).origin === expected
    : c.compare === 'equals' ? actual === expected
    : typeof actual === 'string' && typeof expected === 'string' && (c.compare === 'contains' ? actual.includes(expected) : actual.startsWith(expected));
  return { ok, actual, expected };
}

export async function checkAll(page, checks, task, directory, guard, timeout) {
  const start = performance.now();
  let evidence;
  do {
    guard();
    evidence = [];
    for (const condition of checks) {
      guard();
      let outcome;
      try { outcome = await check(page, condition, task, directory); }
      catch (error) { outcome = { ok: false, error: error.name }; }
      evidence.push({ condition, ...outcome });
    }
    if (evidence.every(e => e.ok)) return evidence;
    // 下载是真实读操作，不能在条件轮询中反复触发。
    if (checks.some(c => c.kind === 'download') || performance.now() - start >= timeout) break;
    await delay(100);
  } while (true);
  throw new Fault('condition-unsatisfied', { evidence });
}

// 探路提出的候选、复用与修复均通过这个实验 Interface 执行动作与检查。
// task 是测试驱动提供的已解析委托与授权；本实验没有实现用户参与界面。
export async function runWorkflow({ browser, page, workflow, task, directory, signal, onEvent = async () => {}, repair, conditionTimeout = 12000, targetTimeout = conditionTimeout }) {
  const frozenTask = structuredClone(task), initialTaskDigest = hash(frozenTask);
  let candidate = structuredClone(workflow), currentStep, commitDispatched = false, resultUrl;
  const sourceHash = hash(candidate), events = [], repairs = [];
  const emit = async event => { const row = { at: new Date().toISOString(), ...event }; events.push(row); await onEvent(row); };
  const guard = () => {
    if (signal?.aborted) throw new Fault('execution-stopped', {}, 'stopped');
    if (hash(task) !== initialTaskDigest) throw new Fault('task-changed', {}, 'needs-participation');
    if (page.isClosed() || new URL(page.url()).origin !== frozenTask.origin) throw new Fault('page-origin-mismatch');
  };
  async function perform(step) {
    guard();
    const action = bind(step.action, frozenTask.inputs);
    if (action.op === 'finish') {
      const before = await checkAll(page, step.before, frozenTask, directory, guard, conditionTimeout);
      const target = locate(page, action.target);
      await target.first().waitFor({ state: 'visible', timeout: conditionTimeout });
      guard();
      const links = await target.evaluateAll(els => els.map(el => el.getAttribute('href')));
      if (links.some(h => !h)) throw new Fault('result-link-missing');
      const urls = [...new Set(links.map(h => new URL(h, page.url()).href))];
      if (urls.length !== 1 || new URL(urls[0]).origin !== frozenTask.origin) throw new Fault('result-link-ambiguous');
      resultUrl = urls[0];
      const after = await checkAll(page, step.after, frozenTask, directory, guard, conditionTimeout);
      return { resultUrl, before, after };
    }
    const target = await unique(page, step.action.target, frozenTask, { hidden: action.op === 'upload', timeout: targetTimeout });
    const before = await checkAll(page, step.before, frozenTask, directory, guard, conditionTimeout);
    if (step.effect === 'commit') {
      await validateMaterials(frozenTask);
      const evidence = await checkAll(page, candidate.commitChecks, frozenTask, directory, guard, conditionTimeout);
      await emit({ type: 'commit-checked', step: step.id, evidence });
    }
    guard();
    if (await target.count() !== 1) throw new Fault('target-ambiguous');
    const href = await target.getAttribute('href');
    if (action.op === 'click' && href && new URL(href, page.url()).origin !== frozenTask.origin) throw new Fault('navigation-outside-origin');
    // 日志回调后再次检查，迟到提议或停止不得进入下一次浏览器调用。
    await emit({ type: 'dispatch', step: step.id, action, effect: step.effect });
    guard();
    if (step.effect === 'commit') commitDispatched = true;
    const options = { timeout: 45000 };
    switch (action.op) {
      case 'hover': await target.hover(options); break;
      case 'click': await target.click(options); break;
      case 'fill': await target.fill(action.value, options); break;
      case 'check': await target.setChecked(action.value, options); break;
      case 'select': await target.selectOption({ label: action.value }, options); break;
      case 'press': await target.press(action.value, options); break;
      case 'upload': {
        await validateMaterials(frozenTask);
        if (!Object.values(frozenTask.inputs).some(v => v.type === 'file' && v.path === action.value)) throw new Fault('unapproved-material');
        guard(); await target.setInputFiles(action.value, options); break;
      }
      case 'wait': break;
      default: throw new Fault('unsupported-operation');
    }
    if (action.op === 'click' && href) await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    guard();
    const after = await checkAll(page, step.after, frozenTask, directory, guard, conditionTimeout);
    return { before, after };
  }
  try {
    guard(); validateWorkflow(candidate, frozenTask); await validateMaterials(frozenTask);
    const evidence = await checkAll(page, candidate.entryChecks, frozenTask, directory, guard, conditionTimeout);
    await emit({ type: 'eligible', sourceHash, evidence });
    for (let i = 0; i < candidate.steps.length; i++) {
      currentStep = candidate.steps[i];
      await emit({ type: 'step-start', step: currentStep.id });
      let outcome;
      try { outcome = await perform(currentStep); }
      catch (error) {
        if (!repair || !['target-unavailable', 'target-ambiguous'].includes(error.code) || commitDispatched) throw error;
        const patch = await repair({ step: currentStep, error: { code: error.code, detail: error.detail }, page: await observe(page) });
        guard();
        if (patch.stepId !== currentStep.id) throw new Fault('repair-step-mismatch');
        const next = applyRepair(candidate, patch); validateWorkflow(next, frozenTask);
        repairs.push({ patch, parentHash: hash(candidate) }); candidate = next;
        currentStep = candidate.steps[i];
        outcome = await perform(currentStep);
      }
      await emit({ type: 'step-completed', step: currentStep.id, outcome });
    }
    if (!resultUrl) throw new Fault('no-result');
    guard();
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const publicPage = await context.newPage();
      await publicPage.goto(resultUrl, { waitUntil: 'domcontentloaded' });
      if (new URL(publicPage.url()).origin !== frozenTask.origin) throw new Fault('result-origin-mismatch');
      await publicPage.locator('body').waitFor({ state: 'visible' });
      const evidence = await checkAll(publicPage, candidate.resultChecks, frozenTask, directory, guard, conditionTimeout);
      await emit({ type: 'result-verified', resultUrl, evidence });
      await publicPage.screenshot({ path: directory + '/runtime-result.png', fullPage: true });
    } finally { await context.close(); }
    guard();
    return { status: 'completed', resultUrl, sourceHash, events, repairs,
      qualified: { ...candidate, version: (workflow.version || 0) + (repairs.length ? 1 : 0), parentHash: repairs.length ? sourceHash : candidate.parentHash,
        evidence: { taskId: frozenTask.id, taskDigest: initialTaskDigest, resultUrl } } };
  } catch (error) {
    return { status: error.status === 'stopped' ? 'stopped' : commitDispatched ? 'outcome-unknown' : error.status || 'blocked',
      error: { code: error.code || error.name, detail: error.detail || { message: error.message.slice(0, 500) } },
      step: currentStep?.id, resultUrl, sourceHash, commitDispatched, repairs, events };
  }
}
