import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openRun, readStatus } from './control.mjs';
import { modelSession } from './model.mjs';
import { planExperiment } from './plan.mjs';

async function fixture(t, limits = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'helpr-control-'));
  const runs = [];
  t.after(async () => { for (const run of runs) await run.close(); await rm(directory, { recursive: true, force: true }); });
  let requests = 0, hold = false;
  const requestPaths = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests++; requestPaths.push(req.url); server.emit('fixture-request');
    if (hold) return;
    const pageId = input.tools[0].function.parameters.properties.pageId.enum[0];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
      function: { name: 'propose', arguments: JSON.stringify({ op: 'finish', pageId, role: '', name: '', valueInput: '', reply: '完成' }) },
    }] } }], usage: { total_tokens: 3 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { protocol: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', timeoutMs: 1000, requestOptions: {} };
  const ledgerPath = path.join(directory, 'study.json');
  const registration = { id: 'fixture-study', limits: { calls: 96, tokens: 1_000_000, revisions: 2, ...limits }, deadline: Date.now() + 60000 };
  const options = { ledgerPath, registration, fingerprint: { execution: 'v1', revision: 'v1' } };
  async function start(output = 'first', fingerprint = options.fingerprint) {
    const run = await openRun({ ...options, fingerprint, output: path.join(directory, output) });
    const model = await modelSession(path.join(directory, output), () => {}, { run, config, apiKey: 'fixture-key' });
    runs.push(run);
    return { run, model };
  }
  return { directory, ledgerPath, registration, options, config, start, requests: () => requests, requestPaths: () => requestPaths,
    holdRequests() { hold = true; }, nextRequest: () => once(server, 'fixture-request') };
}
const task = () => ({ active: true, abort: new AbortController(), inputs: {}, history: [], goal: '完成夹具',
  lease: { task: 'fixture/A', execution: 'fixture-execution', generation: 1 } });
const pages = [{ pageId: 'fixture-page', snapshot: '操作已完成' }];

test('第 97 次模型请求在换输出目录并重启后仍被拒绝', async t => {
  const f = await fixture(t);
  const first = await f.start();
  for (let n = 0; n < 96; n++) await first.model.propose(task(), pages);
  await first.run.close();
  const resumed = await f.start('supplement');
  await assert.rejects(resumed.model.propose(task(), pages), /call-budget/);
  assert.equal(f.requests(), 96);
  assert.equal((await readStatus(f.ledgerPath)).budget.callsRemaining, 0);
});

test('同一账本拒绝第二个活跃写入者', async t => {
  const f = await fixture(t);
  await f.start();
  await assert.rejects(f.start('concurrent'), /study-locked/);
  assert.equal(f.requests(), 0);
});

test('请求在途时进程被终止，重启保持调用和未知 token 预留', { timeout: 10000 }, async t => {
  const f = await fixture(t, { calls: 1 }); f.holdRequests();
  const accepted = f.nextRequest();
  const child = fork(new URL('./fixtures/control-child.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.send({ ...f.options, output: path.join(f.directory, 'child'), config: f.config });
  await Promise.race([accepted, once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const pending = await readStatus(f.ledgerPath);
  assert.equal(pending.budget.callsRemaining, 0); assert(pending.budget.heldTokens > 0);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const resumed = await f.start('after-crash');
  await assert.rejects(resumed.model.propose(task(), pages), /call-budget/);
  assert.equal(f.requests(), 1);
  assert.equal((await readStatus(f.ledgerPath)).budget.heldTokens, pending.budget.heldTokens);
});

test('程序修订超限在新运行开始时被拒绝，相同版本可继续', async t => {
  const f = await fixture(t, { revisions: 1 });
  const first = await f.start(); await first.run.close();
  const changed = await f.start('changed', { execution: 'v2', revision: 'v2' }); await changed.run.close();
  const same = await f.start('same', { execution: 'v2', revision: 'v2' }); await same.run.close();
  await assert.rejects(f.start('too-many', { execution: 'v3', revision: 'v3' }), /revision-budget/);
  assert.equal(f.requests(), 0);
});

test('截图等待期间功能结果已保存；截图失败和重启不会重复调用模型', async t => {
  const f = await fixture(t);
  const { run, model } = await f.start();
  const gate = Promise.withResolvers(), capturing = Promise.withResolvers();
  const pending = run.runCase({ key: 'fixture:one',
    execute: async () => ({ reply: (await model.propose(task(), pages)).reply }),
    capture: async () => { capturing.resolve(); await gate.promise; throw new Error('hidden-view'); },
  });
  await capturing.promise;
  const status = await readStatus(f.ledgerPath);
  assert.equal(status.current.phase, 'capture');
  assert.equal(status.results[0].status, 'passed');
  gate.resolve(); await pending;
  assert.equal((await readStatus(f.ledgerPath)).results[0].capture.status, 'failed');
  await run.close();
  const resumed = await f.start('continued');
  const result = await resumed.run.runCase({ key: 'fixture:one', execute: () => resumed.model.propose(task(), pages) });
  assert.equal(result.skipped, true); assert.equal(f.requests(), 1);
});

test('取消且无 usage 的请求保留 token 预留，状态明确显示未知用量', async t => {
  const f = await fixture(t, { tokens: 3000 }); f.holdRequests();
  const { run, model } = await f.start(), a = task();
  const accepted = f.nextRequest(), pending = model.propose(a, pages);
  await accepted; a.abort.abort();
  await assert.rejects(pending, /client-aborted/);
  const status = await readStatus(f.ledgerPath);
  assert.equal(status.unknownUsage.length, 1); assert(status.budget.heldTokens > 0);
  await run.close();
  const next = await f.start('after-cancel');
  await assert.rejects(next.model.propose(task(), pages), /token-budget/);
  assert.equal(f.requests(), 1);
});

test('只读计划随功能依赖失效，截图实现变化仍复用已通过结果', async t => {
  const f = await fixture(t);
  const directory = path.join(f.directory, 'project', 'ai-parallel-binding');
  const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
  await cp(sourceDirectory, directory, { recursive: true,
    filter: source => !path.relative(sourceDirectory, source).split(path.sep).some(part => ['artifacts', 'private', 'node_modules', 'fixtures'].includes(part)) });
  for (const file of ['model-api/client.mjs', 'independent-stop/control.mjs', 'independent-stop/package.json', 'independent-stop/package-lock.json']) {
    const target = path.join(directory, '..', file); await mkdir(path.dirname(target), { recursive: true });
    await cp(new URL('../' + file, import.meta.url), target);
  }
  const options = { directory, ledgerPath: f.ledgerPath, registration: f.registration, config: f.config, cases: ['fixture:one'] };
  const firstPlan = await planExperiment(options);
  const { run, model } = await f.start('one', firstPlan.fingerprint);
  await run.runCase({ key: 'fixture:one', execute: () => model.propose(task(), pages) }); await run.close();
  assert.deepEqual((await planExperiment(options)).remaining, []);
  const before = await readFile(f.ledgerPath);
  for (const file of ['run.mjs', 'host.mjs', 'extension/background.js', '../model-api/client.mjs', '../independent-stop/control.mjs', '../independent-stop/package-lock.json']) {
    const target = path.join(directory, file), original = await readFile(target);
    await writeFile(target, Buffer.concat([original, Buffer.from('\n ')]));
    assert.deepEqual((await planExperiment(options)).remaining, ['fixture:one'], file);
    await writeFile(target, original);
  }
  assert.deepEqual((await planExperiment({ ...options, config: { ...f.config, model: 'changed-model' } })).remaining, ['fixture:one']);
  const capture = path.join(directory, 'capture.mjs');
  await writeFile(capture, (await readFile(capture, 'utf8')) + '\n// changed screenshot destination\n');
  assert.deepEqual((await planExperiment(options)).remaining, []);
  assert((await readFile(f.ledgerPath)).equals(before));
});

test('真实 CLI 在全新输出目录也显示历史 113 次调用和已耗尽的原预算', async t => {
  const f = await fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), path.join(f.directory, 'new-output'), '--plan']);
  const plan = JSON.parse(stdout);
  assert.equal(plan.budget.calls, 113); assert.equal(plan.budget.callsRemaining, 0);
  assert.equal(plan.remaining.length, 18);
});

test('地址尾随斜杠不改变计划指纹或实际模型请求路径', async t => {
  const f = await fixture(t);
  const config = { ...f.config, baseUrl: f.config.baseUrl + '/' };
  const options = { directory: fileURLToPath(new URL('.', import.meta.url)), ledgerPath: f.ledgerPath,
    registration: f.registration, config: f.config, cases: ['fixture:one'] };
  const before = await planExperiment(options), after = await planExperiment({ ...options, config });
  assert.equal(after.fingerprint.execution, before.fingerprint.execution);
  const { run, model } = await f.start('first', before.fingerprint);
  await model.propose(task(), pages);
  const normalized = await modelSession(path.join(f.directory, 'slash'), () => {}, { run, config, apiKey: 'fixture-key' });
  await normalized.propose(task(), pages);
  assert.deepEqual(f.requestPaths(), ['/chat/completions', '/chat/completions']);
});

test('账本损坏或已登记账本丢失时拒绝续跑并保持原文件', async t => {
  const f = await fixture(t, { calls: 1 });
  const first = await f.start(); await first.model.propose(task(), pages); await first.run.close();
  const original = await readFile(f.ledgerPath);
  for (const damaged of ['{', '{}']) {
    await writeFile(f.ledgerPath, damaged);
    await assert.rejects(f.start('corrupt'));
    await assert.rejects(readStatus(f.ledgerPath));
    assert.equal(await readFile(f.ledgerPath, 'utf8'), damaged);
  }
  await writeFile(f.ledgerPath, original); await rm(f.ledgerPath);
  await assert.rejects(f.start('missing'), /study-record-missing/);
  assert.equal(f.requests(), 1);
});

test('补截图复用留存采集入口；清理失败保留功能结果，重启后不伪造原页面', async t => {
  const f = await fixture(t), { run, model } = await f.start();
  let captures = 0;
  await run.runCase({ key: 'fixture:one', execute: () => model.propose(task(), pages),
    capture: async () => { if (++captures === 1) throw new Error('reveal-failed'); return ['retained-page.png']; },
    cleanup: async () => { throw new Error('cleanup-failed'); },
  });
  const retry = await run.collectEvidence('fixture:one');
  assert.equal(retry.status, 'passed'); assert.equal(f.requests(), 1);
  const status = await readStatus(f.ledgerPath);
  assert.equal(status.results[0].status, 'passed'); assert.equal(status.results[0].cleanup.status, 'failed');
  await run.close();
  const resumed = await f.start('restart');
  await assert.rejects(resumed.run.collectEvidence('fixture:one'), /capture-source-unavailable/);
  assert.equal(f.requests(), 1);
});

test('请求准备期间跨过截止时间，网络请求仍被拦截', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t); f.registration.deadline = now + 1000;
  const { run } = await f.start();
  const model = await modelSession(path.join(f.directory, 'delayed'), event => {
    if (event.kind === 'model-start') now = f.registration.deadline + 1;
  }, { run, config: f.config, apiKey: 'fixture-key' });
  await assert.rejects(model.propose(task(), pages), /time-budget/);
  assert.equal(f.requests(), 0);
});

