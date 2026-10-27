import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { spend, validationRoot } from './workspace-budget.mjs';
import { verifyDevelopmentSignature } from './development-signing.mjs';

// 同一受管入口持有全部应用、服务与四次启动；产品交互交由CUA。
const mode = process.argv.slice(2).join(' ');
assert(['--check', '--preflight', '--run', '--after-97', '--check-after-97'].includes(mode), 'EXPLICIT_MODE_REQUIRED');
const after97 = mode === '--after-97' || mode === '--check-after-97';
const root = path.join(validationRoot, 'manual-upgrade-09');
const batchFile = path.join(validationRoot, 'manual-upgrade-09-batch.json');
const budgetFile = path.join(validationRoot, 'budget.json');
const contractsFile = path.join(validationRoot, 'upgrade09-contracts.mjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
createRequire(import.meta.resolve('vite'))('esbuild').buildSync({
  stdin: { contents: "export {uiCommandSchema} from './app/shared/contracts';export {nextStepSchema} from './app/shared/execution';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: contractsFile,
});
const { uiCommandSchema, nextStepSchema } = await import(pathToFileURL(contractsFile).href);
const reply = nextStepSchema.parse({ decision: 'complete', summary: '已只读核对本机升级验证页面。', evidence: ['本机升级验证页面'], previous: null, action: null });
const configure = (origin, key) => uiCommandSchema.parse({ kind: 'model-save', requestId: randomUUID(), expectedVersion: 0, protocol: 'chat-completions', endpoint: origin + '/v1', model: 'local-upgrade-09', apiKey: key });
configure('http://127.0.0.1:50000', 'not-a-real-key');
for (const command of [{ kind: 'upgrade-status' }, { kind: 'upgrade-check' }, { kind: 'upgrade-cancel' }, { kind: 'upgrade-exit', revision: 1 }]) uiCommandSchema.parse(command);
if (mode === '--check') {
  console.log(JSON.stringify({ valid: true, appStarts: 0, protection: 'real safeStorage; workspace-fixture switch forbidden', reply: reply.decision }));
  process.exit(0);
}
const ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
  assert(m, 'PROCESS_ROW_INVALID');
  return { pid: +m[1], parent: +m[2], group: +m[3], birth: m[4].replace(/\s+/g, ' '), command: m[5] };
});
assert(!ps().some(row => row.pid !== process.pid && (/\/helpr\.app\/Contents\/MacOS\/helpr(?: |$)/.test(row.command) || /helpr Workspace Helper/.test(row.command) || /^(?:\S*\/)?node\s+(?:\S*\/)?validate-\S+\.mjs(?:\s|$)/.test(row.command))), 'OTHER_VALIDATION_RUNNING');
execFileSync(process.execPath, ['scripts/validate-workspace.mjs', '--preflight'], { stdio: 'inherit', timeout: 65000 });
const budget = JSON.parse(fs.readFileSync(budgetFile));
assert(budget.upgrade09?.approved && budget.limits.builds === 37 && budget.limits.starts === 100, 'EXPLICIT_APPROVAL_REQUIRED');
const originalDeadline = budget.upgrade09.runtimeStartedAt + 90 * 60000;
const extraTime = budget.upgrade09.after97Time;
if (extraTime) assert(after97 && extraTime.approved === true && extraTime.originalDeadline === originalDeadline && Number.isSafeInteger(extraTime.approvedAt) && extraTime.deadline === extraTime.approvedAt + 60 * 60000, 'EXACT_TIME_EXTENSION_APPROVAL_REQUIRED');
const batchDeadline = extraTime?.deadline ?? originalDeadline;
assert(budget.used.starts === (after97 ? 97 : 96) && budget.used.installs === (after97 ? 9 : 8) && budget.used.faults === 42 && budget.used.cleanups === 17, 'ORIGINAL_BUDGET_REQUIRED');
assert(after97 ? fs.existsSync(batchFile) && fs.existsSync(root) : !fs.existsSync(batchFile) && !fs.existsSync(root), 'BATCH_IDENTITY_REQUIRED');
const previous = after97 ? JSON.parse(fs.readFileSync(path.join(root, 'result.json'))) : null;
if (previous) {
  assert(previous.passed === false && previous.error === 'REQUEST_TIMEOUT' && previous.starts.length === 1 && previous.starts[0].start === 97 && previous.starts[0].build === 36 && previous.starts[0].exit.code === 0 && previous.starts[0].remaining.length === 0, 'EXACT_97_FAILURE_REQUIRED');
  assert(previous.tasks.length === 0 && previous.models.length === 0 && previous.logins.length === 0 && previous.effects.length === 0 && previous.versionRequests.length === 0 && previous.installs.length === 1 && previous.installs[0].number === 9 && !previous.emergencyCleanupAttempted, 'NO_PRIOR_BUSINESS_WORK_REQUIRED');
  assert.equal(previous.started, budget.upgrade09.runtimeStartedAt, 'ORIGINAL_DEADLINE_REQUIRED');
}
const old = JSON.parse(fs.readFileSync(path.join(validationRoot, 'build-36.json')));
const expectedOld = '/Users/yuexiaoliang/projects/helpr/dist/candidates/version-08/mac-arm64/helpr.app';
assert(old.build === 36 && old.prepared && old.app === expectedOld, 'FIXED_OLD_CANDIDATE_REQUIRED');
function verify(manifest) {
  for (const [file, expected] of Object.entries(manifest.hashes)) assert.equal(hash(fs.readFileSync(path.join(manifest.app, file))), expected, file);
  return verifyDevelopmentSignature(manifest.app);
}
verify(old);
if (mode === '--preflight') {
  console.log(JSON.stringify({ preflight: true, oldBuild: 36, nextBuild: 37, oldApp: old.app, appStarts: 0, remainingStarts: 4, installs: 2, minutes: 90 }));
  process.exit(0);
}
const fresh = JSON.parse(fs.readFileSync(path.join(validationRoot, 'build-37.json')));
assert(fresh.build === 37 && fresh.prepared && fresh.app === path.resolve('dist/candidates/manual-upgrade-09/mac-arm64/helpr.app'), 'FIXED_NEW_CANDIDATE_REQUIRED');
assert.equal(verify(fresh).certificateSha256, verify(old).certificateSha256, 'PUBLISHER_CHANGED');
assert.notEqual(fresh.hashes['Contents/Resources/app.asar'], old.hashes['Contents/Resources/app.asar'], 'DISTINCT_REAL_PACKAGES_REQUIRED');
assert(Number.isSafeInteger(budget.upgrade09.runtimeStartedAt) && Date.now() < batchDeadline, 'ORIGINAL_BATCH_DEADLINE_REQUIRED');
if (mode === '--check-after-97') {
  assert(!fs.existsSync(path.join(root, 'after-97-once')), 'CONTINUATION_ALREADY_USED');
  assert(fs.realpathSync(budget.upgrade09.run.profile) === budget.upgrade09.run.profile, 'ORIGINAL_PROFILE_REQUIRED');
  console.log(JSON.stringify({ valid: true, appStarts: 0, carriedStart: 97, used: budget.used, remainingStarts: 3, originalDeadline, approvedDeadline: batchDeadline }));
  process.exit(0);
}
if (after97) {
  fs.writeFileSync(path.join(root, 'after-97-once'), String(process.pid), { flag: 'wx', mode: 0o600 });
  fs.copyFileSync(path.join(root, 'result.json'), path.join(root, 'result-97.json'), fs.constants.COPYFILE_EXCL);
} else {
  fs.writeFileSync(batchFile, JSON.stringify({ root, pid: process.pid, started: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(root, { mode: 0o700 });
}
const profileRoot = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
assert.equal(fs.realpathSync(profileRoot), profileRoot);
const profile = after97 ? budget.upgrade09.run.profile : fs.mkdtempSync(profileRoot + '/upgrade09-');
assert(profile.startsWith(profileRoot + '/upgrade09-') && fs.realpathSync(profile) === profile, 'ORIGINAL_PROFILE_REQUIRED');
const installation = path.join(root, 'installation/helpr.app');
const backupDirectory = path.join(root, 'selected-backups');
if (!after97) fs.mkdirSync(backupDirectory, { mode: 0o700 });
const apiKey = 'upgrade09-test-' + randomUUID();
const sessionToken = randomUUID();
const expires = Math.floor(Date.now() / 1000) + 7200;
const report = { scope: 'early real-package upgrade; real safeStorage and persistent browser; local fixtures only', started: budget.upgrade09.runtimeStartedAt, originalDeadline, approvedDeadline: batchDeadline, builds: [36, 37], limits: budget.upgrade09.limits, installs: [], starts: [], tasks: [], checks: [], models: [], logins: [], pages: [], effects: [], versionRequests: [], captures: [], realModels: 0, remoteBusinessWrites: 0, passed: false };
if (previous) Object.assign(report, { installs: previous.installs, starts: previous.starts, priorFailure: { start: 97, error: previous.error, sha256: hash(fs.readFileSync(path.join(root, 'result-97.json'))), originalStarted: previous.started }, continuation: 'one corrected readiness retry; no fault reserved' });
const oldStart = after97 ? 98 : 97, newStart = oldStart + 1, coldStart = oldStart + 2;
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const save = () => {
  write('result.json', report);
  const b = JSON.parse(fs.readFileSync(budgetFile));
  b.upgrade09.used = { builds: b.used.builds - 36, starts: report.starts.length, installs: report.installs.length, faults: report.fault ? 1 : 0, cleanups: b.used.cleanups - 17, localModels: report.models.length, localEffects: report.effects.length, versionRequests: report.versionRequests.length, newTasks: report.tasks.length };
  b.upgrade09.run = { root, profile, passed: report.passed, error: report.error ?? null, started: report.started, ended: report.ended ?? null };
  fs.writeFileSync(budgetFile, JSON.stringify(b, null, 2) + '\n', { mode: 0o600 });
};
const safeSave = () => { try { save(); } catch (error) { report.persistenceError ??= error.code ?? error.message; report.passed = false; failure ??= 'EVIDENCE_WRITE_FAILED'; } };
let failure, current, finished = false, setupUsed = false, baseline, newInstalled = false;
const deadline = batchDeadline;
const check = (name, condition) => { assert(condition, name); if (!report.checks.includes(name)) report.checks.push(name); save(); };
function limited() {
  if (failure) throw Error(failure);
  assert(Date.now() < deadline, 'BATCH_DEADLINE');
  if (current && !current.cleared) assert(Date.now() < current.roundDeadline, 'ROUND_DEADLINE');
}
async function until(fn, ms = 15000, cleanup = false) {
  const end = cleanup ? Date.now() + ms : Math.min(Date.now() + ms, deadline, current?.roundDeadline ?? Infinity);
  while (Date.now() < end) { if (!cleanup) limited(); if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('UPGRADE_WAIT_EXPIRED');
}
function processes(app) {
  const rows = ps(), byPid = new Map(rows.map(row => [row.pid, row]));
  const same = row => { const prior = app.identities.get(row?.pid); return prior && row.birth === prior.birth && row.command === prior.command; };
  const inside = row => row.command.startsWith(installation + '/Contents/');
  const remember = row => { app.pids.add(row.pid); app.identities.set(row.pid, { birth: row.birth, command: row.command }); };
  if (!app.identities.size) {
    const row = byPid.get(app.child.pid);
    if (row?.parent === process.pid && inside(row)) remember(row);
  }
  let added = true;
  while (added) { added = false; for (const row of rows) if (!same(row) && inside(row) && same(byPid.get(row.parent))) { remember(row); added = true; } }
  for (const row of rows) if (same(row) && same(byPid.get(row.group))) app.groups.set(row.group, app.identities.get(row.group));
  const liveGroup = group => { const original = app.groups.get(group), leader = byPid.get(group); return original && (!leader || (leader.birth === original.birth && leader.command === original.command)); };
  for (const row of rows) if (!same(row) && inside(row) && liveGroup(row.group)) remember(row);
  const owned = rows.filter(row => same(row) || liveGroup(row.group));
  Object.assign(app.row, { pids: [...app.pids], identities: Object.fromEntries(app.identities), groups: [...app.groups.keys()], tree: owned });
  return owned;
}
function rpc(command, ms = 15000, cleanup = false) {
  if (!cleanup) limited();
  assert(current?.child.connected, 'APPLICATION_DISCONNECTED');
  if (!['inspect', 'show', 'capture'].includes(command.kind)) uiCommandSchema.parse(command);
  const app = current;
  return new Promise((resolve, reject) => {
    const id = ++app.sequence;
    const timer = setTimeout(() => { app.pending.delete(id); reject(Error('RPC_TIMEOUT')); }, cleanup ? ms : Math.max(1, Math.min(ms, deadline - Date.now(), app.roundDeadline - Date.now())));
    app.pending.set(id, { resolve, reject, timer });
    app.child.send({ id, command });
  });
}
async function gone(normal = true) {
  const app = current;
  await until(() => app.exit, 45000, true);
  await until(() => processes(app).length === 0, 10000, true);
  app.row.remaining = processes(app); app.cleared = true;
  check('owned-processes-cleared-' + app.row.start, app.row.remaining.length === 0);
  if (normal) assert.equal(app.exit.code, 0, 'NORMAL_EXIT_REQUIRED');
}
async function quit() {
  if (!current.exit) await rpc({ kind: 'quit' }, 45000, true).catch(error => { if (!['APPLICATION_DISCONNECTED', 'APPLICATION_EXITED', 'APPLICATION_EXITING'].includes(error.message)) throw error; });
  await gone();
}
function install(manifest) {
  limited(); assert(!current || current.cleared, 'PREVIOUS_NOT_CLEARED');
  assert(report.installs.length < 2, 'INSTALL_LIMIT'); verify(manifest);
  assert.equal(path.dirname(installation), path.join(root, 'installation'));
  if (fs.existsSync(installation)) {
    assert(report.installs.length === 1 && current?.cleared, 'OWN_OLD_INSTALL_REQUIRED');
    for (const [file, expected] of Object.entries(old.hashes)) assert.equal(hash(fs.readFileSync(path.join(installation, file))), expected);
    fs.renameSync(installation, path.join(root, 'installation/helpr-old-preserved.app'));
  }
  const spent = spend('installs');
  report.installs.push({ number: spent.used.installs, build: manifest.build, started: Date.now(), source: manifest.app }); save();
  fs.mkdirSync(path.dirname(installation), { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/ditto', [manifest.app, installation], { timeout: 120000 });
  for (const [file, expected] of Object.entries(manifest.hashes)) assert.equal(hash(fs.readFileSync(path.join(installation, file))), expected);
}
async function launch(build) {
  limited(); assert(!current || current.cleared, 'PREVIOUS_NOT_CLEARED');
  assert(report.starts.length < 4, 'START_LIMIT');
  const spent = spend('starts');
  const row = { start: spent.used.starts, build, at: Date.now() };
  report.starts.push(row); save();
  const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(path.join(installation, 'Contents/MacOS/helpr'), ['--workspace-validation'], { env: { ...env, HELPR_VALIDATION_DATA: profile }, stdio: ['ignore', 'ignore', fs.openSync(path.join(root, `stderr-${row.start}.log`), 'a', 0o600), 'ipc'] });
  const app = { child, row, pids: new Set(), identities: new Map(), groups: new Map(), pending: new Map(), sequence: 0, roundDeadline: row.at + 20 * 60000, ready: false, exit: null, cleared: false };
  current = app; row.pid = child.pid; save();
  assert(processes(app).some(p => p.pid === child.pid), 'CHILD_PROCESS_IDENTITY_REQUIRED'); safeSave();
  child.on('message', m => {
    if (m.ready) { app.ready = true; row.ready = m; }
    if (m.startupFailure) row.startupFailure = m.startupFailure;
    if (m.ready || m.hostPid || m.launcherPid || m.recordsPid) { try { processes(app); } catch (error) { failure ??= error.message; } safeSave(); }
    const pending = app.pending.get(m.id);
    if (pending) { clearTimeout(pending.timer); app.pending.delete(m.id); m.error ? pending.reject(Error(m.error)) : pending.resolve(m.value); }
  });
  child.once('exit', (code, signal) => { app.exit = { code, signal }; row.exit = app.exit; for (const p of app.pending.values()) { clearTimeout(p.timer); p.reject(Error('APPLICATION_EXITED')); } app.pending.clear(); safeSave(); });
  child.once('error', error => { failure = error.code ?? 'APPLICATION_SPAWN_FAILED'; });
  const readyDeadline = row.at + 30000;
  // inspect含同步系统加密探测；先用不读取凭据的show解除隐藏首绘制等待。
  let shown = false;
  for (let attempt = 1; attempt <= 20 && Date.now() < readyDeadline; attempt++) {
    try { await rpc({ kind: 'show' }, readyDeadline - Date.now()); shown = true; break; }
    catch (error) { row.windowPreparation ??= []; row.windowPreparation.push({ attempt, method: 'show', error: error.message, at: Date.now() }); save(); if (error.message !== 'RECORDS_UNAVAILABLE') throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(shown, 'WINDOW_SHOW_DEADLINE');
  console.log('UPGRADE_WINDOW ' + JSON.stringify({ start: row.start, hostApp: path.join(installation, 'Contents/Frameworks/helpr Workspace.app') }));
  await until(() => { processes(app); return app.ready || app.exit; }, Math.max(1, readyDeadline - Date.now()));
  assert(app.ready && !app.exit, 'APPLICATION_NOT_READY');
  assert(!row.ready.fixture, 'REAL_CREDENTIAL_PROTECTION_REQUIRED');
  write('context.json', { root, profile, origin, installation, backupDirectory, hostApp: path.join(installation, 'Contents/Frameworks/helpr Workspace.app'), start: row.start });
  console.log('UPGRADE_READY ' + JSON.stringify({ start: row.start, build, root }));
}
function facts(state) { return { settings: state.modelSettings, tasks: state.tasks.map(t => [t.id, t.goal, t.draft, t.messages, t.execution?.intent ?? null, t.execution?.phase ?? null]) }; }
async function snapshot() { const s = await rpc({ kind: 'snapshot' }); write('snapshot.json', s); return s; }
async function capture(label) {
  assert(/^[a-z0-9-]{1,40}$/.test(label), 'CAPTURE_LABEL');
  const image = await rpc({ kind: 'capture' });
  write('capture-' + label + '.json', image); report.captures.push(label); save();
}
const counts = { A: 0, B: 0 };
const website = http.createServer(async (req, res) => {
  try {
    limited(); const url = new URL(req.url, 'http://127.0.0.1');
    const authenticated = (req.headers.cookie ?? '').split(';').some(c => c.trim() === 'helpr_upgrade09=' + sessionToken) && Date.now() / 1000 < expires;
    if (url.pathname.startsWith('/v1/')) {
      assert(report.models.length < 8, 'LOCAL_MODEL_LIMIT');
      const match = req.headers.authorization === 'Bearer ' + apiKey;
      report.models.push({ at: Date.now(), start: current.row.start, method: req.method, path: url.pathname, originalKeyMatched: match }); save(); assert(match, 'ORIGINAL_KEY_REQUIRED');
      if (req.method === 'GET' && url.pathname === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-upgrade-09' }] })); return; }
      assert(req.method === 'POST' && url.pathname === '/v1/chat/completions', 'LOCAL_MODEL_PATH');
      let raw = ''; for await (const chunk of req) { raw += chunk; assert(Buffer.byteLength(raw) < 200000, 'MODEL_BODY_LIMIT'); }
      const value = JSON.parse(raw); assert(value.messages.some(m => typeof m.content === 'string' && m.content.includes('本机升级验证页面')), 'OBSERVED_FIXTURE_REQUIRED');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'upgrade09', choices: [{ index: 0, delta: { content: JSON.stringify(reply) }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'upgrade09', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (url.pathname === '/login') {
      assert(current?.row.build === 36 && report.logins.length === 0, 'ORIGINAL_LOGIN_ONLY');
      report.logins.push({ at: Date.now(), expires, start: current.row.start }); save();
      res.writeHead(302, { 'Set-Cookie': `helpr_upgrade09=${sessionToken}; Path=/; HttpOnly; Max-Age=7200; SameSite=Lax`, Location: '/page/A' }); res.end(); return;
    }
    const page = url.pathname.match(/^\/page\/([AB])$/);
    if (req.method === 'GET' && page) {
      const name = page[1]; report.pages.push({ at: Date.now(), name, start: current.row.start, authenticated, expires }); save();
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>升级验证 ${name}</title><style>body{font:20px -apple-system;background:#f5f8f3;color:#203e30;padding:32px}button,a,textarea{font:inherit;padding:10px}textarea{display:block;width:420px;height:120px;margin:16px 0}</style><h1>本机升级验证页面 ${name}</h1><p>${authenticated ? '原测试登录仍有效' : '尚未登录'}</p>${authenticated ? '' : '<a href="/login">登录本批虚构账号</a>'}<p id="saved">已保存 ${counts[name]} 次</p><label>网页文字 ${name}<textarea id="draft" aria-label="网页文字 ${name}"></textarea></label><button id="save">保存网页 ${name}</button><script>let dirty=false;draft.oninput=()=>dirty=true;save.onclick=async()=>{let r=await fetch('/save/${name}',{method:'POST',body:draft.value});if(r.ok){dirty=false;saved.textContent='已保存 '+(await r.json()).count+' 次';}};addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});</script></html>`); return;
    }
    const savePage = url.pathname.match(/^\/save\/([AB])$/);
    if (req.method === 'POST' && savePage) {
      assert(authenticated && report.effects.length < 4, 'AUTHENTICATED_EFFECT_LIMIT');
      let text = ''; for await (const chunk of req) { text += chunk; assert(Buffer.byteLength(text) <= 10000, 'LOCAL_TEXT_LIMIT'); }
      const name = savePage[1]; counts[name]++; report.effects.push({ at: Date.now(), start: current.row.start, name, textHash: hash(text), bytes: Buffer.byteLength(text), count: counts[name] }); save();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ count: counts[name] })); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(404); res.end();
  } catch (error) { failure ??= error.message; safeSave(); if (!res.headersSent) res.writeHead(400); res.end('FIXTURE_REJECTED'); }
});
const keyFile = path.join(root, 'tls-key.pem'), certFile = path.join(root, 'tls-cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 10000 });
fs.chmodSync(keyFile, 0o600);
let futureVersion = false;
const versions = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  try {
    limited(); assert(report.versionRequests.length < 16 && req.method === 'GET' && req.url === '/stable.json', 'VERSION_REQUEST_LIMIT');
    report.versionRequests.push({ at: Date.now(), start: current?.row.start, futureVersion }); save();
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schema: 1, version: futureVersion ? '0.3.0' : '0.1.0', platform: 'darwin', arch: 'arm64', minOS: '14.0.0', dataFormats: [6, 7], stateModels: [1], notes: ['仅本机交互夹具，不代表真实Release或可下载安装包。'], downloadURL: futureVersion ? 'https://github.com/yuexiaoliang/helpr/releases/tag/v0.3.0' : null }));
  } catch (error) { failure ??= error.message; safeSave(); res.writeHead(400); res.end(); }
});
let origin;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { failure ??= 'VALIDATOR_' + signal; });
try {
  await new Promise((resolve, reject) => { website.once('error', reject); website.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + website.address().port;
  await new Promise((resolve, reject) => { versions.once('error', reject); versions.listen(0, '127.0.0.1', resolve); });
  fs.writeFileSync(path.join(profile, 'version-fixture.json'), JSON.stringify({ source: `https://127.0.0.1:${versions.address().port}/stable.json`, ca: fs.readFileSync(certFile, 'utf8') }), { mode: 0o600 });
  save();
  if (!after97) install(old);
  else for (const [file, expected] of Object.entries(old.hashes)) assert.equal(hash(fs.readFileSync(path.join(installation, file))), expected, 'ORIGINAL_INSTALLED_PACKAGE_REQUIRED');
  await launch(36);
  while (!finished) {
    limited(); processes(current);
    const file = path.join(root, 'command.json');
    if (fs.existsSync(file)) {
      const c = JSON.parse(fs.readFileSync(file)); fs.unlinkSync(file);
      try {
        let value;
        switch (c.op) {
          case 'setup': {
            assert(!setupUsed && current.row.build === 36, 'SETUP_ONCE'); setupUsed = true;
            await rpc(configure(origin, apiKey), 600000);
            for (const name of ['A', 'B']) {
              const task = await rpc({ kind: 'create', requestId: randomUUID(), goal: `核对本机升级验证页面 ${name} ${origin}/page/${name}` });
              report.tasks.push({ name, id: task.taskId }); save();
              await until(async () => (await snapshot()).tasks.find(t => t.id === task.taskId)?.phase === 'manual');
              await rpc({ kind: 'draft', requestId: randomUUID(), taskId: task.taskId, text: `原任务${name}的中文草稿` });
              await rpc({ kind: 'execution-intent', requestId: randomUUID(), taskId: task.taskId, intent: 'stop' });
            }
            value = { tasks: report.tasks, configured: true }; break;
          }
          case 'inspect': {
            const s = await snapshot();
            const u = current.row.build === 37 ? await rpc({ kind: 'upgrade-status' }) : null;
            write('inspection-' + current.row.start + '.json', { state: s, upgrade: u, models: report.models, pages: report.pages, effects: report.effects });
            value = { state: facts(s), upgrade: u, models: report.models.length, effects: report.effects.length, logins: report.logins.length }; break;
          }
          case 'capture': await capture(c.label); value = { captured: c.label }; break;
          case 'baseline': {
            assert(current.row.build === 36 && report.tasks.length === 2 && report.logins.length === 1, 'OLD_BASELINE_REQUIRED');
            assert(report.models.some(m => m.start === oldStart && m.originalKeyMatched), 'OLD_KEY_PROOF_REQUIRED');
            baseline = facts(await snapshot()); write('old-baseline.json', baseline);
            const backup = await rpc({ kind: 'backup-status' });
            assert(backup.phase === 'complete' && backup.archive.file.startsWith(backupDirectory + path.sep), 'OLD_UI_BACKUP_REQUIRED');
            const envelope = JSON.parse(fs.readFileSync(backup.archive.file));
            assert(envelope.dataVersion === 6 && envelope.payload.tasks.length === 2, 'OLD_BACKUP_REQUIRED');
            assert.equal(envelope.files[0].sha256, hash(JSON.stringify(envelope.payload)));
            report.oldBackup = { sha256: hash(fs.readFileSync(backup.archive.file)), bytes: fs.statSync(backup.archive.file).size, dataVersion: 6 };
            await quit(); report.oldDatabase = { sha256: hash(fs.readFileSync(path.join(profile, 'workspace.sqlite'))), bytes: fs.statSync(path.join(profile, 'workspace.sqlite')).size };
            check('old-baseline-normal-exit', true); value = { baseline: true }; break;
          }
          case 'upgrade': {
            assert(baseline && current.cleared && !newInstalled, 'ONE_REPLACEMENT_REQUIRED');
            install(fresh); newInstalled = true; await launch(37);
            const s = await snapshot(); check('original-task-records-retained', JSON.stringify(facts(s)) === JSON.stringify(baseline));
            check('internal-format6-copy-retained', fs.readdirSync(profile).some(name => name.startsWith('workspace-before-upgrade-09-')));
            value = { upgraded: true }; break;
          }
          case 'future': assert(newInstalled, 'NEW_PACKAGE_REQUIRED'); futureVersion = true; value = { fixtureOnly: '0.3.0; not published or downloaded' }; break;
          case 'closed': await gone(); value = { closed: true }; break;
          case 'cold': {
            assert(newInstalled && current.cleared && report.starts.length === (after97 ? 3 : 2), 'SINGLE_COLD_REOPEN_REQUIRED');
            await launch(37); check('same-version-reopen-keeps-task-records', JSON.stringify(facts(await snapshot())) === JSON.stringify(baseline)); value = { reopened: true }; break;
          }
          case 'fault': {
            assert(!after97 && report.starts.length === 3 && !report.fault && !current.cleared && !current.exit && processes(current).some(p => p.pid === current.child.pid), 'SINGLE_LIVE_FAULT_REQUIRED');
            spend('faults'); report.fault = { at: Date.now(), pid: current.child.pid, start: current.row.start }; save();
            assert(current.child.kill('SIGKILL'), 'FAULT_SIGNAL_NOT_SENT'); await gone(false); assert.equal(current.exit.signal, 'SIGKILL', 'ACTUAL_FAULT_SIGNAL_REQUIRED'); report.fault.confirmed = true; save(); value = { interrupted: true }; break;
          }
          case 'recover': assert(report.fault?.confirmed && current.cleared && report.starts.length === 3, 'FAULT_RECOVERY_ONLY'); await launch(37); value = { recovered: true }; break;
          case 'finish': {
            assert(newInstalled && report.starts.length >= (after97 ? 4 : 3), 'COLD_EVIDENCE_REQUIRED');
            if (!current.cleared) await quit();
            check('original-login-not-recreated', report.logins.length === 1);
            check('original-key-served-in-both-real-packages', report.models.some(m => m.start === oldStart && m.originalKeyMatched) && report.models.some(m => m.start === newStart && m.originalKeyMatched));
            check('website-authenticated-after-upgrade', report.pages.some(p => p.start === newStart && p.authenticated));
            check('cold-original-key-and-login', report.models.some(m => m.start === coldStart && m.originalKeyMatched) && report.pages.some(p => p.start === coldStart && p.authenticated));
            assert(['upgrade-ready', 'upgrade-blocked', 'upgrade-cancelled'].every(label => report.captures.includes(label)), 'CUA_FLOW_CAPTURES_REQUIRED');
            finished = true; value = { finished: true }; break;
          }
          case 'abort': throw Error('CUA_ROUND_ABORTED');
          default: throw Error('INVALID_CONTROL');
        }
        write('command-result.json', { nonce: c.nonce, ok: true, value });
      } catch (error) { write('command-result.json', { nonce: c.nonce, ok: false, error: error.message }); throw error; }
    }
    // CUA可从真实升级按钮正常退出；不因控制命令尚未送到而误报失败。
    if (!current.cleared && current.exit) await gone();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  report.passed = !report.persistenceError;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (current && !current.cleared) {
    try { await quit(); } catch (error) { report.normalCleanupError = error.message; }
    if (!current.cleared) {
      // 已批准的必要清理不能依赖可写报告或账本；失败单独保留，不跳过OS检查。
      report.emergencyCleanupAttempted = true;
      try { spend('cleanups'); } catch (error) { report.cleanupAccountingError = error.code ?? error.message; }
      const signal = name => { for (const row of processes(current)) { const identity = current.identities.get(row.pid); if (identity?.birth === row.birth && identity.command === row.command) try { process.kill(row.pid, name); } catch {} } };
      try {
        signal('SIGTERM');
        try { await until(() => processes(current).length === 0, 5000, true); } catch { signal('SIGKILL'); await until(() => processes(current).length === 0, 5000, true); }
        report.cleanupRemaining = processes(current);
      } catch (error) { report.cleanupInspectionError = error.message; report.passed = false; }
      if (report.cleanupRemaining?.length) report.passed = false;
    }
  }
  for (const server of [website, versions]) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
  report.ended = Date.now(); report.counts = counts; safeSave();
  console.log('UPGRADE_RESULT ' + JSON.stringify({ passed: report.passed, error: report.error, root, starts: report.starts.length }));
}
