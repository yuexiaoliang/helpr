import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, createClient } from '../model-api/client.mjs';
import { save, hash, ensure, Fault, snapshot, compactSnapshot, snapshotDelta, taskFromProposal, validateChecks, validateCoverage, validateStep,
  actionSeal, validateCandidate, uploadGate, createMachine, checkAll, locate } from './runtime.mjs';
import { parseInstruction, exploreInstruction, resultInstruction, postconditionInstruction, compileInstruction, chunkInstruction, globalsInstruction } from './prompts.mjs';
import { fixture, oracle, controlledChange } from './fixtures.mjs';

const root = path.resolve(process.argv[2] || 'artifacts/run-' + new Date().toISOString().replaceAll(':', '-'));
const mode = process.argv[3] || 'all';
const nativeMode = process.argv[5] === 'native';
await mkdir(root, { recursive: true });
const exists = async file => { try { await access(file); return true; } catch { return false; } };
let meta = await exists(root + '/meta.json') ? JSON.parse(await readFile(root + '/meta.json')) : {
  startedAt: new Date().toISOString(), budget: { calls: 64, tokens: 220000, minutes: 35, candidateRevisions: 2 }, modelCalls: [], outcomes: []
};
const deadline = Date.parse(meta.startedAt) + meta.budget.minutes * 60000;
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort()); process.on('SIGINT', () => controller.abort());
const { config, apiKey } = await loadConfig('../model-api/config.example.json', '../model-api/.env.local');
config.timeoutMs = 120000;
const client = createClient(config, apiKey, meta.modelCalls);
if (!meta.sourceHistory && meta.sourceHashes) meta.sourceHistory = [{ mode: 'previous-phase', hashes: meta.sourceHashes }];
meta.sourceHashes = Object.fromEntries(await Promise.all(['run.mjs', 'runtime.mjs', 'prompts.mjs', 'fixtures.mjs', '../model-api/client.mjs', '../workflow-reliability/executor.mjs'].map(async p => [p, hash(await readFile(p))])));
(meta.sourceHistory ??= []).push({ mode, at: new Date().toISOString(), hashes: meta.sourceHashes });
meta.model = config.model;
meta.outputMode = nativeMode ? 'native-function' : 'json-object';
const summary = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
async function ask(label, instruction, input, maxTokens = 4000, allowFormatRepair = true) {
  ensure(Date.now() < deadline && !controller.signal.aborted, 'experiment-time-budget');
  const used = meta.modelCalls.reduce((sum, r) => sum + (r.usage?.total_tokens || 0), 0);
  ensure(meta.modelCalls.length < meta.budget.calls && used < meta.budget.tokens, 'model-budget-exhausted', { used });
  const index = meta.modelCalls.length + 1, dir = root + '/model/' + String(index).padStart(2, '0') + '-' + label;
  await mkdir(dir, { recursive: true });
  await save(dir + '/input.json', { instruction, input });
  summary({ type: 'model-start', label, call: index, usedTokens: used });
  try {
    const parameters = label.startsWith('explore-') ? { type: 'object', properties: {
      note: { type: 'string' }, action: { type: 'object', additionalProperties: true }, effect: { type: 'string', enum: ['read', 'edit', 'upload', 'commit'] },
      before: { type: 'array', items: { type: 'object' } }, after: { type: 'array', items: { type: 'object' } }, commitChecks: { type: 'array', items: { type: 'object' } }
    }, required: ['action', 'effect', 'before', 'after', 'commitChecks'], additionalProperties: false } : { type: 'object', additionalProperties: true };
    const formatOptions = nativeMode ? { tools: [{ type: 'function', function: { name: 'record_proposal', description: '记录结构化提议，交给程序验证；不会自行执行。', parameters } }],
      tool_choice: { type: 'function', function: { name: 'record_proposal' } } } : { response_format: { type: 'json_object' } };
    const answer = await client.request(label, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(input) }],
      ...formatOptions, temperature: 0, max_tokens: maxTokens }, { signal: controller.signal });
    await save(dir + '/message.json', answer);
    if (nativeMode) ensure(answer.tool_calls?.length === 1 && answer.tool_calls[0].function.name === 'record_proposal', 'invalid-proposal-tool-call');
    const rawContent = nativeMode ? answer.tool_calls[0].function.arguments : answer.content;
    await writeFile(dir + '/answer.txt', rawContent || '');
    let result;
    try { result = JSON.parse(rawContent); }
    catch (e) {
      summary({ type: 'invalid-json', label, call: index, error: e.message });
      if (!allowFormatRepair) throw e;
      result = await ask(label + '-json-repair', '只修复给定输出的 JSON 语法，不改变任何字段、动作、条件或值，不添加内容。返回单个合法 JSON 对象。', { invalidJson: rawContent, error: e.message }, maxTokens, false);
    }
    summary({ type: 'model-end', label, call: index, usage: meta.modelCalls.at(-1).usage });
    return result;
  } finally { await save(root + '/meta.json', meta); }
}
const errorData = e => ({ code: e.code || e.name, message: e.message?.slice(0, 1000), detail: e.detail, executed: e.executed, status: e.status });
const inputTemplate = t => ({ kind: t.kind, goal: t.goal, constraints: t.constraints, inputs: Object.fromEntries(Object.entries(t.inputs).map(([k, v]) => [k, { type: v.type, description: t.sources[k]?.description }])) });
async function parseTask(f, template) {
  const proposal = await ask('parse-' + f.envelope.id, parseInstruction, { request: f.envelope.text, attachments: f.envelope.attachments.map(({ id, name }) => ({ id, name })), template: template && inputTemplate(template) }, 2600);
  await save(f.directory + '/request.json', f.envelope); await save(f.directory + '/parsing.json', proposal);
  const task = taskFromProposal(proposal, f.envelope, template); await save(f.directory + '/task.json', task);
  return task;
}
async function open(task, directory, { enforceContrast = false, change } = {}) {
  const browser = await chromium.launch({ headless: true });
  const events = [], contrast = []; contrast.enforce = enforceContrast;
  const context = await browser.newContext({ storageState: '../runtime-flow-replay/private/auth.json', viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const emit = async event => { const row = { at: new Date().toISOString(), ...event }; events.push(row); await appendFile(directory + '/events.jsonl', JSON.stringify(row) + '\n'); };
  page.on('request', req => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) events.push({ type: 'network-write', method: req.method(), pathname: new URL(req.url()).pathname, at: Date.now() });
  });
  const gate = await uploadGate(page, events);
  try {
    await page.goto(task.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    ensure(new URL(page.url()).origin === task.origin && !page.url().includes('wp-login.php'), 'login-not-ready');
    const machine = createMachine({ page, browser, task, directory, emit, deadline, signal: controller.signal, gate, contrast,
      mutate: change ? controlledChange(change, events) : undefined });
    return { page, browser, events, contrast, gate, machine, emit };
  } catch (e) { await browser.close(); throw e; }
}
async function closeSession(s, directory) {
  if (!s) return;
  s.gate.release();
  await save(directory + '/network-and-events.json', s.events);
  await save(directory + '/contrast.json', s.contrast);
  await s.browser.close();
}
async function publicView(browser, url) {
  const context = await browser.newContext();
  try { const page = await context.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); return await snapshot(page); }
  finally { await context.close(); }
}

