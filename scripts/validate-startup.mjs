import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { spend, validationRoot } from './workspace-budget.mjs';

// 独立外部父进程，正常启动最终 .app 的可执行文件；不启用 Node inspector。
const exe = path.resolve('dist/packages/mac-arm64/helpr.app/Contents/MacOS/helpr');
const outside = fs.mkdtempSync('/private/tmp/helpr-startup-denial-');
const evidence = { checks: [], started: new Date().toISOString() };
let active;
try {
  for (const [name, args, env] of [
    ['单横线裸调试参数被最终包拒绝', ['-remote-debugging-port=0'], {}],
    ['外部 Node 父进程与继承 IPC 不能冒用宿主', ['--workspace-host', '--remote-debugging-pipe'], { HELPR_WORKSPACE_DATA: outside }],
    ['验证入口不能采用固定测试根之外的资料', ['--workspace-validation'], { HELPR_VALIDATION_DATA: outside }],
  ]) {
    spend('starts');
    const child = spawn(exe, args, { env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env }, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc'] });
    active = child;
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error('DENIAL_DID_NOT_EXIT'));
      }, 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (status) => { clearTimeout(timer); resolve(status); });
    });
    assert.equal(code, 1);
    let gone = false;
    try { process.kill(child.pid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
    assert(gone);
    assert.deepEqual(fs.readdirSync(outside), []);
    evidence.checks.push({ name, passed: true, exitCode: code });
    console.log('通过：' + name);
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.code ?? error.message;
  process.exitCode = 1;
} finally {
  if (active?.exitCode === null) {
    spend('cleanups');
    active.kill('SIGKILL');
  }
  fs.writeFileSync(path.join(validationRoot, 'startup-denials.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.rmSync(outside, { recursive: true, force: true });
}
