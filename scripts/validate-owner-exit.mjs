import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { spend, validationRoot } from './workspace-budget.mjs';

const early = process.argv.includes('--early');
const appPath = path.join(os.homedir(), 'Applications/helpr.app');
const profileRoot = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
if (fs.realpathSync(profileRoot) !== profileRoot) throw Error('INVALID_TEST_ROOT');
const data = fs.mkdtempSync(path.join(profileRoot, 'owner-exit-'));
const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function descendants(root) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const pids = new Set([root]);
  let added = true;
  while (added) { added = false; for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); added = true; } }
  return [...pids];
}
spend('starts');
const child = spawn(path.join(appPath, 'Contents/MacOS/helpr'), ['--workspace-validation'], { env: { ...env, HELPR_VALIDATION_DATA: data, ...(early ? { HELPR_VALIDATION_PAUSE_START: '1' } : {}) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const result = { started: new Date().toISOString(), case: early ? 'controller exits before host JavaScript starts' : 'controller exits while host cannot process callbacks', pids: [] };
try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('APPLICATION_NOT_READY')), 10000);
    child.on('message', m => { if (early ? m.launching : m.ready) { clearTimeout(timer); resolve(m); } });
    child.once('exit', () => { clearTimeout(timer); reject(Error('APPLICATION_EXITED')); });
  });
  result.pids = descendants(child.pid);
  if (!early) process.kill(ready.hostPid, 'SIGSTOP');
  spend('faults');
  child.kill('SIGKILL');
  const end = Date.now() + 3000;
  while (Date.now() < end && result.pids.some(alive)) await new Promise(resolve => setTimeout(resolve, 50));
  result.remaining = result.pids.filter(alive);
  result.passed = result.remaining.length === 0;
  if (!result.passed) { process.exitCode = 1; result.error = 'OWNED_HOST_REMAINS'; }
} catch (error) { result.passed = false; result.error = error.message; process.exitCode = 1; }
finally {
  const left = result.pids.length ? result.pids.filter(alive) : descendants(child.pid).filter(alive);
  if (left.length) {
    spend('cleanups');
    for (const pid of left.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    const end = Date.now() + 3000;
    while (Date.now() < end && left.some(alive)) await new Promise(resolve => setTimeout(resolve, 50));
    result.cleaned = left.every(pid => !alive(pid));
  }
  fs.writeFileSync(path.join(validationRoot, early ? 'blocked-owner-startup.json' : 'blocked-owner-exit.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, error: result.error, remaining: result.remaining, cleaned: result.cleaned }));
}
