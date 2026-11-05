import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { rootCertificates } from 'node:tls';
import lockfile from 'proper-lockfile';
import { spend, validationRoot } from './workspace-budget.mjs';
import { fixture } from './workspace-fixture.mjs';

const args = process.argv.slice(2);
const flag = { type: 'boolean' };
const { values: options } = parseArgs({
  args,
  options: {
    fixture: flag,
    'system-storage': flag,
    preflight: flag,
    'input-preparation': flag,
    interactive: flag,
    fault: flag,
    'blocked-host': flag,
    install: flag,
    installed: flag,
    candidate: { type: 'string' },
    help: flag,
  },
});
if (options.help) {
  console.log(
    '无参数运行源码检查。--fixture [--candidate=名称] 运行隔离实包；--preflight 可预检选中的包。' +
      '\n--system-storage 专门验收系统钥匙串和持久登录。--interactive 在现场等待。',
  );
  process.exit(0);
}
if (args.length === 0) {
  if (
    process.platform === 'darwin' &&
    !['watch-owner', 'process-path', 'input-bridge.node'].every((file) =>
      fs.existsSync(path.join('dist/native', file)),
    )
  ) {
    execFileSync(process.execPath, ['scripts/build-native.mjs'], {
      stdio: 'inherit',
      timeout: 120000,
    });
  }
  execFileSync('pnpm', ['check'], { stdio: 'inherit', timeout: 5 * 60000 });
  console.log(
    '无人值守源码检查通过。真实窗口、系统凭据和真人输入按需在实机验收。',
  );
  process.exit(0);
}

const systemStorage = options['system-storage'] === true;
assert(!(systemStorage && options.fixture), 'CONFLICTING_STORAGE_MODES');
assert(!options['blocked-host'] || options.fault, 'FAULT_FLAG_REQUIRED');
assert(
  !options['input-preparation'] || (!options.interactive && !options.fault),
  'INPUT_PREPARATION_IS_A_SINGLE_CHECK',
);
const candidate = options.candidate;
if (candidate !== undefined && !/^[a-z0-9-]{1,40}$/.test(candidate))
  throw Error('INVALID_BUILD_CANDIDATE');
if ((options.install && options.installed) || (candidate && options.installed))
  throw Error('CANDIDATE_INSTALL_CONFLICT');
// 单独的 --preflight 仍供历史原生验收检查桌面。隔离实包不依赖桌面控制工具。
const nativePreflight = args.length === 1 && options.preflight;
let unavailableUI;
if (nativePreflight || options.interactive || systemStorage) {
  try {
    const registry = execFileSync('/usr/sbin/ioreg', ['-l', '-w', '0'], {
      encoding: 'utf8',
      timeout: options.preflight ? 60000 : 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(registry))
      unavailableUI = 'MAC_SCREEN_LOCKED';
    else if (
      [...registry.matchAll(/"kCGSSessionSecureInputPID"\s*=\s*(\d+)/g)].some(
        (match) => Number(match[1]) > 0,
      )
    )
      unavailableUI = 'MAC_PROTECTED_INPUT_ACTIVE';
  } catch {
    unavailableUI = 'MAC_SESSION_UNAVAILABLE';
  }
  if (unavailableUI && (nativePreflight || systemStorage))
    throw Error(unavailableUI);
  if (nativePreflight) {
    console.log('本机现场预检未发现锁屏或受保护输入；尚未启动应用。');
    process.exit(0);
  }
}
const built = path.resolve(
  candidate
    ? `dist/candidates/${candidate}/mac-arm64/helpr.app`
    : 'dist/packages/mac-arm64/helpr.app',
);
const userInstallation = path.join(os.homedir(), 'Applications/helpr.app');
const install = options.install;
const source = options.installed ? userInstallation : built;
fs.accessSync(path.join(source, 'Contents/MacOS/helpr'), fs.constants.X_OK);
if (!systemStorage) {
  // 已有开发包可能早于 fixture 协议，先核对固定候选，避免旧包启动后走真实钥匙串。
  const version = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleVersion', path.join(source, 'Contents/Info.plist')],
    { encoding: 'utf8', timeout: 5000 },
  ).trim();
  assert(
    /^[1-9]\d*$/.test(version) && Number.isSafeInteger(Number(version)),
    'WORKSPACE_FIXTURE_BUILD_REQUIRED: 请用 --candidate=名称 选择支持临时会话的固定包',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(validationRoot, `build-${version}.json`)),
  );
  const archive = fs.readFileSync(
    path.join(source, 'Contents/Resources/app.asar'),
  );
  const digest = createHash('sha256').update(archive).digest('hex');
  const hostArchive = path.join(source, 'Contents/Frameworks/helpr Workspace.app/Contents/Resources/app.asar');
  assert(
    manifest.prepared &&
      manifest.build === Number(version) &&
      manifest.hashes['Contents/Resources/app.asar'] === digest &&
      createHash('sha256').update(fs.readFileSync(hostArchive)).digest('hex') === digest &&
      archive.includes('--workspace-fixture') &&
      archive.includes('HELPR_FIXTURE_ORIGIN'),
    'WORKSPACE_FIXTURE_BUILD_REQUIRED',
  );
}
if (options.preflight) {
  console.log(
    JSON.stringify({
      app: source,
      storage: systemStorage ? 'system' : 'fixture',
      install: install
        ? systemStorage
          ? 'user-applications'
          : 'isolated'
        : null,
      interactive: Boolean(options.interactive),
      unavailableUI,
      appStarts: 0,
    }),
  );
  process.exit(0);
}
fs.mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
const release = lockfile.lockSync(validationRoot, {
  lockfilePath: path.join(validationRoot, 'workspace-run.lock'),
  stale: 3 * 60000, // 长于同步复制测试安装包的两分钟截止。
});
const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
  encoding: 'utf8',
  timeout: 5000,
});
const busy = processes
  .trim()
  .split('\n')
  .some((line) => {
    const [, pid, command] = line.trim().match(/^(\d+)\s+(.+)$/) ?? [];
    return (
      Number(pid) !== process.pid &&
      (/^\/.*\/helpr(?: Workspace)?\.app\/Contents\/MacOS\/helpr(?: |$)/.test(
        command,
      ) ||
        /^(?:\S*\/)?node\s+(?:\S*\/)?(?:validate-[\w-]+|capture-upgrade-legacy)\.mjs(?:\s|$)/.test(
          command,
        ))
    );
  });