test('采集截图时进程被终止，重启跳过功能执行并标明原页面丢失', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const child = fork(new URL('./fixtures/control-child.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const capturing = once(child, 'message');
  child.send({ ...f.options, output: path.join(f.directory, 'child'), config: f.config, mode: 'capture' });
  await capturing;
  assert.equal((await readStatus(f.ledgerPath)).results[0].status, 'passed');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const resumed = await f.start('resumed');
  const result = await resumed.run.runCase({ key: 'fixture:one', execute: () => resumed.model.propose(task(), pages) });
  assert.equal(result.skipped, true); assert.equal(f.requests(), 1);
  assert.equal((await readStatus(f.ledgerPath)).results[0].capture.status, 'unavailable');
});

test('并发请求争用最后一次额度时只发送一次', async t => {
  const f = await fixture(t, { calls: 1 }), { model } = await f.start();
  const results = await Promise.allSettled([model.propose(task(), pages), model.propose(task(), pages)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.message, 'call-budget');
  assert.equal(f.requests(), 1);
});

test('CLI 在预算耗尽时退出，损坏的选择计划报错，均不创建输出目录', async t => {
  const f = await fixture(t), script = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const output = path.join(f.directory, 'new-output');
  await assert.rejects(promisify(execFile)(process.execPath, [script, output]), error =>
    error.code === 1 && error.stderr.includes('experiment-budget-exhausted'));
  await assert.rejects(readFile(output + '/results.json'), { code: 'ENOENT' });
  await mkdir(output); await writeFile(output + '/PLAN.json', '{');
  await assert.rejects(promisify(execFile)(process.execPath, [script, output, '--plan']), error => error.code === 1 && error.stderr.includes('SyntaxError'));
  assert.equal(await readFile(output + '/PLAN.json', 'utf8'), '{');
});
