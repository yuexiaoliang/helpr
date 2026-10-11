// 继承旧实验候选的离线回归；不能证明本轮自动学习已经生成完整流程。
import { readFile, mkdir } from 'node:fs/promises';
import { save, hash, actionSeal, validateCandidate, createMachine } from './runtime.mjs';

const source = '../workflow-reliability/artifacts/focused-bound-candidate/candidate.json';
const workflow = JSON.parse(await readFile(source));
const task = JSON.parse(await readFile('../workflow-reliability/artifacts/final-path/baseline/results.json')).task;
const ledger = workflow.steps.map(s => ({ id: s.id, seal: actionSeal(s) }));
const report = { source, sourceDigest: hash(workflow), provenance: 'previous-experiment-assisted-candidate; offline-regression-only', cases: [] };
try {
  validateCandidate(workflow, task, ledger);
  report.baselineAccepted = true;
  const mutant = structuredClone(workflow);
  for (const s of mutant.steps) if (s.effect === 'commit') s.effect = 'read';
  try { validateCandidate(mutant, task, ledger); report.cases.push({ name: 'commit-relabelled-read', rejected: false }); }
  catch (e) { report.cases.push({ name: 'commit-relabelled-read', rejected: e.code === 'action-or-effect-changed', code: e.code, detail: e.detail, browserOpened: false }); }
  const changed = structuredClone(task), key = Object.keys(changed.inputs).find(k => changed.inputs[k].type === 'string');
  changed.inputs[key].value += '-tampered';
  try {
    const machine = createMachine({ page: { isClosed: () => false, url: () => changed.entryUrl }, task: changed,
      deadline: Date.now() + 10000, emit: async () => { throw new Error('unexpected-dispatch'); } });
    await machine.perform(workflow.steps[0], workflow.commitChecks);
    report.cases.push({ name: 'task-input-tamper', rejected: false });
  } catch (e) { report.cases.push({ name: 'task-input-tamper', rejected: e.code === 'task-changed', code: e.code, actualInterfaceCalled: true, browserOpened: false }); }
} catch (e) { report.baselineAccepted = false; report.error = { code: e.code || e.name, detail: e.detail, message: e.message }; }
await mkdir('artifacts/integrity-probe', { recursive: true });
await save('artifacts/integrity-probe/results.json', report);
console.log(JSON.stringify(report));