async function learn() {
  ensure(!(await exists(root + '/learn/results.json')), 'learning-already-recorded');
  const resumed = process.argv[4] ? JSON.parse(await readFile(path.resolve(process.argv[4]) + '/learn/results.json')) : undefined;
  if (resumed) ensure(!resumed.trace.some(t => t.step.effect === 'commit'), 'cannot-resume-uncertain-commit-prefix');
  const f = await fixture(root, 'learn'), task = await parseTask(f, resumed?.task);
  const trace = [], failures = [], result = { phase: 'learn', task, trace, failures, source: 'new-live-exploration-without-old-workflows',
    ...(resumed ? { automaticPrefix: { source: process.argv[4], steps: resumed.trace.length, sourceDigest: hash(resumed.trace), note: '先前本实验模型提出并实际核对的前缀，原样在新测试输入上复用；未读取早期其它实验的路径' } } : {}) };
  let s;
  try {
    s = await open(task, f.directory);
    const initial = await snapshot(s.page); result.initial = initial;
    let resultUrl;
    let prefixActive = !!resumed;
    for (let round = 0; round < 27 && !resultUrl; round++) {
      const before = await snapshot(s.page);
      const observedInputs = Object.entries(task.inputs).filter(([, v]) => v.type === 'string').map(([key, v]) => ({ input: key, equalFields: before.frames.flatMap(frame => (frame.fields || []).filter(f => f.value === v.value).map(f => ({ frame: frame.frame, tag: f.tag, label: f.label, actual: f.value }))) })).filter(v => v.equalFields.length);
      const usingPrefix = prefixActive && round < resumed.trace.length;
      const decision = usingPrefix ? { ...resumed.trace[round].step, note: '自动复用先前核对过的前缀', commitChecks: resumed.trace[round].commitChecks } : await ask('explore-' + round, exploreInstruction, { task: { ...task, request: undefined, constraints: undefined, sources: undefined }, observedInputs,
        currentPage: compactSnapshot(before), history: trace.map(t => ({ id: t.step.id, action: t.step.action, effect: t.step.effect, outcome: t.outcome })),
        failures: failures.slice(-2).map(f => ({ step: f.step, error: f.error })) }, 4300);
      const step = { id: 's' + (trace.length + 1), action: decision.action, effect: decision.effect, before: decision.before, after: decision.after };
      summary({ type: 'proposed-action', step: step.id, action: step.action, effect: step.effect });
      let outcome;
      try {
        validateStep(step, task);
        outcome = await s.machine.perform(step, decision.commitChecks);
      } catch (e) {
        const failure = { step, error: errorData(e), after: compactSnapshot(await snapshot(s.page)) };
        failures.push(failure); await save(f.directory + '/failures.json', failures);
        prefixActive = false;
        summary({ type: 'exploration-failure', step: step.id, error: failure.error });
        if (s.machine.commitDispatched || failures.filter(f => !f.error.executed).length >= 4) throw e;
        if (e.executed) {
          let calibrated = false;
          for (let retry = 0; retry < 2; retry++) {
            const correction = await ask('post-calibrate-' + step.id + '-' + retry, postconditionInstruction,
              { task, step, error: failure.error, before: compactSnapshot(before), actualPage: compactSnapshot(await snapshot(s.page)) }, 3500);
            await save(f.directory + '/post-calibrate-' + step.id + '-' + retry + '.json', { original: step.after, correction });
            try {
              validateChecks(correction.after, task);
              if (['fill', 'select'].includes(step.action.op)) ensure(correction.after.some(c => ['value', 'text'].includes(c.kind) && c.compare === 'equals' && hash(c.expected) === hash(step.action.value)), 'post-calibration-weakened-value');
              if (step.action.op === 'check') ensure(correction.after.some(c => c.kind === 'checked' && c.expected === step.action.value), 'post-calibration-weakened-state');
              const evidence = await s.machine.checks(correction.after);
              step.after = correction.after; validateStep(step, task);
              outcome = { executed: true, calibratedAfter: true, evidence, originalFailure: failure.error };
              calibrated = true; break;
            } catch (repairError) { failure.error = errorData(repairError); }
          }
          ensure(calibrated, 'step-condition-not-calibrated', { step: step.id });
        }
        if (!e.executed) continue;
      }
      const after = await snapshot(s.page);
      trace.push({ step, note: decision.note, before, after, outcome, commitChecks: decision.commitChecks });
      await save(f.directory + '/trace.json', trace);
      await s.emit({ type: 'exploration-step', id: step.id, outcome });
      resultUrl = outcome.resultUrl;
    }
    ensure(!!resultUrl, 'exploration-step-limit');
    result.resultUrl = resultUrl;
    const view = await publicView(s.browser, resultUrl); result.publicObservation = view;
    let checks, previous;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proposal = await ask('learn-result-' + attempt, resultInstruction, { task, publicObservation: compactSnapshot(view), previous }, 4000);
      try {
        checks = await s.machine.result(resultUrl, proposal.resultChecks);
        result.resultChecks = proposal.resultChecks; result.runtimeVerification = checks.evidence; break;
      } catch (e) { previous = { proposal, error: errorData(e) }; await save(f.directory + '/result-check-failure-' + attempt + '.json', previous); }
    }
    ensure(!!checks, 'result-rules-not-calibrated');
    result.oracle = await oracle(s.browser, resultUrl, f);
    result.status = 'completed';
    result.ledger = trace.map(t => ({ id: t.step.id, seal: actionSeal(t.step) }));
  } catch (e) {
    result.status = s?.machine.commitDispatched ? 'outcome-unknown' : 'failed'; result.error = errorData(e);
    if (s) { result.failureObservation = await snapshot(s.page); await s.page.screenshot({ path: f.directory + '/failure.png', fullPage: true }).catch(() => {}); }
  } finally {
    result.endedAt = new Date().toISOString();
    result.contrast = s?.contrast || [];
    await save(f.directory + '/results.json', result); await closeSession(s, f.directory);
    meta.outcomes.push({ phase: 'learn', status: result.status, error: result.error }); await save(root + '/meta.json', meta);
  }
  summary({ phase: 'learn', status: result.status, steps: trace.length, failures: failures.length, error: result.error, resultUrl: result.resultUrl });
  return result;
}

