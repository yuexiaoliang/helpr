import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { atomicJSON } from '../ai-parallel-binding/control.mjs';
export { atomicJSON as save };
export const directory = path.dirname(fileURLToPath(import.meta.url));
export const authFile = path.resolve(directory, '../runtime-flow-replay/private/auth.json');
export const load = async file => JSON.parse(await readFile(file, 'utf8'));
export const hash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const ensure = (ok, reason) => { if (!ok) throw new Error(reason); };
export async function event(root, value) {
  await mkdir(root, { recursive: true });
  await appendFile(path.join(root, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n');
}
export async function saveRecord(root, record) {
  record.updatedAt = new Date().toISOString();
  await atomicJSON(path.join(root, 'record.json'), { record, seal: hash(record) });
}
export async function readRecord(root) {
  const { record, seal } = await load(path.join(root, 'record.json'));
  ensure(record && hash(record) === seal, 'record-integrity');
  const task = await load(path.join(root, 'task.json'));
  ensure(record.taskDigest === hash(task) && record.taskId === task.id && record.executionId === task.executionId, 'execution-association');
  ensure(['running', 'stopped', 'awaiting-confirmation', 'human-control'].includes(record.intent), 'invalid-intent');
  ensure(['preparing', 'prepared', 'dispatching', 'observed'].includes(record.phase), 'invalid-phase');
  ensure(record.contractHash === hash(await load(path.join(directory, 'recovery-contract.json'))), 'contract-incompatible');
  ensure(record.flowHash === hash(await load(path.join(directory, 'workflow.json'))), 'workflow-incompatible');
  ensure(hash(await readFile(task.params.filePath)) === task.inputs.attachment_excel.sha256, 'material-changed');
  return { record, task };
}
