import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readStatus } from './control.mjs';
import { validateConfig } from '../model-api/client.mjs';

// 执行依赖显式登记；采集代码单独计程序修订，不使功能证据失效。
const executionFiles = ['run.mjs', 'control.mjs', 'plan.mjs', 'registration.mjs', 'model.mjs', 'worker.mjs', 'host.mjs',
  'lab.mjs', 'electron.cjs', 'extension/manifest.json', 'extension/background.js',
  '../model-api/client.mjs', '../independent-stop/control.mjs',
  '../independent-stop/package.json', '../independent-stop/package-lock.json'];
const hash = value => createHash('sha256').update(value).digest('hex');
export async function planExperiment({ directory, ledgerPath, registration, config, cases }) {
  const sourceHashes = {};
  for (const file of executionFiles) sourceHashes[file] = hash(await readFile(path.join(directory, file)));
  const captureHash = hash(await readFile(path.join(directory, 'capture.mjs')));
  const normalized = validateConfig(config);
  const configHash = hash(JSON.stringify({ protocol: normalized.protocol, baseUrl: normalized.baseUrl,
    model: normalized.model, timeoutMs: normalized.timeoutMs, requestOptions: normalized.requestOptions }));
  const execution = hash(JSON.stringify({ sourceHashes, configHash, node: process.version, platform: process.platform, arch: process.arch }));
  const fingerprint = { execution, revision: hash(execution + captureHash), sourceHashes, configHash, captureHash };
  const status = await readStatus(ledgerPath, registration);
  const completed = cases.filter(key => status.results.some(r => r.key === key && r.status === 'passed' && r.fingerprint === execution));
  return { fingerprint, completed, remaining: cases.filter(key => !completed.includes(key)), budget: status.budget,
    invalidated: cases.filter(key => !completed.includes(key) && status.results.some(r => r.key === key && r.status === 'passed')),
    missingCapture: completed.filter(key => status.results.findLast(r => r.key === key && r.fingerprint === execution && r.status === 'passed').capture.status !== 'passed') };
}