const compactTrace = trace => trace.map((t, i) => ({ ...t, before: i ? snapshotDelta(compactSnapshot(trace[i - 1].after), compactSnapshot(t.before)) : compactSnapshot(t.before),
  after: snapshotDelta(compactSnapshot(t.before), compactSnapshot(t.after)) }));
function evidenceBundle(learning) {
  return { task: learning.task, entry: compactSnapshot(learning.initial), trace: compactTrace(learning.trace),
    contrast: learning.contrast.map(c => ({ ...c, pending: compactSnapshot(c.pending), settled: compactSnapshot(c.settled) })),
    publicObservation: compactSnapshot(learning.publicObservation) };
}
async function compile(learning) {
  ensure(learning.status === 'completed', 'learning-incomplete');
  const dir = root + '/compile'; await mkdir(dir, { recursive: true });
  const bundle = evidenceBundle(learning), candidates = {};
  let previous;
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = await ask('whole-' + attempt, compileInstruction, { ...bundle, previous }, 12500);
    await save(dir + '/whole-' + attempt + '.json', candidate);
    try { validateCandidate(candidate, learning.task, learning.ledger); candidates.whole = candidate; break; }
    catch (e) { previous = { candidate, error: errorData(e) }; await save(dir + '/whole-error-' + attempt + '.json', previous.error); }
  }
  const steps = [];
  for (let start = 0; start < learning.trace.length; start += 6) {
    const part = bundle.trace.slice(start, start + 6).map((t, i) => i ? t : { ...t, before: compactSnapshot(learning.trace[start].before) });
    let previousPart, assembled;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proposal = await ask('chunk-' + start + '-' + attempt, chunkInstruction,
        { task: learning.task, trace: part, contrast: bundle.contrast, previous: previousPart }, 6500);
      await save(dir + '/chunk-' + start + '-' + attempt + '.json', proposal);
      try {
        ensure(proposal.steps?.length === part.length && proposal.steps.every((s, i) => s.id === part[i].step.id), 'chunk-identity-mismatch');
        assembled = proposal.steps.map((p, i) => ({ ...part[i].step, before: p.before, after: p.after }));
        for (const s of assembled) validateStep(s, learning.task);
        break;
      } catch (e) { assembled = undefined; previousPart = { proposal, error: errorData(e) }; }
    }
    ensure(!!assembled, 'chunk-not-valid', { start }); steps.push(...assembled);
  }
  let candidate;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proposal = await ask('globals-' + attempt, globalsInstruction, { task: learning.task, entry: bundle.entry,
      commitStages: learning.trace.filter(t => t.step.effect === 'commit').map(t => ({ step: t.step, before: compactSnapshot(t.before) })),
      contrast: bundle.contrast, publicObservation: bundle.publicObservation, previous }, 6000);
    await save(dir + '/globals-' + attempt + '.json', proposal);
    candidate = { schema: 1, compatibility: { origin: learning.task.origin, kind: learning.task.kind }, steps,
      entryChecks: proposal.entryChecks, commitChecks: proposal.commitChecks, resultChecks: proposal.resultChecks, reasoning: proposal.reasoning };
    try { validateCandidate(candidate, learning.task, learning.ledger); candidates.staged = candidate; break; }
    catch (e) { previous = { proposal, error: errorData(e) }; candidate = undefined; }
  }
  await save(dir + '/candidates.json', candidates);
  await save(dir + '/assembly.json', { rule: '原始动作及效果按记录顺序保留；分项提议仅按id连接完整条件数组。全局规则原样采用模型输出。无选择器或期望值修正。', ledger: learning.ledger });
  summary({ phase: 'compile', candidates: Object.keys(candidates) });
  return candidates;
}

