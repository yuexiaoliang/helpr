import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { validationRoot } from './workspace-budget.mjs';

// 只用旧实包留下的数据库副本及现有签名包；不启动、安装或重签应用。
const mode = process.argv[2];
assert(['--check', '--run', '--static', '--worker'].includes(mode) && process.argv.length === 3, 'EXPLICIT_MODE_REQUIRED');
if (mode === '--worker') assert(process.send && process.env.HELPR_OFFLINE_ROOT, 'OWNED_WORKER_REQUIRED');
assert(process.platform === 'darwin' && process.arch === 'arm64', 'TARGET_MAC_REQUIRED');
const budgetFile = path.join(validationRoot, 'budget.json');
const initialBudget = fs.readFileSync(budgetFile);
const budget = JSON.parse(initialBudget);
const profile = budget.upgrade09.run.profile;
const profileRoot = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
assert.equal(fs.realpathSync(profileRoot), profileRoot, 'REAL_VALIDATION_ROOT_REQUIRED');
assert(profile.startsWith(profileRoot + '/upgrade09-') && fs.realpathSync(profile) === profile, 'REAL_OLD_PROFILE_REQUIRED');
const baselineFile = path.join(budget.upgrade09.run.root, 'old-baseline.json');
const sources = fs.readdirSync(profile).filter(file => /^workspace-before-upgrade-09-.*\.sqlite$/.test(file));
assert.equal(sources.length, 1, 'ONE_REAL_OLD_DATABASE_REQUIRED');
const original = path.join(profile, sources[0]);
assert(fs.lstatSync(original).isFile() && fs.realpathSync(original) === original, 'REAL_OLD_DATABASE_REQUIRED');
const candidate = JSON.parse(fs.readFileSync(path.join(validationRoot, 'build-37.json')));
assert(candidate.prepared && candidate.build === 37, 'FIXED_CANDIDATE_REQUIRED');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHash = digest(original);
const packageResource = path.join(candidate.app, 'Contents/Resources/app.asar');
assert.equal(digest(packageResource), candidate.hashes['Contents/Resources/app.asar']);
if (mode === '--check') {
  console.log(JSON.stringify({ valid: true, sourceDatabaseSha256: originalHash, candidate: 37, appStarts: 0, installs: 0 }));
  process.exit(0);
}
// 独立父进程不导入SQLite，监督可能同步阻塞的worker及其同组子进程。
if (mode === '--run' || mode === '--static') {
  const root = fs.mkdtempSync(profileRoot + '/upgrade09-offline-');
  assert.equal(fs.realpathSync(root), root);
  const codeParent = path.resolve('.local/upgrade09-offline-code');
  fs.mkdirSync(codeParent, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(codeParent), codeParent, 'REAL_CODE_ROOT_REQUIRED');
  const codeRoot = path.join(codeParent, randomUUID());
  fs.mkdirSync(codeRoot, { mode: 0o700 });
  const started = Date.now(), deadline = started + 120000;
  const log = fs.openSync(path.join(root, 'worker.log'), 'wx', 0o600);
  const worker = fork(path.resolve('scripts/verify-upgrade-offline.mjs'), ['--worker'], {
    detached: true, stdio: ['ignore', log, log, 'ipc'],
    env: { ...process.env, HELPR_OFFLINE_ROOT: root, HELPR_OFFLINE_CODE: codeRoot, HELPR_OFFLINE_DEADLINE: String(deadline), HELPR_OFFLINE_SCOPE: mode === '--static' ? 'static' : 'all' },
  });
  fs.closeSync(log);
  const supervisor = { started, deadline, worker: worker.pid, passed: false, signals: [] };
  const rows = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    assert(match, 'PROCESS_ROW_INVALID');
    return { pid: +match[1], parent: +match[2], group: +match[3], birth: match[4].replace(/\s+/g, ' '), command: match[5] };
  });
  let failure;
  const exited = new Promise(resolve => {
    worker.once('exit', (code, signal) => resolve({ code, signal }));
    worker.once('error', error => resolve({ error: error.message }));
  });
  const timeout = new Promise(resolve => {
    const timer = setTimeout(() => { failure = 'OFFLINE_DEADLINE_EXCEEDED'; resolve(null); }, Math.max(1, deadline - Date.now()));
    exited.then(() => clearTimeout(timer));
  });
  let interrupt;
  const interrupted = new Promise(resolve => { interrupt = signal => { failure = signal; resolve(null); }; });
  const onTerm = () => interrupt('SUPERVISOR_SIGTERM');
  const onInt = () => interrupt('SUPERVISOR_SIGINT');
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  try {
    const identity = rows().find(row => row.pid === worker.pid);
    assert(identity && identity.parent === process.pid && identity.group === worker.pid && identity.command.includes('/scripts/verify-upgrade-offline.mjs --worker'), 'OWN_WORKER_IDENTITY_REQUIRED');
    supervisor.identity = identity;
    supervisor.exit = await Promise.race([exited, timeout, interrupted]);
    if (supervisor.exit?.code !== 0) failure ??= 'OFFLINE_WORKER_FAILED';
  } catch (error) { failure = error.message; }
  finally {
    // 清理不依赖worker、SQLite或任何报告写盘成功。
    try {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        const members = rows().filter(row => row.group === worker.pid);
        if (!members.length) break;
        const leader = members.find(row => row.pid === worker.pid);
        if (leader) assert(supervisor.identity && leader.birth === supervisor.identity.birth && leader.command === supervisor.identity.command, 'OWN_WORKER_IDENTITY_CHANGED');
        supervisor.signals.push({ signal, members });
        process.kill(-worker.pid, signal);
        await delay(signal === 'SIGTERM' ? 1000 : 100);
      }
      supervisor.remaining = rows().filter(row => row.group === worker.pid);
      assert.equal(supervisor.remaining.length, 0, 'OWN_WORKER_GROUP_REMAINING');
    } catch (error) { failure ??= error.message; supervisor.cleanupError = error.message; }
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
  }
  const resultFile = path.join(root, 'result.json');
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultFile));
    assert(result.passed && result.ended <= deadline && Date.now() <= deadline, 'OFFLINE_RESULTS_INCOMPLETE_OR_LATE');
    assert.equal(digest(original), originalHash, 'REAL_OLD_SOURCE_CHANGED');
    assert.deepEqual(fs.readFileSync(budgetFile), initialBudget, 'SHARED_BUDGET_CHANGED');
  } catch (error) { failure ??= error.message; }
  supervisor.ended = Date.now(); supervisor.error = failure; supervisor.passed = !failure;
  fs.writeFileSync(path.join(root, 'supervisor.json'), JSON.stringify(supervisor, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: supervisor.passed, report: resultFile, cases: result?.cases.map(c => ({ name: c.name, passed: c.passed, error: c.error })), error: failure }));
  process.exit(supervisor.passed ? 0 : 1);
}
const root = process.env.HELPR_OFFLINE_ROOT;
const codeRoot = process.env.HELPR_OFFLINE_CODE;
assert(root.startsWith(profileRoot + '/upgrade09-offline-') && fs.realpathSync(root) === root, 'REAL_WORKER_ROOT_REQUIRED');
assert(codeRoot.startsWith(path.resolve('.local/upgrade09-offline-code') + '/') && fs.realpathSync(codeRoot) === codeRoot, 'REAL_WORKER_CODE_REQUIRED');
const report = {
  scope: process.env.HELPR_OFFLINE_SCOPE === 'static' ? 'static codesign only; no application launch or migration' : 'Node source entry + real format-6 database copy + static codesign; no Electron or system authorization',
  started: Date.now(), deadline: Number(process.env.HELPR_OFFLINE_DEADLINE), sourceDatabaseSha256: originalHash,
  candidate: 37, appStarts: 0, installs: 0, applicationBuilds: 0, signing: 0,
  realModels: 0, remoteWrites: 0, sourceRecordProcessInterruptions: 0, cases: [], passed: false,
};
let child, childExit, reader;
const ownProcesses = [];
const ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 });
function save() {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
function remaining() {
  assert(Date.now() < report.deadline, 'OFFLINE_DEADLINE_EXCEEDED');
}
function copy(name, source = original) {
  remaining();
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.copyFileSync(source, path.join(folder, 'workspace.sqlite'), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(folder, 'workspace.sqlite'), 0o600);
  fs.writeFileSync(path.join(folder, '.workspace-records'), 'offline copied database\n', { mode: 0o600 });
  return folder;
}
async function check(name, work) {
  remaining();
  const result = { name, started: Date.now(), passed: false };
  report.cases.push(result);
  save();
  try {
    Object.assign(result, await work());
    remaining();
    Object.assign(result, { passed: true, ended: Date.now() });
  } catch (error) {
    Object.assign(result, { error: error.message, ended: Date.now() });
    throw error;
  } finally { save(); }
}
try {
  const build = createRequire(import.meta.resolve('vite'))('esbuild').buildSync;
  const entry = path.join(codeRoot, 'public.cjs');
  build({ stdin: { contents: "export {WorkspaceRecords} from './app/records/workspace';export {verifyPackageIdentity} from './app/desktop/package-identity';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: entry });
  build({ entryPoints: ['app/records/process.ts'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: path.join(codeRoot, 'records.cjs') });
  const { WorkspaceRecords, verifyPackageIdentity } = createRequire(import.meta.url)(entry);
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const migrations = path.resolve('app/records/migrations');
  const expected = JSON.parse(fs.readFileSync(baselineFile)).tasks;
  function facts(snapshot) {
    return snapshot.tasks.map(t => [t.id, t.goal, t.draft, t.messages.map(m => ({ role: m.role, text: m.text })), t.execution?.intent ?? null, t.execution?.phase ?? null]);
  }
  function read(folder, sql) {
    const db = new Database(path.join(folder, 'workspace.sqlite'), { readonly: true, timeout: 0 });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  }
  function migrate(folder, location = migrations) {
    const owner = new WorkspaceRecords(folder, location);
    try { assert.deepEqual(facts(owner.snapshot()), expected); } finally { owner.close(); }
  }
  if (process.env.HELPR_OFFLINE_SCOPE !== 'static') {
  let migrated;
  await check('真实旧库按冻结迁移到7，原任务、对话、中文草稿与停止逐值相同', () => {
    migrated = copy('migrated');
    assert.equal(read(migrated, 'SELECT schema_version FROM workspace')[0].schema_version, 6);
    migrate(migrated);
    assert.equal(read(migrated, 'SELECT schema_version FROM workspace')[0].schema_version, 7);
    const backups = fs.readdirSync(migrated).filter(f => /^workspace-before-upgrade-09-.*\.sqlite$/.test(f));
    assert.equal(backups.length, 1);
    const b = new Database(path.join(migrated, backups[0]), { readonly: true });
    try { assert.equal(b.prepare('SELECT schema_version FROM workspace').get().schema_version, 6); } finally { b.close(); }
    migrate(migrated);
    assert.equal(fs.readdirSync(migrated).filter(f => f.startsWith('workspace-before-upgrade-09-')).length, 1);
    return { tasksCompared: expected.length, independentOldBackup: true, reopened: true };
  });
  for (const kind of ['format', 'state']) await check('不兼容的' + kind + '明确拒绝且不清空资料', () => {
    const folder = copy('unsupported-' + kind, path.join(migrated, 'workspace.sqlite'));
    const db = new Database(path.join(folder, 'workspace.sqlite'));
    try {
      if (kind === 'format') db.prepare('UPDATE workspace SET schema_version=999').run();
      else db.exec("UPDATE task_executions SET body=json_set(body,'$.modelVersion',999)");
    } finally { db.close(); }
    const before = digest(path.join(folder, 'workspace.sqlite'));
    const code = kind === 'format' ? 'DATA_VERSION_UNSUPPORTED' : 'STATE_MODEL_UNSUPPORTED';
    assert.throws(() => new WorkspaceRecords(folder, migrations), { message: code });
    assert.equal(digest(path.join(folder, 'workspace.sqlite')), before);
    assert.equal(read(folder, 'SELECT count(*) n FROM tasks')[0].n, expected.length);
    return { code, rejectedCopyUnchanged: true };
  });
  await check('旧库遇到故意破坏的迁移SQL时回滚，保留旧副本并可用冻结迁移恢复', () => {
    const folder = copy('failed-migration');
    const broken = path.join(root, 'broken-migrations');
    fs.cpSync(migrations, broken, { recursive: true });
    fs.appendFileSync(path.join(broken, '0004_upgrade_09.sql'), '\n--> statement-breakpoint\nINSERT INTO offline_nonexistent_table VALUES (1);\n');
    assert.throws(() => new WorkspaceRecords(folder, broken), /offline_nonexistent_table/);
    assert.equal(read(folder, 'SELECT schema_version FROM workspace')[0].schema_version, 6);
    assert.equal(read(folder, "SELECT name FROM sqlite_master WHERE name='installation'").length, 0);
    const backups = fs.readdirSync(folder).filter(f => f.startsWith('workspace-before-upgrade-09-'));
    assert.equal(backups.length, 1);
    migrate(folder);
    return { injectedFault: 'invalid SQL only in disposable migration copy', rollback: true, recoveredWithFrozenMigration: true };
  });
  await check('真实冻结迁移提交受读锁阻挡时中断自有Node记录进程，再开保留原事实', async () => {
    const folder = copy('interrupted-migration');
    reader = new Database(path.join(folder, 'workspace.sqlite'));
    reader.exec('BEGIN; SELECT * FROM workspace;');
    const stderr = fs.openSync(path.join(folder, 'stderr.log'), 'wx', 0o600);
    try {
      child = fork(path.join(codeRoot, 'records.cjs'), [folder, migrations, '--workspace-validation'], { stdio: ['ignore', 'ignore', stderr, 'ipc'] });
    } finally { fs.closeSync(stderr); }
    childExit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
    const identities = ps().split('\n').filter(line => +line.trim().split(/\s+/)[0] === child.pid);
    assert.equal(identities.length, 1, 'OWNED_NODE_IDENTITY_REQUIRED');
    ownProcesses.push({ pid: child.pid, row: identities[0].trim() });
    let ready = false;
    child.on('message', input => { if (input.ready) ready = true; });
    const journal = path.join(folder, 'workspace.sqlite-journal');
    const limit = Date.now() + 2500;
    let pendingCommit = false;
    while (Date.now() < limit && child.exitCode === null && child.signalCode === null) {
      if (fs.existsSync(journal) && fs.statSync(journal).size > 512) {
        try { read(folder, 'SELECT schema_version FROM workspace'); }
        catch (error) { if (error.code === 'SQLITE_BUSY') { pendingCommit = true; break; } else throw error; }
      }
      await delay(10);
    }
    assert(pendingCommit && !ready, 'MIGRATION_PENDING_COMMIT_NOT_PROVEN');
    const journalBytes = fs.statSync(journal).size;
    report.sourceRecordProcessInterruptions++;
    child.kill('SIGKILL');
    const exit = await Promise.race([childExit, delay(3000).then(() => { throw Error('OWNED_NODE_EXIT_TIMEOUT'); })]);
    assert.equal(exit.signal, 'SIGKILL');
    reader.exec('ROLLBACK'); reader.close(); reader = null;
    migrate(folder);
    return { pendingCommitProvenByIndependentBusyRead: true, journalBytes, readyBeforeInterruption: ready, exit, recoveredWithFrozenMigration: true };
  });
  }
  await check('现有37签名有效，系统TextEdit被公开包身份入口拒绝', async () => {
    const identity = await verifyPackageIdentity(candidate.app);
    await assert.rejects(verifyPackageIdentity('/System/Applications/TextEdit.app'), { message: 'UPGRADE_PACKAGE_UNVERIFIED' });
    return { identity, wrongIdentifierRejected: true };
  });
  await check('破坏签名包的隔离克隆后拒绝，原包保持原哈希', async () => {
    const clone = path.join(root, 'tampered.app');
    execFileSync('/bin/cp', ['-cR', candidate.app, clone], { timeout: 30000 });
    fs.appendFileSync(path.join(clone, 'Contents/Resources/app.asar'), 'offline tamper');
    await assert.rejects(verifyPackageIdentity(clone), { message: 'UPGRADE_PACKAGE_UNVERIFIED' });
    assert.equal(digest(packageResource), candidate.hashes['Contents/Resources/app.asar']);
    return { damagedSealRejected: true, originalPackageUnchanged: true, cloneNotLaunched: true };
  });
    remaining();
    report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      report.sourceRecordProcessCleanup = { pid: child.pid, signal: 'SIGKILL', sent: child.kill('SIGKILL') };
      report.sourceRecordProcessCleanup.exit = await Promise.race([childExit, delay(3000).then(() => { throw Error('OWNED_NODE_CLEANUP_TIMEOUT'); })]);
    }
    if (reader) { reader.exec('ROLLBACK'); reader.close(); }
    const rows = ps().trim().split('\n');
    report.remainingOwnedProcesses = rows.filter(row => ownProcesses.some(owner => +row.trim().split(/\s+/)[0] === owner.pid || +row.trim().split(/\s+/)[2] === owner.pid));
    report.ownedProcesses = ownProcesses;
    assert.equal(report.remainingOwnedProcesses.length, 0, 'OWNED_NODE_REMAINING');
    assert.equal(digest(original), originalHash, 'REAL_OLD_SOURCE_CHANGED');
    assert.deepEqual(fs.readFileSync(budgetFile), initialBudget, 'SHARED_BUDGET_CHANGED');
  } catch (error) { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; }
  report.ended = Date.now();
  save();
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(c => ({ name: c.name, passed: c.passed, error: c.error })), report: path.join(root, 'result.json'), error: report.error, cleanupError: report.cleanupError }));
}
