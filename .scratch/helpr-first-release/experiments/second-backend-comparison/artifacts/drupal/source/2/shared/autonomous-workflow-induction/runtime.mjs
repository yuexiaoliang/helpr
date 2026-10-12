// 一次性实验的通用执行 Interface。无网站名称、字段名或网站操作路径。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { observe } from '../runtime-flow-replay/engine.mjs';
import { bind, hash, Fault, validateMaterials } from '../workflow-reliability/contract.mjs';
import { locate, checkAll } from '../workflow-reliability/executor.mjs';

export { hash, Fault, bind, locate, checkAll };
export const ensure = (test, code, detail = {}) => { if (!test) throw new Fault(code, detail); };
export const save = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');

export async function snapshot(page) {
  const result = await observe(page);
  for (const f of result.frames) {
    if (!f.frame) continue;
    f.aria = f.aria?.slice(0, 11500);
    f.controls = f.controls?.slice(0, 110);
    const frame = f.frame === 'main' ? page.mainFrame() : page.frame({ name: f.frame });
    if (!frame) continue;
    f.fields = await frame.locator('h1,h2,p,input,textarea,select,a[href],[contenteditable="true"],[role="status"]')
      .evaluateAll(els => els.filter(el => el.getClientRects().length && !['password', 'hidden'].includes(el.getAttribute('type')))
        .slice(0, 100).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
          label: el.getAttribute('aria-label'), type: el.getAttribute('type'), classes: el.getAttribute('class'),
          dataType: el.getAttribute('data-type'), value: ('value' in el ? el.value : el.textContent)?.slice(0, 700),
          href: el.getAttribute('href')?.replace(/([?&](?:_wpnonce|_ajax_nonce|nonce)=)[^&\s]+/g, '$1[redacted]')
        })));
  }
  return result;
}

export function compactSnapshot(value) {
  return { url: value.url, frames: value.frames.map(f => ({ frame: f.frame,
    fields: f.fields?.filter(q => q.tag !== 'a').map(q => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== null && v !== undefined))),
    aria: f.aria?.slice(0, 6500),
    fileInputs: f.controls?.filter(c => c.type === 'file'),
    controlsOutsideViewport: f.controls?.filter(c => !c.inViewport && ['a', 'button'].includes(c.tag)).map(c => c.text).filter(Boolean)
  })) };
}

export function snapshotDelta(previous, next) {
  return { url: next.url, frames: next.frames.map(f => {
    const old = previous.frames.find(p => p.frame === f.frame);
    if (!old) return f;
    const oldLines = new Set((old.aria || '').split('\n'));
    const oldFields = new Set((old.fields || []).map(v => JSON.stringify(v)));
    return { frame: f.frame, addedOrChangedAria: (f.aria || '').split('\n').filter(line => !oldLines.has(line)).join('\n'),
      removedAria: (old.aria || '').split('\n').filter(line => !(f.aria || '').split('\n').includes(line)).join('\n'),
      addedOrChangedFields: f.fields?.filter(field => !oldFields.has(JSON.stringify(field))) };
  }) };
}

export function taskFromProposal(proposal, envelope, template) {
  ensure(proposal && typeof proposal.compatible === 'boolean', 'missing-compatibility');
  if (!proposal.compatible) return { rejected: true, reason: proposal.reason, proposal };
  ensure(envelope.testAuthorization === true, 'no-test-authorization');
  ensure(Array.isArray(proposal.constraints) && proposal.constraints.length >= 2, 'missing-goal-constraints');
  for (const c of proposal.constraints) ensure(typeof c.quote === 'string' && envelope.text.includes(c.quote), 'ungrounded-constraint', c);
  const inputs = {}, sources = {};
  for (const [key, value] of Object.entries(proposal.inputs || {})) {
    ensure(/^[a-z][a-zA-Z0-9_]*$/.test(key), 'invalid-input-name');
    ensure(value.type === 'string' || value.type === 'file', 'invalid-input-type');
    if (value.type === 'file') {
      const file = envelope.attachments.find(f => f.id === value.attachmentId);
      ensure(!!file, 'unknown-attachment');
      inputs[key] = { type: 'file', path: file.path, name: file.name, stem: file.name.replace(/\.[^.]+$/, ''), sha256: file.sha256 };
      sources[key] = { attachmentId: file.id, description: value.description };
    } else {
      ensure(typeof value.value === 'string' && value.value.length > 0 && typeof value.quote === 'string' && envelope.text.includes(value.quote) && value.quote.includes(value.value), 'ungrounded-input', { key });
      inputs[key] = { type: 'string', value: value.value };
      sources[key] = { quote: value.quote, description: value.description };
    }
  }
  ensure(Object.keys(inputs).length > 0 && Object.values(inputs).some(v => v.type === 'file'), 'missing-task-inputs');
  if (template) ensure(JSON.stringify(Object.keys(inputs).sort()) === JSON.stringify(Object.keys(template.inputs).sort()) && Object.keys(inputs).every(k => inputs[k].type === template.inputs[k].type), 'mapping-schema-mismatch');
  const task = { id: envelope.id, origin: envelope.origin, entryUrl: envelope.entryUrl,
    kind: template?.kind || proposal.goalKind, inputs, requiredOutputs: Object.keys(inputs),
    goal: proposal.goal, constraints: proposal.constraints, sources,
    suggestions: proposal.suggestions || [], request: envelope.text,
    authorization: { source: 'explicit-isolated-test-fixture', requestDigest: hash(envelope.text), inputsDigest: hash(inputs) } };
  ensure(typeof task.kind === 'string' && task.kind.length > 0, 'missing-goal-kind');
  return task;
}