async function executeCase(name, candidate, learning, { change, calibration = false, alternateTask } = {}) {
  const f = await fixture(root, name), result = { name, startedAt: new Date().toISOString(), candidateDigest: hash(candidate), calibration };
  let s;
  try {
    const task = alternateTask || await parseTask(f, learning.task); result.task = task;
    ensure(!task.rejected, 'compatible-task-rejected');
    validateCandidate(candidate, task, learning.ledger);
    s = await open(task, f.directory, { enforceContrast: true, change });
    await s.machine.checks(candidate.entryChecks);
    let resultUrl;
    for (const step of candidate.steps) {
      result.step = step.id;
      result.lastObservation = await snapshot(s.page);
      summary({ type: 'replay-step', name, step: step.id, effect: step.effect });
      const outcome = await s.machine.perform(step, candidate.commitChecks);
      resultUrl = outcome.resultUrl || resultUrl;
      await s.emit({ type: 'step-completed', step: step.id, outcome });
    }
    ensure(!!resultUrl, 'no-result-url'); result.resultUrl = resultUrl;
    result.runtime = await s.machine.result(resultUrl, candidate.resultChecks);
    try { result.oracle = await oracle(s.browser, resultUrl, f); result.status = 'completed'; }
    catch (e) { result.status = 'false-success'; result.oracleError = errorData(e); }
  } catch (e) {
    result.status = s?.machine.commitDispatched ? 'outcome-unknown' : 'blocked'; result.error = errorData(e);
    if (s) { result.failureObservation = await snapshot(s.page); await s.page.screenshot({ path: f.directory + '/failure.png', fullPage: true }).catch(() => {}); }
  } finally {
    result.endedAt = new Date().toISOString(); result.contrast = s?.contrast || []; result.commitDispatched = s?.machine.commitDispatched || false;
    result.networkWrites = s?.events.filter(e => e.type === 'network-write').length || 0;
    result.fixtureChanges = s?.events.filter(e => e.type === 'fixture-mutation') || [];
    await save(f.directory + '/results.json', result); await closeSession(s, f.directory);
    const compact = { name, status: result.status, step: result.step, error: result.error, resultUrl: result.resultUrl };
    meta.outcomes.push(compact); await save(root + '/meta.json', meta); summary(compact);
  }
  return result;
}

