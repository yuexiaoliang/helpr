import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { spend, validationRoot } from './workspace-budget.mjs';

const appPath = path.join(os.homedir(), 'Applications/helpr.app');
const helper = path.join(validationRoot, 'dock-roles');
execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-Wall', '-Wextra', '-Werror', 'scripts/dock-roles.m', '-o', helper]);
const root = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.realpathSync(root) !== root) throw Error('INVALID_TEST_ROOT');
const reopen = process.argv.indexOf('--reopen');
const data = reopen < 0 ? fs.mkdtempSync(path.join(root, 'dock-')) : process.argv[reopen + 1];
if (!data || path.dirname(data) !== root || !/^dock-[A-Za-z0-9]+$/.test(path.basename(data)) || fs.realpathSync(data) !== data) throw Error('INVALID_DOCK_PROFILE');
const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const budget = spend('starts');
const child = spawn(path.join(appPath, 'Contents/MacOS/helpr'), ['--workspace-validation'], { env: { ...env, HELPR_VALIDATION_DATA: data }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const result = { started: new Date().toISOString(), start: budget.used.starts, profile: data, reopened: reopen >= 0, source: 'read-only NSRunningApplication activationPolicy; not CUA or Dock clicking' };
let pids = [child.pid];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async test => { const end = Date.now() + 10000; while (Date.now() < end) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('DOCK_VALIDATION_TIMEOUT'); };
try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('APPLICATION_NOT_READY')), 15000);
    child.on('message', m => { if (m.ready) { clearTimeout(timer); resolve(m); } });
    child.once('exit', () => { clearTimeout(timer); reject(Error('APPLICATION_EXITED')); });
  });
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  let added = true;
  while (added) { added = false; for (const [pid, parent] of rows) if (pids.includes(parent) && !pids.includes(pid)) { pids.push(pid); added = true; } }
  result.roles = JSON.parse(execFileSync(helper, [appPath, String(child.pid), String(ready.hostPid)], { encoding: 'utf8', timeout: 5000 }));
  result.regularApplications = result.roles.filter(r => r.activationPolicy === 0).length;
  result.passed = result.regularApplications === 1 && result.roles[0].activationPolicy === 1 && result.roles[1].activationPolicy === 0;
  if (!result.passed) { result.error = 'TWO_DOCK_APPLICATIONS'; process.exitCode = 1; }
  child.send({ id: 1, command: { kind: 'quit' } });
  await waitFor(() => child.exitCode !== null && pids.every(pid => !alive(pid)));
  if (child.exitCode !== 0) throw Error('QUIT_FAILED');
  result.normalQuitAndAllObservedProcessesEnded = true;
} catch (error) { result.passed = false; result.error = error.message; process.exitCode = 1; }
finally {
  if (alive(child.pid)) { spend('cleanups'); child.kill('SIGKILL'); }
  await waitFor(() => pids.every(pid => !alive(pid))).catch(() => {});
  result.noObservedProcessesRemain = pids.every(pid => !alive(pid));
  fs.writeFileSync(path.join(validationRoot, `dock-${result.start}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
