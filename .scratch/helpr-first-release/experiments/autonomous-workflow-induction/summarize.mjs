import { readFile, writeFile, readdir } from 'node:fs/promises';
import { hash } from './runtime.mjs';
const attempts = [];
for (const name of ['attempt-a', 'attempt-b', 'attempt-c', 'attempt-d', 'attempt-e']) {
  const meta = JSON.parse(await readFile(`artifacts/${name}/meta.json`));
  const r = JSON.parse(await readFile(`artifacts/${name}/learn/results.json`));
  attempts.push({ name, status: r.status, error: r.error, completedSteps: r.trace.length, failures: r.failures.length,
    modelCalls: meta.modelCalls.length, reportedTokens: meta.tokens, outputMode: meta.outputMode || 'json-object',
    sourceHashes: meta.sourceHashes, metadata: `artifacts/${name}/meta.json`, result: `artifacts/${name}/learn/results.json` });
}
const probes = JSON.parse(await readFile('artifacts/probes/meta.json'));
const conditions = JSON.parse(await readFile('artifacts/condition-probe/meta.json'));
const integrity = JSON.parse(await readFile('artifacts/integrity-probe/results.json'));
const records = [];
for (const name of [...attempts.map(a => a.name), 'probes', 'condition-probe']) {
  const m = JSON.parse(await readFile(`artifacts/${name}/meta.json`));
  records.push(...m.modelCalls.map(r => ({ run: name, ...r })));
}
const sources = (await readdir('.')).filter(p => p.endsWith('.mjs') || p === 'package-lock.json');
const index = { date: '2026-10-10', completeWorkflowsLearned: 0, attempts,
  semanticCases: probes.cases.filter(c => c.label.startsWith('applicability-')),
  localConditionRuns: conditions.runs.map(r => ({ name: r.name, status: r.status, passed: r.passed,
    negativePassed: r.negative?.passed, independentExpectedBodyFound: r.independentExpectedBodyFound, commitDispatched: r.commitDispatched,
    result: `artifacts/condition-probe/${r.name}/results.json` })),
  inheritedIntegrityRegression: integrity,
  model: { calls: records.length, reportedTokens: records.reduce((s, r) => s + (r.usage?.total_tokens || 0), 0),
    missingUsage: records.filter(r => !r.usage).map(({ run, label, error }) => ({ run, label, error })), records },
  currentSourceHashes: Object.fromEntries(await Promise.all(sources.map(async f => [f, hash(await readFile(f))]))) };
await writeFile('artifacts/evidence-index.json', JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ completeWorkflowsLearned: index.completeWorkflowsLearned, calls: index.model.calls, reportedTokens: index.model.reportedTokens,
  missingUsage: index.model.missingUsage, attempts: attempts.map(({ name, status, modelCalls, reportedTokens }) => ({ name, status, modelCalls, reportedTokens })), localConditionRuns: index.localConditionRuns }));