async function evaluate(candidates, learning) {
  const results = [], calibrationFailures = [];
  let winner, winnerName;
  for (const [name, candidate] of Object.entries(candidates)) {
    const result = await executeCase('calibration-' + name, candidate, learning, { calibration: true }); results.push(result);
    if (result.status === 'completed') { winner = candidate; winnerName = name; }
    else calibrationFailures.push({ strategy: name, result });
  }
  // 自动校准仅在提交之前，不能靠重新发布处理不确定结果。
  for (let attempt = 0; !winner && attempt < meta.budget.candidateRevisions && calibrationFailures.length; attempt++) {
    const last = calibrationFailures.at(-1), previous = candidates[last.strategy];
    if (last.result.commitDispatched) break;
    const proposal = await ask('auto-calibrate-' + attempt, compileInstruction, { ...evidenceBundle(learning), previousCandidate: previous,
      actualFailedTask: last.result.task, failedStep: last.result.step, failure: last.result.error,
      currentPage: last.result.failureObservation && compactSnapshot(last.result.failureObservation), actualContrast: last.result.contrast }, 12500);
    const name = 'revised-' + attempt; await save(root + '/compile/' + name + '.json', proposal);
    try { validateCandidate(proposal, learning.task, learning.ledger); }
    catch (e) { calibrationFailures.push({ strategy: name, result: { status: 'proposal-rejected', error: errorData(e), commitDispatched: false } }); candidates[name] = proposal; continue; }
    candidates[name] = proposal;
    const result = await executeCase('calibration-' + name, proposal, learning, { calibration: true }); results.push(result);
    if (result.status === 'completed') { winner = proposal; winnerName = name; }
    else calibrationFailures.push({ strategy: name, result });
  }
  const applicability = [];
  for (const variant of ['draft', 'update', 'summarize']) {
    const f = await fixture(root, 'not-applicable-' + variant, variant);
    try {
      const task = await parseTask(f, learning.task);
      applicability.push({ variant, rejected: task.rejected === true, expected: 'reject', correct: task.rejected === true, reason: task.reason });
    } catch (e) { applicability.push({ variant, error: errorData(e), correct: false }); }
  }
  const baseline = winner || candidates.staged || candidates.whole;
  const integrity = [];
  if (baseline) {
    const mutant = structuredClone(baseline);
    for (const step of mutant.steps) if (step.effect === 'commit') step.effect = 'read';
    try { validateCandidate(mutant, learning.task, learning.ledger); integrity.push({ case: 'commit-relabelled-read', rejected: false }); }
    catch (e) { integrity.push({ case: 'commit-relabelled-read', rejected: true, reason: errorData(e), browserOpened: false }); }
    const alteredTask = structuredClone(learning.task); const key = Object.keys(alteredTask.inputs).find(k => alteredTask.inputs[k].type === 'string'); alteredTask.inputs[key].value += '-changed';
    try {
      const machine = createMachine({ page: { isClosed: () => false, url: () => alteredTask.entryUrl }, task: alteredTask,
        deadline, emit: async () => { throw new Error('unexpected-dispatch'); } });
      await machine.perform(baseline.steps[0], baseline.commitChecks);
      integrity.push({ case: 'task-input-tamper', rejected: false });
    } catch (e) { integrity.push({ case: 'task-input-tamper', rejected: e.code === 'task-changed', reason: errorData(e), actualInterfaceCalled: true, browserOpened: false }); }
  }
  if (winner) {
    // 保留集的素材及文字在归纳/修订完成以后才创建、解析，不送回校准。
    await save(root + '/qualified-candidate.json', winner);
    for (const name of ['heldout', 'heldout-collision']) results.push(await executeCase(name, winner, learning));
    results.push(await executeCase('changed-control', winner, learning, { change: 'accessible-label' }));
  }
  const output = { winnerName, winnerDigest: winner && hash(winner), results: results.map(r => ({ name: r.name, status: r.status, resultUrl: r.resultUrl, error: r.error,
    contrast: r.contrast.map(c => ({ stepId: c.stepId, negativePassed: c.negative.passed })), commitDispatched: r.commitDispatched, fixtureChanges: r.fixtureChanges })),
    applicability, integrity, untested: winner ? [] : ['heldout', 'heldout-collision', 'changed-control'], autoCalibrationAttempts: meta.modelCalls.filter(r => r.label.startsWith('auto-calibrate')).length };
  await save(root + '/evaluation.json', output); summary({ phase: 'evaluate', winnerName, results: output.results.map(({ name, status }) => ({ name, status })), applicability, integrity });
  return output;
}

try {
  const learning = ['all', 'learn'].includes(mode) ? await learn() : JSON.parse(await readFile(root + '/learn/results.json'));
  if (mode !== 'learn') {
    const candidates = mode === 'evaluate' ? JSON.parse(await readFile(root + '/compile/candidates.json')) : await compile(learning);
    if (mode !== 'compile') await evaluate(candidates, learning);
  }
  meta.status = 'finished';
} catch (e) { meta.status = 'stopped-with-evidence'; meta.error = errorData(e); summary({ phase: 'run-stopped', error: meta.error }); process.exitCode = 1; }
finally {
  meta.endedAt = new Date().toISOString(); meta.tokens = meta.modelCalls.reduce((sum, r) => sum + (r.usage?.total_tokens || 0), 0);
  await save(root + '/meta.json', meta); summary({ root, status: meta.status, calls: meta.modelCalls.length, tokens: meta.tokens, outcomes: meta.outcomes });
}