const ops = new Set(['hover', 'click', 'fill', 'check', 'select', 'press', 'upload', 'wait', 'finish']);
const kinds = new Set(['visible', 'absent', 'text', 'value', 'checked', 'attribute', 'download']);
export function validateChecks(checks, task) {
  ensure(Array.isArray(checks), 'missing-checks');
  for (const c of checks) {
    ensure(kinds.has(c.kind) && !!c.target, 'invalid-condition', { condition: c });
    ensure(['css', 'role', 'label', 'placeholder', 'text'].includes(c.target.by), 'invalid-locator');
    if (['text', 'value', 'attribute'].includes(c.kind)) ensure(['equals', 'contains', 'startsWith', 'originEquals'].includes(c.compare), 'invalid-comparison');
    if (c.kind === 'attribute') ensure(['href', 'aria-label', 'role', 'type', 'title', 'data-type'].includes(c.attribute), 'invalid-attribute');
  }
  bind(checks, task.inputs);
}

export function validateCoverage(checks, task, result = false) {
  validateChecks(checks, task);
  for (const key of task.requiredOutputs) {
    ensure(checks.some(c => (c.kind === 'checked' && c.expected === true && c.target?.name?.input === key) || c.expected?.input === key &&
      (task.inputs[key].type === 'file' ? result ? c.kind === 'download' && c.expected.field === 'sha256' : ['name', 'stem'].includes(c.expected.field)
        : ['text', 'value', 'checked', 'attribute'].includes(c.kind))), 'uncovered-task-input', { key, result });
  }
}

export function validateStep(step, task) {
  ensure(ops.has(step.action?.op) && !!step.action.target && ['read', 'edit', 'upload', 'commit'].includes(step.effect), 'invalid-step');
  ensure(['css', 'role', 'label', 'placeholder', 'text'].includes(step.action.target.by), 'invalid-action-target');
  ensure(step.action.op !== 'upload' || step.effect === 'upload', 'upload-effect-mismatch');
  validateChecks(step.before, task); validateChecks(step.after, task);
  if (['fill', 'check', 'select', 'upload'].includes(step.action.op)) ensure(step.after.length > 0, 'missing-write-condition');
  const action = bind(step.action, task.inputs);
  if (['fill', 'press', 'select', 'upload'].includes(action.op)) ensure(typeof action.value === 'string', 'invalid-value');
}

export const actionSeal = step => hash({ action: step.action, effect: step.effect });
export function validateCandidate(candidate, task, ledger) {
  ensure(candidate.schema === 1 && candidate.steps?.length === ledger.length, 'invalid-candidate-shape');
  ensure(candidate.compatibility?.origin === task.origin && candidate.compatibility?.kind === task.kind, 'candidate-not-applicable');
  ensure(candidate.steps.at(-1).action.op === 'finish', 'missing-result-step');
  for (const [i, step] of candidate.steps.entries()) {
    ensure(step.id === ledger[i].id && actionSeal(step) === ledger[i].seal, 'action-or-effect-changed', { step: step.id });
    validateStep(step, task);
  }
  ensure(candidate.entryChecks?.length > 0, 'missing-entry-check');
  validateChecks(candidate.entryChecks, task);
  validateCoverage(candidate.commitChecks, task);
  validateCoverage(candidate.resultChecks, task, true);
}

// 只在一次性实验浏览器内截住上传，以得到真实页面的正反状态。
export async function uploadGate(page, events) {
  let pending, release, waiting = false;
  let resolvePending;
  const held = new Promise(r => { resolvePending = r; });
  const done = new Promise(r => { release = r; });
  let responseResolve;
  const response = new Promise(r => { responseResolve = r; });
  page.on('response', res => { if (pending && res.request() === pending) { events.push({ type: 'upload-response', at: Date.now(), status: res.status() }); responseResolve(res.status()); } });
  await page.route('**/*', async route => {
    const request = route.request();
    if (!pending && request.method() === 'POST' && (request.headers()['content-type'] || '').startsWith('multipart/form-data')) {
      pending = request; waiting = true; events.push({ type: 'upload-held', at: Date.now() }); resolvePending();
      await done; waiting = false;
    }
    await route.continue().catch(() => {});
  });
  return {
    held: () => Promise.race([held, delay(15000).then(() => { throw new Fault('upload-not-observed'); })]),
    release: () => { events.push({ type: 'upload-released', at: Date.now() }); release(); },
    response: () => Promise.race([response, delay(20000).then(() => { throw new Fault('upload-response-timeout'); })]),
    get waiting() { return waiting; }
  };
}

