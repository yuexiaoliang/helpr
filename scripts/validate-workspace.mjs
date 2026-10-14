import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spend, validationRoot } from './workspace-budget.mjs';
import { fixture } from './workspace-fixture.mjs';

// 可见工作区验收须先确认系统现场；锁屏或受保护输入不消耗应用额度。
let registry;
try {
  registry = execFileSync('/usr/sbin/ioreg', ['-l', '-w', '0'], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024,
  });
} catch { throw Error('MAC_SESSION_UNAVAILABLE'); }
if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(registry)) throw Error('MAC_SCREEN_LOCKED');
if ([...registry.matchAll(/"kCGSSessionSecureInputPID"\s*=\s*(\d+)/g)].some((match) => Number(match[1]) > 0)) throw Error('MAC_PROTECTED_INPUT_ACTIVE');
if (process.argv.includes('--preflight')) {
  console.log('本机现场预检未发现锁屏或受保护输入；尚未启动应用。');
  process.exit(0);
}

// 正常运行最后产物；继承通道只调用实际工作区的受限命令，没有调试端口。
const built = path.resolve('dist/packages/mac-arm64/helpr.app');
const installed = path.join(os.homedir(), 'Applications/helpr.app');
const install = process.argv.includes('--install');
if (install) {
  if (fs.existsSync(installed))
    throw Error('EXISTING_INSTALLATION_MUST_BE_PRESERVED');
  spend('installs');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  execFileSync('/usr/bin/ditto', [built, installed]);
}
const appPath = install || process.argv.includes('--installed') ? installed : built;
const exe = path.join(appPath, 'Contents/MacOS/helpr');
const out = path.join(validationRoot, `run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
// 与产品启动守卫相同的固定根；不接受 TMPDIR 指向正式资料。
const profileRoot = path.join(fs.realpathSync('/private/tmp'), `helpr-workspace-validation-${process.getuid()}`);
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
if (fs.realpathSync(profileRoot) !== profileRoot) throw Error('VALIDATION_PROFILE_REQUIRED');
const data = fs.mkdtempSync(path.join(profileRoot, 'run-'));
const website = await fixture();
const started = Date.now();
const checks = [];
let app;
let lastPids = [];
const evidence = {
  app: appPath,
  started: new Date().toISOString(),
  checks,
  samples: [],
  fixture: website.receipts,
};
const deadline = setTimeout(
  () => {
    app?.kill('SIGTERM');
    process.exitCode = 1;
  },
  30 * 60 * 1000,
);
function check(name, test) {
  test();
  checks.push({ name, passed: true });
  console.log('通过：' + name);
}
async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('VALIDATION_TIMEOUT');
}
function ownedPids(root) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
  }
  return [...owned];
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function launch() {
  spend('starts');
  const start = Date.now();
  const env = Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const child = spawn(exe, ['--workspace-validation'], {
    env: { ...env, HELPR_VALIDATION_DATA: data },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  app = child;
  child.stdout.pipe(
    fs.createWriteStream(path.join(out, `stdout-${child.pid}.log`)),
  );
  child.stderr.pipe(
    fs.createWriteStream(path.join(out, `stderr-${child.pid}.log`)),
  );
  const pending = new Map();
  let sequence = 0;
  let ready;
  const readiness = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('APPLICATION_NOT_READY')),
      15000,
    );
    child.on('message', (message) => {
      if (message.ready) {
        ready = message;
        clearTimeout(timer);
        resolve();
      }
      if (message.id && pending.has(message.id)) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(p.timer);
        message.error
          ? p.reject(Error(message.error))
          : p.resolve(message.value);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('APPLICATION_EXITED'));
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('APPLICATION_EXITED'));
      }
      pending.clear();
    });
  });
  await readiness;
  evidence.samples.push({
    kind: 'startup',
    ms: Date.now() - start,
    versions: ready.versions,
  });
  lastPids = [child.pid, ready.hostPid, ready.recordsPid];
  return {
    child,
    ready,
    request: (command) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('REQUEST_TIMEOUT'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, command });
      }),
    quit: async () => {
      child.send({ id: ++sequence, command: { kind: 'quit' } });
      await waitFor(() => child.exitCode !== null);
      assert.equal(child.exitCode, 0);
      await waitFor(() => lastPids.every((pid) => !alive(pid)));
    },
  };
}
const command = (kind, fields = {}) => ({
  kind,
  requestId: randomUUID(),
  ...fields,
});
try {
  let client = await launch();
  const a = (
    await client.request(
      command('create', {
        goal: '核对任务 A ' + website.base + '/page?task=A',
      }),
    )
  ).taskId;
  const b = (
    await client.request(
      command('create', {
        goal: '核对任务 B ' + website.base + '/page?task=B',
      }),
    )
  ).taskId;
  await waitFor(
    () =>
      website.receipts.some((r) => r.kind === 'probe' && r.task === 'A') &&
      website.receipts.some((r) => r.kind === 'probe' && r.task === 'B'),
    10 * 60 * 1000,
  );
  check('两个真实页面都到达独立网站，网页没有 Node 或宿主对话桥', () => {
    const probes = website.receipts.filter((r) => r.kind === 'probe');
    assert(
      probes.every(
        (p) =>
          p.node === 'undefined' &&
          p.require === 'undefined' &&
          p.bridge === 'undefined',
      ),
    );
  });
  const observationA = await client.request({ kind: 'observe', taskId: a });
  const observationB = await client.request({ kind: 'observe', taskId: b });
  check('受管工作者仅取得自己的页面', () => {
    assert(observationA.frameTree.frame.url.endsWith('task=A'));
    assert(observationB.frameTree.frame.url.endsWith('task=B'));
  });
  for (const [job, code] of [
    [{ taskId: a, requestedTask: b }, 'TASK_NOT_OWNED'],
    [{ taskId: a, token: 'unowned' }, 'OBSERVATION_NOT_AUTHORIZED'],
    [
      { taskId: a, method: 'Runtime.evaluate' },
      'OBSERVATION_CAPABILITY_DENIED',
    ],
    [
      { taskId: a, method: 'Input.dispatchMouseEvent' },
      'OBSERVATION_CAPABILITY_DENIED',
    ],
  ]) {
    await assert.rejects(
      client.request({ kind: 'observe', ...job }),
      new RegExp(code),
    );
    checks.push({ name: code, passed: true });
  }
  await client.request(command('draft', { taskId: a, text: 'A 的独立草稿' }));
  await client.request(
    command('message', { taskId: b, text: '只属于 B 的要求' }),
  );
  await client.request(command('select', { taskId: a }));
  await waitFor(
    async () => (await client.request({ kind: 'snapshot' })).active === a,
  );
  if (process.argv.includes('--interactive')) {
    console.log('交互核对就绪：' + out + '/continue');
    await waitFor(
      () => fs.existsSync(path.join(out, 'continue')),
      10 * 60 * 1000,
    );
  }
  fs.writeFileSync(
    path.join(out, 'workspace-A.png'),
    Buffer.from(await client.request({ kind: 'capture' }), 'base64'),
  );
  // 本机虚构 Cookie 核对；真人点击登录的证据另行记录，GET 不充抵真人输入。
  await client.request(
    command('navigate', { taskId: a, url: website.base + '/login?task=A' }),
  );
  await waitFor(() =>
    website.receipts.some((r) => r.kind === 'page' && r.authenticated),
  );
  const saved = await client.request({ kind: 'snapshot' });
  const inspection = await client.request({ kind: 'inspect' });
  lastPids.push(...inspection.pids.map((p) => p.pid));
  evidence.samples.push({ kind: 'two-pages', metrics: inspection.pids });
  check('私有 pipe 开启且没有调试端口，系统 Cookie 加密可用', () => {
    assert(inspection.switches.pipe);
    assert(!inspection.switches.port && !inspection.switches.inspect);
    assert(inspection.encryptionAvailable);
  });
  let listeners = '';
  try {
    listeners = execFileSync(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', lastPids.join(','), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8' },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  check('独立客户端检查自有进程没有 TCP 控制监听', () =>
    assert.equal(listeners.trim(), ''),
  );
  lastPids = ownedPids(client.child.pid);
  await client.quit();
  checks.push({ name: '正常退出后独立核对所有已见自有进程结束', passed: true });
  const cookieFiles = execFileSync(
    '/usr/bin/find',
    [path.join(data, 'browser'), '-name', 'Cookies'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  check('实际 Cookie 文件没有明文会话，持久 Cookie 使用加密字段', () => {
    assert(cookieFiles.length);
    const db = new Database(cookieFiles[0], { readonly: true });
    const row = db
      .prepare('SELECT value,encrypted_value FROM cookies WHERE name=?')
      .get('helpr_fixture');
    db.close();
    assert(row);
    assert.equal(row.value, '');
    assert(row.encrypted_value.length > 0);
    assert(
      !fs.readFileSync(cookieFiles[0]).includes(Buffer.from(website.login)),
    );
  });
  const before = website.receipts.length;
  client = await launch();
  const restored = await client.request({ kind: 'snapshot' });
  check('冷重开保留两项身份、独立对话、草稿与当前标签', () => {
    assert.deepEqual(
      restored.tasks.map((t) => [t.id, t.goal, t.draft, t.messages]),
      saved.tasks.map((t) => [t.id, t.goal, t.draft, t.messages]),
    );
    assert.equal(restored.active, a);
  });
  await waitFor(() =>
    website.receipts
      .slice(before)
      .some((r) => r.kind === 'page' && r.task === 'A' && r.authenticated),
  );
  checks.push({ name: '冷重开后网站独立核对原虚构会话仍有效', passed: true });
  fs.writeFileSync(
    path.join(out, 'workspace-restored.png'),
    Buffer.from(await client.request({ kind: 'capture' }), 'base64'),
  );
  lastPids = ownedPids(client.child.pid);
  if (process.argv.includes('--fault')) {
    const baseline = await client.request({ kind: 'snapshot' });
    spend('faults');
    client.child.kill('SIGKILL');
    await waitFor(() => lastPids.every((pid) => !alive(pid)));
    checks.push({
      name: '控制拥有者意外退出后，自有网页和记录进程实际结束',
      passed: true,
    });
    client = await launch();
    const recovered = await client.request({ kind: 'snapshot' });
    check('意外退出后仍保留原任务和对话', () =>
      assert.deepEqual(
        recovered.tasks.map((t) => [t.id, t.goal, t.draft, t.messages]),
        baseline.tasks.map((t) => [t.id, t.goal, t.draft, t.messages]),
      ),
    );
    lastPids = ownedPids(client.child.pid);
  }
  await client.quit();
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  process.exitCode = 1;
  console.error('验证停止：' + error.message);
} finally {
  if (app?.exitCode === null) {
    try {
      spend('cleanups');
      app.kill('SIGKILL');
      await waitFor(() => lastPids.every((pid) => !alive(pid)));
    } catch {}
  }
  clearTimeout(deadline);
  await website.close();
  evidence.ms = Date.now() - started;
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log('证据：' + out);
}
