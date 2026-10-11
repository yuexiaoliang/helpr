import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { directory, load, save, hash, ensure, event, readRecord, saveRecord } from './common.mjs';
import { openProxy } from './proxy.mjs';

const [command, name, label, option] = process.argv.slice(2);
const ledgerFile = path.join(directory, 'private/study.json');
let study;
try { study = await load(ledgerFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (command === 'status') { console.log(JSON.stringify(study || { registered: false }, null, 2)); process.exit(0); }
const origin = 'http://home.ts-ali.internal:38080';
const sources = ['run.mjs', 'worker.mjs', 'proxy.mjs', 'common.mjs', 'workflow.json', 'recovery-contract.json',
  '../runtime-flow-replay/engine.mjs', '../workflow-reliability/executor.mjs', '../workflow-reliability/contract.mjs',
  '../runtime-flow-replay/package-lock.json', '../ai-parallel-binding/control.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(path.join(directory, file)))])));
if (!study) {
  ensure(['pair', 'create'].includes(command), 'study-not-registered');
  await mkdir(path.dirname(ledgerFile), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  study = { id, root: path.join(directory, 'artifacts', id), origin, startedAt: new Date().toISOString(), deadline: Date.now() + 45 * 60000,
    limits: { preparations: 6, upload: 6, publication: 6, revisions: 4, modelCalls: 0 }, versions: [], reservations: [], cases: {} };
  await mkdir(study.root, { recursive: true }); await copyFile(path.join(directory, 'PLAN.md'), path.join(study.root, 'PLAN.md'));
}
// 独占命令，避免多个实验驱动相互覆盖固定预算；不自动清理未确认的锁。
const lock = ledgerFile + '.lock';
await mkdir(lock);
let queue = Promise.resolve();
const update = change => {
  const next = queue.then(async () => { change(); await save(ledgerFile, study); await save(path.join(study.root, 'study.json'), study); });
  queue = next; return next;
};
const guard = () => ensure(Date.now() < study.deadline, 'experiment-time-budget');
const fingerprint = hash(sourceHashes);
try {
  if (study.versions.at(-1)?.fingerprint !== fingerprint) {
    ensure(study.versions.length <= study.limits.revisions, 'protocol-revision-budget');
    study.versions.push({ at: new Date().toISOString(), fingerprint, sourceHashes });
    const targetRoot = path.join(study.root, 'source', String(study.versions.length));
    for (const source of sources) { const target = path.join(targetRoot, source.replace(/^\.\.\//, 'shared/')); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(directory, source), target); }
    await update(() => {});
  }
  async function createCase(caseName, material, sameTitle = false) {
    guard(); ensure(!study.cases[caseName], 'case-already-registered');
    ensure(Object.keys(study.cases).length < study.limits.preparations, 'preparation-budget');
    const root = path.join(study.root, caseName), fileName = `${caseName}-${study.id}.xlsx`, filePath = path.join(root, fileName);
    await update(() => { study.cases[caseName] = { root, registeredAt: new Date().toISOString(), material, fingerprint }; });
    await mkdir(root, { recursive: true });
    await copyFile(path.join(directory, '../runtime-flow-replay/materials', material + '.xlsx'), filePath);
    const title = `恢复验证 ${sameTitle ? '同名双任务' : caseName} ${study.id}`;
    const body = `虚构恢复实验。任务 ${caseName}，执行 ${randomUUID()}，附件内容独立核对。`;
    const params = { origin, entryUrl: origin + '/wp-admin/', title, body, category: 'Excel 验证', filePath, fileName, fileStem: fileName.replace(/\.xlsx$/, '') };
    const task = { id: study.id + '/' + caseName, executionId: randomUUID(), origin, entryUrl: params.entryUrl, params,
      inputs: { post_title: { type: 'string', value: title }, post_content: { type: 'string', value: body }, post_category: { type: 'string', value: params.category },
        attachment_excel: { type: 'file', path: filePath, name: fileName, stem: params.fileStem, sha256: hash(await readFile(filePath)) } } };
    await save(path.join(root, 'task.json'), task);
    await saveRecord(root, { taskId: task.id, executionId: task.executionId, taskDigest: hash(task), intent: 'running', phase: 'preparing',
      flowHash: hash(await load(path.join(directory, 'workflow.json'))), contractHash: hash(await load(path.join(directory, 'recovery-contract.json'))), editorUrl: null });
    return root;
  }
  async function operate(caseName, mode, outputName, stopAt, extra = {}) {
    if (mode !== 'recover') guard();
    const root = study.cases[caseName]?.root; ensure(root, 'case-not-found');
    const output = path.join(root, outputName); await mkdir(output); // 既有运行的证据不可覆盖。
    const browserPids = new Set(); let child, result, failure, checkpoint, timer, abortReason;
    const kill = async reason => {
      if (!child || child.exitCode !== null || child.signalCode) return;
      checkpoint = reason;
      await event(output, { type: 'kill-request', targetPid: child.pid, reason }); child.kill('SIGKILL');
    };
    const proxy = await openProxy({ origin, root: path.join(output, 'proxy'), mode: mode === 'recover' ? 'readonly' : stopAt === 'response-lost' ? 'response-lost' : 'normal',
      hideResult: extra.hideResult, onHeld: ({ status }) => { if (status >= 400) abortReason = 'publication-http-failure'; return kill('response-lost'); },
      reserve: kind => update(() => {
        guard(); ensure(study.reservations.filter(r => r.kind === kind).length < study.limits[kind], kind + '-budget');
        study.reservations.push({ id: study.reservations.length + 1, caseName, kind, at: new Date().toISOString(), output: outputName });
      }) });
    try {
      child = fork(path.join(directory, 'worker.mjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = ''; child.stderr.on('data', b => { stderr += String(b); });
      const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      child.on('message', message => {
        if (message.browserPids) for (const pid of message.browserPids) browserPids.add(pid);
        if (message.progress !== undefined) console.log(JSON.stringify({ caseName, step: message.progress }));
        if (message.result) result = message.result;
        if (message.failure) failure = message.failure;
        if (message.checkpoint) void kill(message.checkpoint).catch(error => { abortReason = error.message; child.kill('SIGKILL'); });
      });
      timer = setTimeout(() => { abortReason = 'worker-timeout'; void kill('timeout'); }, 240000);
      child.send({ root, output, mode, proxy: proxy.url, stopAt, ...extra });
      const exit = await ended;
      // 被终止 worker 所创建的浏览器进程可能仍在退出中；只处理刚记录的归属 PID。
      for (const pid of browserPids) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      const outcome = { caseName, mode, outputName, pid: child.pid, browserPids: [...browserPids], exit, checkpoint, result, failure, abortReason,
        forwardedPublications: proxy.rows.filter(r => r.type === 'forward' && r.kind === 'publication').length,
        forwardedUploads: proxy.rows.filter(r => r.type === 'forward' && r.kind === 'upload').length,
        blockedWrites: proxy.rows.filter(r => r.type === 'blocked-write').length, stderr };
      await save(path.join(output, 'supervisor.json'), outcome); console.log(JSON.stringify(outcome));
      ensure(!failure && !abortReason, 'experiment-stage-failed');
      if ((mode === 'recover' || mode === 'resume') && !stopAt) ensure(exit.code === 0 && result, 'worker-did-not-finish');
      else ensure(checkpoint === stopAt && exit.signal === 'SIGKILL', 'fault-not-reached');
      return outcome;
    } finally { clearTimeout(timer); await proxy.close(); }
  }
  if (command === 'pair') {
    const first = name || 'A', second = label || 'B';
    await createCase(first, 'learn', true); await createCase(second, 'replay', true);
    const outcomes = await Promise.allSettled([operate(first, 'prepare', 'interrupted', 'response-lost'), operate(second, 'prepare', 'interrupted', 'prepared')]);
    ensure(outcomes.every(o => o.status === 'fulfilled'), 'pair-has-failure');
  } else if (command === 'create') {
    ensure(['observed', 'dispatch-gap', 'prepared', 'response-lost'].includes(label), 'invalid-stop-point');
    await createCase(name, name === 'C' ? 'repair' : 'updated'); await operate(name, 'prepare', 'interrupted', label);
  } else if (command === 'recover') {
    let extra = {};
    if (option === 'hide') extra.hideResult = true;
    else if (option?.startsWith('from=')) { const [sourceCase, probe] = option.slice(5).split('/'); extra.resultUrl = (await load(path.join(study.cases[sourceCase].root, probe, 'result.json'))).resultUrl; ensure(extra.resultUrl, 'source-result-missing'); }
    await operate(name, 'recover', label, option === 'result-verified' ? option : undefined, extra);
  } else if (command === 'recheck-preparation') {
    ensure(['prepared', 'dispatch-gap'].includes(option), 'invalid-recheck-checkpoint');
    await operate(name, 'recheck-preparation', label, option);
  } else if (command === 'resume') await operate(name, 'resume', label || 'continued', option);
  else if (command === 'intent') {
    ensure(['running', 'stopped', 'awaiting-confirmation', 'human-control'].includes(label), 'invalid-intent');
    const root = study.cases[name]?.root; ensure(root, 'case-not-found');
    const { record } = await readRecord(root), previous = record.intent; record.intent = label; await saveRecord(root, record);
    await event(root, { type: 'injected-intent', previous, next: label, source: 'experiment fixture, not a human interaction' });
    console.log(JSON.stringify({ caseName: name, intent: label }));
  } else throw new Error('usage: run.mjs status|pair|create NAME POINT|recover NAME LABEL [hide|from=CASE/LABEL]|resume NAME LABEL|intent NAME VALUE');
} finally {
  await queue.catch(() => {});
  const { rmdir } = await import('node:fs/promises'); await rmdir(lock);
}
