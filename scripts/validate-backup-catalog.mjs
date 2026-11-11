import assert from 'node:assert/strict';
import { execFile, execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { capacityVolume } from './backup-validation-storage.mjs';
import { fileHash, inventoryDirectory, sha256 } from './release-inputs.mjs';
import { spend, validationRoot } from './workspace-budget.mjs';

// 以已退出的隔离实包资料为输入，通过正式备份服务和独立记录进程核对。
// 文件选择由验证器提供，过程中不启动 Electron 或访问来源网站。
const [buildNumber, scheduledRun, repairRun] = process.argv.slice(2);
assert(/^\d+$/.test(buildNumber) && [scheduledRun, repairRun].every(run => /^run-\d+$/.test(run)));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const build = read(path.join(validationRoot, 'build-' + buildNumber + '.json'));
assert(build.prepared && build.bundle);
const resources = path.join(build.app, 'Contents/Resources');
const recordsFile = path.resolve('dist/main/records.cjs');
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve('electron-builder'))('@electron/asar');
const archive = path.join(resources, 'app.asar');
assert.equal(fileHash(archive), build.hashes['Contents/Resources/app.asar']);
assert.equal(sha256(asar.extractFile(archive, 'dist/main/records.cjs')), fileHash(recordsFile));
const migrations = path.join(resources, 'migrations');
assert.deepEqual(inventoryDirectory(migrations), inventoryDirectory(path.resolve('app/records/migrations')));
const profileRoot = fs.realpathSync('/private/tmp') + '/helpr-workspace-validation-' + process.getuid();
assert.equal(fs.realpathSync(profileRoot), profileRoot);
const release = lockfile.lockSync(validationRoot, {
  lockfilePath: path.join(validationRoot, 'workspace-run.lock'),
  stale: 180000,
});
const root = fs.mkdtempSync(path.join(validationRoot, 'p2-backup-catalog-'));
const report = { build: build.build, bundleSha256: build.bundle.sha256, recordsSha256: fileHash(recordsFile), checks: [], processes: [], faults: [] };
const write = () => fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const check = (name, verify) => {
  verify();
  report.checks.push(name);
  write();
};
const helpers = new Set();
const deadline = Date.now() + 180000;
const withinRound = () => assert(Date.now() < deadline, 'BACKUP_CATALOG_TIME_LIMIT');
const run = async (program, args, { input } = {}) => {
  const options = { timeout: 18000, maxBuffer: 2 * 1024 * 1024 };
  if (input !== undefined) return execFileSync(program, args, { ...options, input });
  const { stdout } = await promisify(execFile)(program, args, options);
  return stdout;
};
const rpcBundle = path.join(root, 'backup-service.cjs');
let openRecords;
let volume;

function clone(runName) {
  const evidenceFile = path.join(validationRoot, runName, 'result.json');
  const evidence = read(evidenceFile);
  assert(evidence.passed && evidence.storage === 'fixture' && evidence.app === build.app && evidence.remaining.length === 0);
  assert.equal(path.dirname(evidence.profile), profileRoot);
  assert.equal(fs.realpathSync(evidence.profile), evidence.profile);
  assert(/^run-[\w]+$/.test(path.basename(evidence.profile)));
  const dir = fs.mkdtempSync(path.join(profileRoot, 'backup-catalog-'));
  const copy = (source, destination) => {
    assert(fs.lstatSync(source).isFile());
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  };
  for (const file of ['workspace.sqlite', '.workspace-records']) copy(path.join(evidence.profile, file), path.join(dir, file));
  fs.mkdirSync(path.join(dir, 'materials'), { mode: 0o700 });
  for (const file of fs.readdirSync(path.join(evidence.profile, 'materials'))) {
    assert(/^[a-f0-9]{64}$/.test(file));
    copy(path.join(evidence.profile, 'materials', file), path.join(dir, 'materials', file));
    assert.equal(fileHash(path.join(dir, 'materials', file)), file);
  }
  report.inputs ??= [];
  report.inputs.push({ evidenceFile, evidenceSha256: fileHash(evidenceFile), databaseSha256: fileHash(path.join(dir, 'workspace.sqlite')), profile: dir });
  return { dir, evidence };
}

