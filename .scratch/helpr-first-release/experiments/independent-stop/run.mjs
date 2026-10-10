import { _electron, chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createLab, deferred } from './lab.mjs';
import { ExecutionControl, Stopped } from './control.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
await writeFile(path.join(root, 'artifacts/latest.txt'), out + '\n');
const lab = await createLab(out);
const metadata = { startedAt: new Date().toISOString(), node: process.version, playwright: '1.64.0', electron: '44.7.0', os: { platform: os.platform(), release: os.release(), arch: os.arch() }, base: lab.base, scope: 'controlled real browser pages; delayed provider response is a local stub; no actual AI or business backend' };
const results = [];
const save = async () => { await lab.flush(); await writeFile(path.join(out, 'results.json'), JSON.stringify({ metadata, results }, null, 2) + '\n'); };
const capture = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', name: error.name, error: String(error) }));
const freePort = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
async function waitUntil(fn) { for (let n = 0; n < 200; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Preparation timed out'); }

async function openHost(kind) {
  const port = await freePort();
  if (kind === 'electron-cdp') {
    const executablePath = createRequire(import.meta.url)('electron');
    const app = await _electron.launch({ executablePath, args: [path.join(root, 'electron.cjs')], env: { ...process.env, STOP_LAB_BASE: lab.base, STOP_LAB_DIR: out, STOP_LAB_PORT: String(port) }, timeout: 40000 });
    try {
      await waitUntil(() => app.evaluate(() => global.stopLab?.ready));
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
      const pages = ['A', 'B'].map(task => browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('task=' + task)));
      assert(pages.every(Boolean), 'Electron page discovery');
      return { pages, versions: await app.evaluate(() => process.versions), async close() { await browser.close(); await app.close(); } };
    } catch (error) { await app.close(); throw error; }
  }
  const context = await chromium.launchPersistentContext(path.join(out, 'profiles/chromium'), { channel: 'chromium', headless: false, viewport: { width: 1120, height: 780 }, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  const original = [context.pages()[0], await context.newPage()];
  await Promise.all(original.map((page, index) => page.goto(lab.base + '/fixture?scope=boot&task=' + ['A', 'B'][index])));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const pages = ['A', 'B'].map(task => browser.contexts().flatMap(item => item.pages()).find(page => page.url().endsWith('task=' + task)));
  assert(pages.every(Boolean), 'Chromium page discovery');
  return { pages, versions: { chromium: browser.version() }, async close() { await browser.close(); await context.close(); } };
}

async function runCase(kind, host, name, expected, body) {
  const scope = kind + ':' + name;
  const [a, b] = host.pages;
  const log = event => lab.log({ scope, ...event });
  const controls = { A: new ExecutionControl('A', log), B: new ExecutionControl('B', log) };
  const tickets = { A: controls.A.ticket(), B: controls.B.ticket() };
  await Promise.all(host.pages.map((page, index) => page.goto(lab.base + '/fixture?' + new URLSearchParams({ scope, task: ['A', 'B'][index] }))));
  const click = (task, selector, options = {}, ticket = tickets[task]) => controls[task].dispatch(ticket, 'click:' + selector, signal => ({ A: a, B: b }[task]).locator(selector).click({ timeout: 2000, ...options, signal }));
  const rendered = (page, operation, value) => page.waitForFunction(({ operation, value }) => window.lab.snapshot().counts[operation] === value, { operation, value }, { timeout: 3000 });
  const advanceB = async (n = 3) => {
    for (let index = 0; index < n; index++) {
      const count = lab.count(scope, 'B', 'count');
      await click('B', '#increment'); await rendered(b, 'count', count + 1);
    }
    return lab.count(scope, 'B', 'count');
  };
  const accepted = (operation, route = '/commit') => lab.wait(event => event.scope === scope && event.task === 'A' && event.kind === 'server-accepted' && event.operation === operation && event.route === route);
  const rejectStopped = result => { assert.equal(result.status, 'rejected'); assert.match(result.error, /abort|stop|supersed/i); };
  const context = { scope, a, b, log, controls, tickets, click, rendered, advanceB, accepted, rejectStopped };
  try {
    log({ kind: 'case-start', expected });
    const evidence = await body(context);
    await Promise.all(host.pages.map(page => page.evaluate(() => window.lab.flush())));
    await lab.flush();
    const snapshots = await Promise.all(host.pages.map(page => page.evaluate(() => window.lab.snapshot())));
    assert.equal(snapshots[0].task, 'A'); assert.equal(snapshots[1].task, 'B');
    assert(snapshots[1].counts.count >= 3, 'B must progress independently');
    const stop = lab.events.find(event => event.scope === scope && event.kind === 'stop' && event.task === 'A');
    const postStopDispatches = lab.events.filter(event => event.scope === scope && event.kind === 'dispatch' && event.task === 'A' && event.generation === stop?.generation && event.sequence > stop?.sequence);
    if (stop) assert.equal(postStopDispatches.length, 0, 'old execution dispatched after stop');
    results.push({ host: kind, name, expected, status: 'passed', evidence: { ...evidence, snapshots, postStopDispatches } });
    console.log('PASS ' + scope);
  } catch (error) {
    results.push({ host: kind, name, expected, status: 'failed', error: String(error), stack: error.stack });
    console.log('FAIL ' + scope + ' ' + String(error));
  } finally {
    controls.A.stop(); controls.B.stop(); lab.releaseAll();
    await Promise.all([controls.A.settled(), controls.B.settled()]); await save();
  }
}

const scenarios = [
  ['positive-control', 'without stopping both pages perform real requests', async c => {
    await c.a.evaluate(() => window.lab.releaseLate());
    await Promise.all([c.click('A', '#late'), c.advanceB()]);
    await c.rendered(c.a, 'late', 1);
    const text = 'abcdef';
    await c.controls.A.dispatch(c.tickets.A, 'type-positive', signal => c.a.locator('#typing').pressSequentially(text, { delay: 15, signal }));
    assert.equal(await c.a.locator('#typing').inputValue(), text);
    return { expectedText: text, realRequest: lab.count(c.scope, 'A', 'late') };
  }],
  ['promise-race-negative', 'ending local waiting without abort leaves the original click alive', async c => {
    const cancellation = deferred();
    const action = c.a.locator('#late').click({ timeout: 3000 });
    const localWait = Promise.race([action.then(() => 'clicked'), cancellation.promise]);
    await c.advanceB(1); cancellation.resolve('local waiting ended');
    const localResult = await localWait;
    await c.a.evaluate(() => window.lab.releaseLate()); await action; await c.rendered(c.a, 'late', 1);
    await c.advanceB(); assert.equal(localResult, 'local waiting ended');
    return { localResult, unwantedLateClick: lab.count(c.scope, 'A', 'late') };
  }],
  ['queued-before-dispatch', 'a queued callback cannot dispatch after its execution stops', async c => {
    const gate = deferred();
    const pending = capture(gate.promise.then(() => c.click('A', '#increment')));
    c.controls.A.stop(); gate.resolve();
    const outcome = await pending; c.rejectStopped(outcome); await c.advanceB();
    assert.equal(lab.count(c.scope, 'A', 'count'), 0);
    return { outcome, count: lab.count(c.scope, 'A', 'count') };
  }],
  ['abort-waiting-click', 'AbortSignal cancels locator waiting and no click occurs when the target later enables', async c => {
    let finished = false;
    const pending = capture(c.click('A', '#late')).then(result => { finished = true; return result; });
    await c.advanceB(1); assert.equal(finished, false, 'A must still await the disabled target');
    const start = performance.now(); c.controls.A.stop();
    const outcome = await pending; const settledMs = performance.now() - start; c.rejectStopped(outcome);
    await c.controls.A.settled(); await c.a.evaluate(() => window.lab.releaseLate()); await c.advanceB();
    assert.equal(lab.count(c.scope, 'A', 'late'), 0);
    return { outcome, settledMs, lateCount: lab.count(c.scope, 'A', 'late') };
  }],
  ['abort-in-flight-typing', 'already typed text remains but sequential input ceases after cancellation settles', async c => {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const pending = capture(c.controls.A.dispatch(c.tickets.A, 'sequential-input', signal => c.a.locator('#typing').pressSequentially(text, { delay: 35, signal, timeout: 4000 })));
    await lab.wait(event => event.scope === c.scope && event.type === 'input' && event.value.length >= 3);
    const start = performance.now(); c.controls.A.stop();
    const outcome = await pending; const settledMs = performance.now() - start; c.rejectStopped(outcome);
    const atSettlement = await c.a.locator('#typing').inputValue();
    await c.advanceB(5); const afterB = await c.a.locator('#typing').inputValue();
    assert(atSettlement.length > 0 && atSettlement.length < text.length); assert.equal(afterB, atSettlement);
    return { outcome, settledMs, atSettlement, afterB, fullText: text };
  }],
  ['queued-retry', 'a retry scheduled after a timeout remains fenced when its timer releases', async c => {
    const backoff = deferred(), scheduled = deferred();
    const pending = capture((async () => {
      try { await c.click('A', '#late', { timeout: 180 }); }
      catch (error) {
        assert.match(String(error), /Timeout/); c.log({ kind: 'retry-scheduled', task: 'A' }); scheduled.resolve();
        await backoff.promise; return c.click('A', '#late');
      }
    })());
    await scheduled.promise; c.controls.A.stop();
    await c.a.evaluate(() => window.lab.releaseLate()); backoff.resolve();
    const outcome = await pending; c.rejectStopped(outcome); await c.advanceB();
    assert.equal(lab.count(c.scope, 'A', 'late'), 0);
    const calls = lab.events.filter(event => event.scope === c.scope && event.kind === 'dispatch' && event.task === 'A');
    assert.equal(calls.length, 1);
    return { outcome, dispatchedAttempts: calls.length };
  }],
  ['late-provider-response', 'uncancelled provider response is consumed without creating a browser action', async c => {
    const gate = lab.hold(c.scope, 'A', 'model');
    const pending = capture((async () => {
      const response = await fetch(lab.base + '/model?' + new URLSearchParams({ scope: c.scope, task: 'A', kind: 'model' }));
      await response.json(); c.log({ kind: 'provider-replied', task: 'A' }); return c.click('A', '#increment');
    })());
    await c.accepted('model', '/model'); c.controls.A.stop(); await c.advanceB(1); gate.resolve();
    const outcome = await pending; c.rejectStopped(outcome); await c.advanceB();
    assert.equal(lab.count(c.scope, 'A', 'count'), 0);
    return { outcome, providerCancelled: false, model: 'local HTTP stub' };
  }],
  ['stale-response-after-new-execution', 'old work cannot use a fresh execution even after active becomes true again', async c => {
    const gate = deferred();
    const pending = capture(gate.promise.then(() => c.click('A', '#increment')));
    c.controls.A.stop(); await c.controls.A.settled();
    const fresh = c.controls.A.startNewExecution();
    await c.click('A', '#increment', {}, fresh); await c.rendered(c.a, 'count', 1);
    gate.resolve(); const stale = await pending; c.rejectStopped(stale); await c.advanceB();
    assert.equal(lab.count(c.scope, 'A', 'count'), 1);
    return { stale, oldGeneration: c.tickets.A.generation, newGeneration: fresh.generation, count: 1 };
  }],
  ...['submit', 'upload'].map(operation => [operation + '-already-accepted', 'aborting response waiting does not undo work already accepted by the website', async c => {
    const gate = lab.hold(c.scope, 'A', operation);
    const wait = capture(c.controls.A.dispatch(c.tickets.A, 'wait-for-' + operation, signal => c.a.waitForResponse(response => response.url().includes('kind=' + operation), { signal, timeout: 3000 })));
    if (operation === 'submit') await c.click('A', '#submit');
    else await c.controls.A.dispatch(c.tickets.A, 'upload-file', signal => c.a.locator('#upload').setInputFiles({ name: 'controlled-sample.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(65536, 65) }, { signal }));
    const receipt = await c.accepted(operation); c.controls.A.stop();
    const outcome = await wait; c.rejectStopped(outcome); await c.advanceB(1); gate.resolve();
    await c.rendered(c.a, operation, 1); const next = await capture(c.click('A', '#increment')); c.rejectStopped(next);
    await c.advanceB(); assert.equal(lab.count(c.scope, 'A', operation), 1); assert.equal(lab.count(c.scope, 'A', 'count'), 0);
    return { outcome, receipt, websiteResult: 1, followingAction: next };
  }]),
  ['opaque-command-negative', 'uncooperative work dispatched inside the browser can act after outer cancellation', async c => {
    const gate = lab.hold(c.scope, 'A', 'opaque');
    const session = await c.a.context().newCDPSession(c.a);
    const pending = capture(c.controls.A.dispatch(c.tickets.A, 'opaque-cdp-command', () => session.send('Runtime.evaluate', { expression: 'window.lab.opaque()', awaitPromise: true, returnByValue: true })));
    await c.accepted('opaque', '/permit'); c.controls.A.stop(); await c.advanceB(1); gate.resolve();
    const outcome = await pending; c.rejectStopped(outcome); await c.rendered(c.a, 'count', 1); await c.advanceB();
    await session.detach(); assert.equal(lab.count(c.scope, 'A', 'count'), 1);
    return { outcome, unwantedBrowserAction: 1, limitation: 'dispatch fence rejects result but cannot preempt an opaque command already running inside the browser' };
  }]
];

let host;
try {
  for (const kind of ['electron-cdp', 'chromium-cdp']) {
    host = await openHost(kind); metadata[kind] = host.versions;
    host.pages.forEach(page => page.setDefaultTimeout(2500));
    for (const [name, expected, body] of scenarios) await runCase(kind, host, name, expected, body);
    await host.close(); host = undefined;
  }
} catch (error) { metadata.fatal = String(error); console.error(error); process.exitCode = 1; }
finally {
  lab.releaseAll(); await host?.close().catch(() => {});
  metadata.endedAt = new Date().toISOString(); await save(); await lab.close();
  const failures = results.filter(result => result.status !== 'passed');
  if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify({ directory: out, checks: results.length, failures: failures.map(result => [result.host, result.name]) }));
}