assert(!busy, 'OTHER_VALIDATION_RUNNING');
let appPath = source;
if (install) {
  appPath = systemStorage
    ? userInstallation
    : path.join(
        fs.mkdtempSync(path.join(validationRoot, 'install-')),
        'helpr.app',
      );
  if (fs.existsSync(appPath))
    throw Error('EXISTING_INSTALLATION_MUST_BE_PRESERVED');
  spend('installs');
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  execFileSync('/usr/bin/ditto', [source, appPath], { timeout: 120000 });
}
const inputPreparation = options['input-preparation'];
const exe = path.join(appPath, 'Contents/MacOS/helpr');
const out = path.join(validationRoot, `run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
// 与产品启动守卫相同的固定根；不接受 TMPDIR 指向正式资料。
const profileRoot = path.join(
  fs.realpathSync('/private/tmp'),
  `helpr-workspace-validation-${process.getuid()}`,
);
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
if (fs.realpathSync(profileRoot) !== profileRoot)
  throw Error('VALIDATION_PROFILE_REQUIRED');
const data = fs.mkdtempSync(path.join(profileRoot, 'run-'));
const website = await fixture();
if (!systemStorage) {
  // 版本检查也留在回环地址。此 HTTP 夹具对 HTTPS 版本查询呈现离线状态。
  fs.writeFileSync(
    path.join(data, 'version-fixture.json'),
    JSON.stringify({
      source: website.base.replace('http:', 'https:') + '/stable.json',
      ca: rootCertificates[0],
    }),
    { mode: 0o600 },
  );
}
const started = Date.now();
const checks = [];
let app;
let lastPids = [];
let ownedGroups = new Set();
let processRecord;
let timedOut = false;
const evidence = {
  app: appPath,
  storage: systemStorage ? 'system' : 'fixture',
  pendingAcceptance: ['系统钥匙串与跨重启登录', '原生窗口与真人输入'],
  started: new Date().toISOString(),
  checks,
  samples: [],
  processes: [],
  fixture: website.receipts,
};
const interrupt = () => {
  evidence.interrupted = true;
  timedOut = true;
  process.exitCode = 1;
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const deadline = setTimeout(
  () => {
    timedOut = true;
    process.exitCode = 1;
  },
  inputPreparation
    ? 60000
    : options.interactive || systemStorage
      ? 30 * 60 * 1000
      : 2 * 60000,
);
function check(name, test) {
  test();
  checks.push({ name, passed: true });
  console.log('通过：' + name);
}
async function waitFor(fn, timeout = 10000, cleanup = false) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (timedOut && !cleanup) throw Error('VALIDATION_TIME_LIMIT');
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('VALIDATION_TIMEOUT');
}
function remainingOwned() {
  if (!processRecord) return [];
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 5000,
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set(lastPids);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent, group] of rows)
      if ((owned.has(parent) || ownedGroups.has(group)) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
  }
  const live = rows.filter(([pid]) => owned.has(pid));
  // 仅跟踪由自有进程担任组长的组，排除验证入口继承的终端进程组。
  for (const [pid, parent, group] of live) {
    if (owned.has(group)) ownedGroups.add(group);
    processRecord.seen[pid] = { parent, group };
  }
  lastPids = [...owned];
  processRecord.groups = [...ownedGroups];
  processRecord.remaining = live.map(([pid]) => pid);
  return processRecord.remaining;
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
  if (timedOut) throw Error('VALIDATION_TIME_LIMIT');
  assert.equal(remainingOwned().length, 0, 'PREVIOUS_PROCESSES_REMAIN');
  const number = spend('starts').used.starts;
  const start = Date.now();
  const env = Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const child = spawn(
    exe,
    systemStorage
      ? ['--workspace-validation']
      : ['--workspace-validation', '--workspace-fixture'],
    {
      env: {
        ...env,
        HELPR_VALIDATION_DATA: data,
        ...(!systemStorage && { HELPR_FIXTURE_ORIGIN: website.base }),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  app = child;
  lastPids = [child.pid];
  ownedGroups = new Set();
  const run = {
    number,
    controller: child.pid,
    seen: {},
    groups: [],
    remaining: [],
  };
  processRecord = run;
  evidence.processes.push(run);
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
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('message', (message) => {
      if (message.launching) {
        for (const pid of [message.launcherPid, message.hostPid])
          if (Number.isSafeInteger(pid) && pid > 1) lastPids.push(pid);
      }
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
    child.once('exit', (code, signal) => {
      run.exit = { code, signal };
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
  if (!systemStorage)
    assert(
      ready.fixture === true &&
        ready.fixtureSession?.origin === website.base &&
        ready.fixtureSession.persistent === false,
      'LOCAL_FIXTURE_MODE_REQUIRED',
    );
  evidence.samples.push({
    kind: 'startup',
    number,
    fixtureSession: ready.fixtureSession,
    ms: Date.now() - start,
    versions: ready.versions,
  });
  lastPids.push(ready.hostPid, ready.recordsPid);
  remainingOwned();
  return {
    child,
    ready,
    request: (command) =>
      new Promise((resolve, reject) => {
        if (timedOut) {
          reject(Error('VALIDATION_TIME_LIMIT'));
          return;
        }
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('REQUEST_TIMEOUT'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, command });
      }),
    quit: async () => {
      remainingOwned();
      child.send({ id: ++sequence, command: { kind: 'quit' } });
      await waitFor(() => child.exitCode !== null || child.signalCode !== null);
      assert.equal(child.exitCode, 0);
      await waitFor(() => remainingOwned().length === 0);
    },
  };
}
const command = (kind, fields = {}) => ({
  kind,
  requestId: randomUUID(),
  ...fields,
});
async function validate() {
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
    systemStorage ? 10 * 60 * 1000 : 15000,
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
  // 公开开始入口必须经过真实宿主原生准备。新资料没有模型配置，不发送模型网络请求。
  const begun = await client.request(
    command('execution-intent', { taskId: a, intent: 'start' }),
  );
  check('实际顶栏与网页的原生准备允许开始意图通过', () => {
    assert.equal(
      begun.state.tasks.find((t) => t.id === a)?.execution?.intent,
      'automatic',
    );
  });
  await client.request(
    command('execution-intent', { taskId: a, intent: 'stop' }),
  );
  if (inputPreparation) {
    await client.quit();
    checks.push({ name: '输入准备定向核对正常退出且无自有残留', passed: true });
    return;
  }
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
  // 通过对话入口留下可核对的任务消息；明确的停止指令在本机执行。
  const reply = await client.request(
    command('message', { taskId: b, text: '停下。' }),
  );
  check('B 的对话指令只记录在 B', () => {
    const hasMessage = (task) =>
      task.messages.some((m) => m.role === 'user' && m.text === '停下。');
    assert(hasMessage(reply.state.tasks.find((t) => t.id === b)));
    assert(!hasMessage(reply.state.tasks.find((t) => t.id === a)));
  });
  await client.request(command('select', { taskId: a }));
  await waitFor(
    async () => (await client.request({ kind: 'snapshot' })).active === a,
  );
  if (unavailableUI) {
    evidence.interaction = 'deferred';
    evidence.interactionError = unavailableUI;
  } else if (options.interactive) {
    const resume = path.join(out, 'continue'),
      defer = path.join(out, 'defer-ui');
    console.log(
      `交互核对就绪。完成后创建 ${resume}；连接不可用时创建 ${defer}，脚本会继续独立检查。`,
    );
    try {
      fs.writeFileSync(
        path.join(out, 'workspace-before-interaction.png'),
        Buffer.from(await client.request({ kind: 'capture' }), 'base64'),
      );
      evidence.interaction = await waitFor(
        () =>
          fs.existsSync(defer)
            ? 'deferred'
            : fs.existsSync(resume) && 'resumed',
        10 * 60 * 1000,
      );
      if (evidence.interaction === 'resumed')
        fs.writeFileSync(
          path.join(out, 'workspace-A.png'),
          Buffer.from(await client.request({ kind: 'capture' }), 'base64'),
        );
    } catch (error) {
      if (timedOut) throw error;
      evidence.interaction = 'deferred';
      evidence.interactionError = error.message;
    }
  }
  // 本机虚构 Cookie 核对；真人点击登录的证据另行记录，GET 不充抵真人输入。
  await client.request(
    command('navigate', { taskId: a, url: website.base + '/login?task=A' }),
  );
  await waitFor(() =>
    website.receipts.some(
      (r) => r.kind === 'page' && r.task === 'A' && r.authenticated,
    ),
  );
  // 冷重开访问普通页面；重放设置 Cookie 的 /login 会制造另一份登录。
  await client.request(
    command('navigate', { taskId: a, url: website.base + '/page?task=A' }),
  );
  const saved = await client.request({ kind: 'snapshot' });
  const inspection = await client.request({ kind: 'inspect' });
  lastPids.push(...inspection.pids.map((p) => p.pid));
  evidence.samples.push({ kind: 'two-pages', metrics: inspection.pids });
  check('私有 pipe 开启且没有调试端口', () => {
    assert(inspection.switches.pipe);
    assert(!inspection.switches.port && !inspection.switches.inspect);
    assert.equal(inspection.encryptionAvailable, systemStorage ? true : null);
  });
  let listeners = '';
  try {
    listeners = execFileSync(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', lastPids.join(','), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 5000 },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  check('独立客户端检查自有进程没有 TCP 控制监听', () =>
    assert.equal(listeners.trim(), ''),
  );
  await client.quit();
  checks.push({ name: '正常退出后独立核对所有已见自有进程结束', passed: true });
  if (systemStorage)
    check('实际 Cookie 文件没有明文会话，持久 Cookie 使用加密字段', () => {
      const cookieFiles = execFileSync(
        '/usr/bin/find',
        [path.join(data, 'browser'), '-name', 'Cookies'],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const Database = createRequire(import.meta.url)('better-sqlite3');
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
      .some(
        (r) =>
          r.kind === 'page' &&
          r.task === 'A' &&
          r.authenticated === systemStorage,
      ),
  );
  checks.push({
    name: systemStorage
      ? '冷重开后网站核对原会话仍有效'
      : '冷重开后本机网站确认临时登录已释放',
    passed: true,
  });
  if (systemStorage) evidence.pendingAcceptance.shift();
  if (evidence.interaction === 'resumed')
    fs.writeFileSync(
      path.join(out, 'workspace-restored.png'),
      Buffer.from(await client.request({ kind: 'capture' }), 'base64'),
    );
  if (options.fault) {
    const baseline = await client.request({ kind: 'snapshot' });
    remainingOwned();
    spend('faults');
    if (options['blocked-host']) process.kill(client.ready.hostPid, 'SIGSTOP');
    client.child.kill('SIGKILL');
    await waitFor(() => remainingOwned().length === 0);
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
  }
  await client.quit();
}
try {
  await validate();
  if (timedOut) throw Error('VALIDATION_TIME_LIMIT');
  evidence.automatedPassed = true;
  evidence.passed = evidence.interaction !== 'deferred';
  if (!evidence.passed) {
    process.exitCode = 2;
    console.log('自动检查通过，现场交互待验。');
  }
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  process.exitCode = 1;
  console.error('验证停止：' + error.message);
} finally {
  if (app?.connected) {
    try {
      remainingOwned();
      app.send({ id: Number.MAX_SAFE_INTEGER, command: { kind: 'quit' } });
      await waitFor(() => remainingOwned().length === 0, 10000, true);
    } catch (error) {
      evidence.quitError = error.message;
    }
  }
  if (remainingOwned().length) {
    try {
      spend('cleanups');
    } catch (error) {
      evidence.accountingError = error.message;
    }
    try {
      for (const pid of remainingOwned()) {
        if (!alive(pid)) continue;
        try {
          const image = execFileSync(
            path.join(appPath, 'Contents/Resources/process-path'),
            [String(pid)],
            {
              encoding: 'utf8',
              timeout: 2000,
              env: {},
              maxBuffer: 8192,
            },
          ).trim();
          if (!image.startsWith(fs.realpathSync(appPath) + '/Contents/'))
            throw Error('CLEANUP_IMAGE_CHANGED');
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (alive(pid)) throw error;
        }
      }
      await waitFor(() => remainingOwned().length === 0, 10000, true);
    } catch (error) {
      evidence.cleanupError = error.message;
    }
  }
  evidence.remaining = remainingOwned();
  if (
    evidence.remaining.length ||
    evidence.cleanupError ||
    evidence.accountingError
  ) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  clearTimeout(deadline);
  await website.close();
  evidence.ms = Date.now() - started;
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log('证据：' + out);
  release();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