function independentArchive(file, receipt) {
  const contents = fs.readFileSync(file);
  const saved = JSON.parse(contents);
  const payload = Buffer.from(JSON.stringify(saved.payload));
  assert.equal(saved.dataVersion, build.source.dataFormat);
  assert.equal(saved.stateModel, build.source.stateModel);
  assert.deepEqual(saved.files, [{ name: 'records.json', bytes: payload.length, sha256: sha256(payload) }]);
  assert.equal(sha256(payload), receipt.checksum);
  assert(!contents.includes('local-fixture-not-a-secret'));
  assert(!Object.hasOwn(saved.payload, 'modelSettings'));
  for (const material of saved.payload.materials ?? []) {
    const bytes = Buffer.from(material.base64, 'base64');
    assert.equal(sha256(bytes), material.sha256);
  }
  return saved.payload;
}

try {
  const active = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 5000 });
  assert(!/\/helpr(?: Workspace)?\.app\/Contents\//.test(active), 'OTHER_VALIDATION_RUNNING');
  createRequire(import.meta.resolve('vite'))('esbuild').buildSync({
    stdin: {
      contents: "export { BackupService } from './app/desktop/backup-service'; export { ProcessClient } from './app/shared/rpc';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: rpcBundle,
  });
  const { BackupService, ProcessClient } = require(rpcBundle);
  openRecords = async dir => {
    withinRound();
    const child = fork(recordsFile, [dir, migrations], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    helpers.add(child);
    const process = { pid: child.pid, dir };
    report.processes.push(process);
    child.stderr.on('data', () => {});
    child.once('exit', (code, signal) => { process.exit = { code, signal }; helpers.delete(child); });
    const client = new ProcessClient({
      send: packet => child.send(packet),
      listen: listener => child.on('message', listener),
      onExit: listener => child.once('exit', listener),
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('RECORDS_NOT_READY')), 5000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(Error('RECORDS_EXITED')); });
      child.on('message', input => {
        if (!input.ready && !input.startupError) return;
        clearTimeout(timeout);
        if (input.startupError) reject(Error(input.startupError));
        else resolve();
      });
    });
    return {
      request: command => {
        if (command.kind !== 'close') withinRound();
        return client.request(command, 10000);
      },
      close: async () => {
        const exited = once(child, 'exit');
        await client.request({ kind: 'close' });
        assert.deepEqual(await exited, [0, null]);
      },
    };
  };
  const scheduled = clone(scheduledRun);
  const repaired = clone(repairRun);
  assert.equal(scheduled.evidence.releaseP1.mode, 'automation');
  assert.equal(repaired.evidence.repair.cases.length, 4);
  volume = await capacityVolume({
    root, profileRoot, run,
    fault: (name, details) => { spend('faults'); report.faults.push({ name, ...details }); write(); },
    save: state => { report.volume = state; write(); },
    emergency: () => spend('cleanups'),
  });
  for (const [name, sample] of [['scheduled', scheduled], ['cleanup', repaired]]) {
    let records = await openRecords(sample.dir);
    let selection;
    let state = await records.request({ kind: 'snapshot' });
    const initial = state;
    const restoreCalls = [];
    const service = new BackupService({
      choose: async () => selection,
      records: command => records.request({ kind: 'backup', command }),
      current: () => state,
      publish: next => { state = next; },
      hold: async () => { restoreCalls.push('hold'); },
      release: async () => { restoreCalls.push('release'); },
      ready: () => true,
    });
    if (name === 'scheduled') {
      selection = volume.mount;
      await service.handle({ kind: 'backup-location' });
      await assert.rejects(service.handle({ kind: 'backup-create', requestId: randomUUID() }), /BACKUP_STORAGE_FULL/);
      check('隔离卷实际 ENOSPC，备份失败保留完整计划和已有结果', () => {
        assert.equal(service.status().phase, 'error');
        assert.deepEqual(fs.readdirSync(volume.mount).filter(file => file.endsWith('.helpr-backup')), []);
        assert.deepEqual(state, initial);
      });
      assert.deepEqual(await records.request({ kind: 'snapshot' }), initial);
      await volume.release();
    }
    selection = root;
    await service.handle({ kind: 'backup-location' });
    const created = await service.handle({ kind: 'backup-create', requestId: randomUUID() });
    const previous = independentArchive(created.archive.file, created.archive);
    const originalFileHash = fileHash(created.archive.file);
    assert.deepEqual(previous.tasks, initial.tasks);
    let verify;
    let cleanedDigest;
    if (name === 'scheduled') {
      const owner = initial.tasks.find(t => t.execution?.schedule);
      const child = initial.tasks.find(t => t.id === owner.execution.schedule.rounds[0].links[0].taskId);
      const version = owner.execution.agreements.at(-1);
      const stop = { kind: 'intent', intent: 'stop', taskId: child.id, requestId: randomUUID() };
      assert.equal(child.execution.publicationChecks[0].status, 'verified');
      assert.equal(version.revokedAt, null);
      await records.request({ kind: 'execution', command: stop });
      await records.request({
        kind: 'execution',
        command: { kind: 'agreement-revoke', taskId: owner.id, versionId: version.versionId, requestId: randomUUID() },
      });
      verify = next => {
        const restored = next.tasks.find(t => t.id === child.id).execution;
        const plan = next.tasks.find(t => t.id === owner.id).execution;
        assert.equal(restored.intent, 'stopped');
        assert.equal(restored.intentId, stop.requestId);
        assert.deepEqual(restored.publicationChecks, child.execution.publicationChecks);
        assert.deepEqual(restored.materialWorks, child.execution.materialWorks);
        assert.deepEqual(plan.schedule.rounds, owner.execution.schedule.rounds);
        assert.equal(plan.schedule.restoreReview, true);
        assert(plan.agreements.at(-1).revokedAt > 0);
      };
    } else {
      const completed = sample.evidence.repair.cases.at(-1).taskId;
      const task = initial.tasks.find(t => t.id === completed);
      const sha = task.execution.materials[0].sha256;
      cleanedDigest = sha;
      const fixed = path.join(sample.dir, 'materials', sha);
      assert.equal(fileHash(fixed), sha);
      const taskIds = [completed];
      const preview = await records.request({ kind: 'cleanup', command: { kind: 'cleanup-preview', taskIds } });
      assert.equal(preview.tasks[0].eligible, true);
      const requestId = randomUUID();
      await records.request({ kind: 'cleanup', command: { kind: 'cleanup-commit', taskIds, requestId, token: preview.token } });
      verify = next => {
        const restored = next.tasks.find(t => t.id === completed).execution;
        assert.equal(restored.historyCleanup.requestId, requestId);
        assert(!fs.existsSync(fixed));
        assert.deepEqual(restored.materialProcessing, task.execution.materialProcessing);
        assert.deepEqual(restored.publicationChecks, task.execution.publicationChecks);
      };
    }
    const newer = await records.request({ kind: 'snapshot' });
    state = newer;
    selection = created.archive.file;
    const opened = await service.handle({ kind: 'backup-open' });
    const restored = await service.handle({ kind: 'backup-restore', selection: opened.selection.token, requestId: randomUUID() });
    const safety = independentArchive(restored.safety.file, restored.safety);
    assert.deepEqual(restoreCalls, ['hold', 'release']);
    assert.equal(restored.phase, 'restored');
    verify(state);
    assert.deepEqual(safety.tasks, newer.tasks);
    assert.equal(fileHash(created.archive.file), originalFileHash);
    let afterCleanup;
    if (cleanedDigest) {
      afterCleanup = (await service.handle({ kind: 'backup-create', requestId: randomUUID() })).archive;
      const payload = independentArchive(afterCleanup.file, afterCleanup);
      check('清理后新备份保留事实并省略已删除副本', () => {
        assert(!payload.materials.some(material => material.sha256 === cleanedDigest));
        verify(payload);
      });
    }
    await records.close();
    records = await openRecords(sample.dir);
    const cold = await records.request({ kind: 'snapshot' });
    check(name === 'scheduled' ? '旧备份恢复与记录冷开保持较新的停止及约定撤销' : '旧备份恢复与记录冷开保持较新的清理及已完成事实', () => verify(cold));
    await records.close();
    const db = new DatabaseSync(path.join(sample.dir, 'workspace.sqlite'), { readOnly: true });
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    db.close();
    (report.archives ??= []).push({ name, original: created.archive, originalFileHash, safety: restored.safety, afterCleanup });
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  for (const child of helpers) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  if (volume) {
    try { await volume.cleanup(); }
    catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  }
  report.remaining = execFileSync('/bin/ps', ['-axo', 'pid='], { encoding: 'utf8', timeout: 5000 })
    .trim().split(/\s+/).map(Number).filter(pid => report.processes.some(p => p.pid === pid));
  if (report.remaining.length) { report.passed = false; process.exitCode = 1; }
  write();
  release();
  console.log('证据：' + root);
}