// 首次探索和稳定复用都调用这一 Interface。候选本身不能改任务、素材或已封存的动作效果。
export function createMachine({ page, browser, task, directory, emit, deadline, signal, gate, contrast, mutate }) {
  const fixedTask = structuredClone(task), taskDigest = hash(task);
  let commitDispatched = false;
  const guard = () => {
    ensure(Date.now() < deadline, 'experiment-time-budget');
    ensure(!signal?.aborted, 'experiment-stopped');
    ensure(hash(task) === taskDigest && task.authorization.inputsDigest === hash(task.inputs), 'task-changed');
    ensure(!page.isClosed() && new URL(page.url()).origin === fixedTask.origin, 'page-origin-mismatch');
  };
  const checks = (rules, timeout = 16000, targetPage = page) => checkAll(targetPage, rules, fixedTask, directory, guard, timeout);
  return {
    get commitDispatched() { return commitDispatched; },
    checks,
    async perform(step, readyChecks) {
      guard(); validateStep(step, fixedTask); await validateMaterials(fixedTask);
      const action = bind(step.action, fixedTask.inputs);
      await mutate?.(step, page, fixedTask);
      await checks(step.before);
      if (step.effect === 'commit') { validateCoverage(readyChecks, fixedTask); await checks(readyChecks); }
      const target = locate(page, action.target);
      await target.first().waitFor({ state: action.op === 'upload' ? 'attached' : 'visible', timeout: 20000 });
      if (action.op === 'finish') {
        const hrefs = await target.evaluateAll(els => els.map(el => el.getAttribute('href')));
        ensure(hrefs.length > 0 && hrefs.every(Boolean), 'result-link-missing');
        const urls = [...new Set(hrefs.map(h => new URL(h, page.url()).href))];
        ensure(urls.length === 1 && new URL(urls[0]).origin === fixedTask.origin, 'ambiguous-result');
        await checks(step.after); return { executed: true, resultUrl: urls[0] };
      }
      ensure(await target.count() === 1, 'ambiguous-target');
      if (action.op === 'fill') {
        const actual = await target.evaluate(el => 'value' in el ? el.value : el.textContent);
        ensure(actual !== action.value, 'input-already-satisfied', { actual, expected: action.value, input: step.action.value });
      }
      ensure(await target.evaluate(el => el.ownerDocument.defaultView.origin) === task.origin, 'target-origin-mismatch');
      const href = await target.getAttribute('href');
      if (action.op === 'click' && href) ensure(new URL(href, page.url()).origin === fixedTask.origin, 'unapproved-navigation');
      guard(); await emit({ type: 'dispatch', step: step.id, effect: step.effect, action });
      if (step.effect === 'commit') commitDispatched = true;
      const options = { timeout: 35000 };
      let executed = false;
      try {
        switch (action.op) {
          case 'click': await target.click(options); break;
          case 'hover': await target.hover(options); break;
          case 'fill': await target.fill(action.value, options); break;
          case 'press': await target.press(action.value, options); break;
          case 'check': await target.setChecked(action.value, options); break;
          case 'select': await target.selectOption({ label: action.value }, options); break;
          case 'upload':
            ensure(Object.values(task.inputs).some(v => v.type === 'file' && v.path === action.value), 'unapproved-file');
            await target.setInputFiles(action.value, options); break;
          case 'wait': break;
        }
        executed = true;
        if (action.op === 'click' && href) await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
        if (action.op === 'upload' && gate) {
          await gate.held();
          await delay(400);
          const pending = await snapshot(page);
          let negative;
          try { negative = { passed: true, evidence: await checks(step.after, 0) }; }
          catch (e) { negative = { passed: false, code: e.code, evidence: e.detail }; }
          gate.release(); await gate.response(); await delay(500);
          const settled = await snapshot(page);
          contrast.push({ stepId: step.id, pending, settled, negative });
          await emit({ type: 'condition-negative', step: step.id, negative });
          // 探索时记录反例；后续校准必须拒绝不能区分上传中/完成的候选。
          if (contrast.enforce && negative.passed) throw new Fault('condition-false-positive', { step: step.id });
        }
        guard(); const evidence = await checks(step.after);
        return { executed: true, evidence };
      } catch (error) {
        error.executed = executed;
        if (commitDispatched) error.status = 'outcome-unknown';
        throw error;
      }
    },
    async result(url, rules) {
      guard(); validateCoverage(rules, task, true);
      const context = await browser.newContext({ acceptDownloads: true });
      try {
        const publicPage = await context.newPage();
        await publicPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        ensure(new URL(publicPage.url()).origin === task.origin, 'result-origin-mismatch');
        const view = await snapshot(publicPage);
        const evidence = await checks(rules, 12000, publicPage);
        await publicPage.screenshot({ path: directory + '/runtime-result.png', fullPage: true });
        return { view, evidence };
      } finally { await context.close(); }
    }
  };
}
