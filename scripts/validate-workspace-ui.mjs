import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture } from './workspace-fixture.mjs';
import { spend, validationRoot } from './workspace-budget.mjs';

// 界面操作由 CUA 完成；此父进程只提供本机网站、独立事实和既有验证入口。
execFileSync(process.execPath, ['scripts/validate-workspace.mjs', '--preflight'], { stdio: 'inherit' });
const installed = path.join(os.homedir(), 'Applications/helpr.app');
const buildArg = process.argv.indexOf('--build');
const build = buildArg < 0 ? 7 : Number(process.argv[buildArg + 1]);
assert(Number.isSafeInteger(build) && build >= 7);
const manifest = JSON.parse(fs.readFileSync(path.join(validationRoot, `build-${build}.json`)));
const sha = createHash('sha256').update(fs.readFileSync(path.join(installed, 'Contents/Resources/app.asar'))).digest('hex');
assert.equal(sha, manifest.hashes['Contents/Resources/app.asar']);
for (const [file, hash] of Object.entries(manifest.hashes))
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(installed, file))).digest('hex'), hash, file);
const profileRoot = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
assert.equal(fs.realpathSync(profileRoot), profileRoot);
const profile = fs.mkdtempSync(path.join(profileRoot, 'ui-'));
const output = path.join(validationRoot, `ui-${Date.now()}`);
fs.mkdirSync(output, { mode: 0o700 });
const website = await fixture();
const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const evidence = { started: new Date().toISOString(), build, archiveSHA256: sha, attemptedStarts: [], starts: [], exits: [], checks: [], website: website.receipts, source: 'CUA drives UI; inherited test channel reads records and sets test window size only' };
let child, sequence = 0, pending = new Map(), observed = [], beforeRestart, restoreReceiptOffset;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const write = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
function descendants(pid) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const pids = new Set([pid]);
  let added = true;
  while (added) { added = false; for (const [p, parent] of rows) if (pids.has(parent) && !pids.has(p)) { pids.add(p); added = true; } }
  return [...pids];
}
function request(command) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('REQUEST_TIMEOUT')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, command });
  });
}
const facts = s => s.tasks.map(t => [t.id, t.goal, t.url, t.draft, t.messages, t.hidden, t.minimized]);
async function launch() {
  const budget = spend('starts');
  evidence.attemptedStarts.push({ start: budget.used.starts, at: new Date().toISOString() });
  child = spawn(path.join(installed, 'Contents/MacOS/helpr'), ['--workspace-validation'], { env: { ...env, HELPR_VALIDATION_DATA: profile }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  observed = [child.pid];
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('APPLICATION_NOT_READY')), 15000);
    child.on('message', message => {
      if (message.launching && Number.isSafeInteger(message.hostPid) && Number.isSafeInteger(message.launcherPid))
        observed = [...new Set([...observed, message.hostPid, message.launcherPid, ...descendants(child.pid)])];
      if (message.ready) { clearTimeout(timer); resolve(message); }
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(Error(message.error)) : entry.resolve(message.value); }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('APPLICATION_EXITED')); }
      pending.clear();
      evidence.exits.push({ code, signal, observedPids: [...observed] });
      reject(Error('APPLICATION_EXITED'));
    });
  });
  observed = [...new Set([...observed, ...descendants(child.pid)])];
  evidence.starts.push({ start: budget.used.starts, ready });
  if (beforeRestart) {
    const restored = await request({ kind: 'snapshot' });
    assert.deepEqual(facts(restored), facts(beforeRestart));
    assert.equal(restored.active, beforeRestart.active);
    evidence.checks.push({ name: 'CUA 创建和输入的原任务、对话、草稿、标签在冷重开后保留', passed: true });
  }
  console.log('UI_READY ' + JSON.stringify({ output, website: website.base, start: budget.used.starts }));
}
let finished = false;
const deadline = Date.now() + 30 * 60 * 1000;
try {
  await launch();
  while (!finished && Date.now() < deadline) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        const snapshot = await request({ kind: 'snapshot' });
        observed = [...new Set([...observed, ...descendants(child.pid)])];
        beforeRestart = snapshot;
        write('snapshot.json', snapshot);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) throw error;
      }
    }
    write('receipts.json', website.receipts);
    write('progress.json', evidence);
    const commandFile = path.join(output, 'command.json');
    if (fs.existsSync(commandFile)) {
      const command = JSON.parse(fs.readFileSync(commandFile));
      fs.unlinkSync(commandFile);
      if (command.kind === 'restart') {
        assert.notEqual(child.exitCode, null, '先经真实 UI 退出');
        assert(observed.every(pid => !alive(pid)), '仍有自有进程');
        restoreReceiptOffset = website.receipts.length;
        await launch();
      } else if (command.kind === 'resize') {
        assert(Number.isInteger(command.width) && Number.isInteger(command.height));
        await request(command);
      } else if (command.kind === 'inspect') write('inspection.json', await request(command));
      else if (command.kind === 'finish') {
        assert.notEqual(child.exitCode, null, '先经真实 UI 退出');
        assert(observed.every(pid => !alive(pid)));
        assert.equal(evidence.starts.length, 2);
        assert.equal(beforeRestart.tasks.length, 2);
        assert(website.receipts.some(r => r.kind === 'login' && r.task === 'A'));
        assert(website.receipts.slice(restoreReceiptOffset).some(r => r.kind === 'page' && r.task === 'A' && r.authenticated));
        for (const task of ['A', 'B']) assert(website.receipts.some(r => r.kind === 'probe' && r.task === task && r.node === 'undefined' && r.require === 'undefined' && r.bridge === 'undefined'));
        evidence.checks.push({ name: 'CUA 点击本机虚构登录后，冷重开由网站独立确认会话有效', passed: true });
        evidence.checks.push({ name: '界面明确退出后独立核对全部已见自有进程结束', passed: true });
        finished = true;
      } else if (command.kind === 'abort') throw Error('CUA_UI_ROUND_ABORTED');
      else throw Error('UNSUPPORTED_UI_PROBE_COMMAND');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(finished, 'UI_ROUND_TIMEOUT');
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; }
finally {
  if (child?.exitCode === null && child?.signalCode === null) { spend('cleanups'); child.kill('SIGKILL'); }
  const cleanupEnd = Date.now() + 3000;
  while (Date.now() < cleanupEnd && observed.some(alive)) await new Promise(resolve => setTimeout(resolve, 50));
  await website.close();
  evidence.remainingObservedPids = observed.filter(alive);
  write('result.json', evidence);
  console.log('UI_RESULT ' + JSON.stringify({ passed: evidence.passed, error: evidence.error, output }));
}
