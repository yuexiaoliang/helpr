import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'artifacts/' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
await mkdir(root, { recursive: true });
console.log('Evidence: ' + root);
const results = [];
const sourceWorkflow = process.argv[3] && path.resolve(process.argv[3]);
if (sourceWorkflow) {
  const learning = JSON.parse(await readFile(path.join(path.dirname(sourceWorkflow), 'learn/results.json')));
  if (!learning.passed) throw new Error('source-learning-not-verified');
  await copyFile(sourceWorkflow, path.join(root, 'workflow-v1.json'));
  results.push(learning);
  await writeFile(path.join(root, 'source-learning.json'), JSON.stringify({ workflow: sourceWorkflow, results: path.join(path.dirname(sourceWorkflow), 'learn/results.json') }, null, 2));
}
for (const mode of sourceWorkflow ? ['replay', 'repair', 'updated'] : ['learn', 'replay', 'repair', 'updated']) {
  const child = spawn(process.execPath, ['worker.mjs', mode, root], { stdio: 'inherit' });
  const code = await new Promise(resolve => child.on('exit', resolve));
  results.push(JSON.parse(await readFile(path.join(root, mode, 'results.json'))));
  if (code !== 0) { process.exitCode = 1; break; }
}
await writeFile(path.join(root, 'summary.json'), JSON.stringify({
  passed: results.length === 4 && results.every(row => row.passed),
  sourceWorkflow,
  distinctWorkerPids: new Set(results.map(row => row.pid)).size === results.length,
  results: results.map(row => ({ mode: row.mode, pid: row.pid, passed: row.passed,
    modelPurposeCounts: row.modelPurposeCounts, resultUrl: row.publication?.url, fileHash: row.publication?.sha256, error: row.error }))
}, null, 2) + '\n');
