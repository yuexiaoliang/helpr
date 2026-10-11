import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { directory, load, save, hash, saveRecord, readRecord } from './common.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helpr-recovery-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'material.xlsx');
  await writeFile(filePath, 'fictional-material');
  const task = { id: 'task-A', executionId: 'execution-A', params: { filePath },
    inputs: { attachment_excel: { sha256: hash(await readFile(filePath)) } } };
  const record = { taskId: task.id, executionId: task.executionId, taskDigest: hash(task), intent: 'running', phase: 'prepared',
    flowHash: hash(await load(path.join(directory, 'workflow.json'))),
    contractHash: hash(await load(path.join(directory, 'recovery-contract.json'))) };
  await save(path.join(root, 'task.json'), task); await saveRecord(root, record);
  return { root, record, task, filePath, recordFile: path.join(root, 'record.json') };
}

test('新进程读取四种持久化意图，不改变执行身份或重建记录', async t => {
  const f = await fixture(t);
  for (const intent of ['running', 'stopped', 'awaiting-confirmation', 'human-control']) {
    await saveRecord(f.root, { ...f.record, intent });
    const before = await readFile(f.recordFile);
    const code = `import {readRecord} from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}; console.log(JSON.stringify((await readRecord(process.argv[1])).record));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code, f.root]);
    const actual = JSON.parse(stdout);
    assert.equal(actual.intent, intent); assert.equal(actual.executionId, f.task.executionId);
    assert.deepEqual(await readFile(f.recordFile), before);
  }
});

test('记录缺失、截断或内容损坏时拒绝读取，保留原始文件', async t => {
  const f = await fixture(t);
  for (const content of ['{', JSON.stringify({ record: { ...f.record, intent: 'running' }, seal: 'wrong' })]) {
    await writeFile(f.recordFile, content);
    await assert.rejects(readRecord(f.root));
    assert.equal(await readFile(f.recordFile, 'utf8'), content);
  }
  await rm(f.recordFile);
  await assert.rejects(readRecord(f.root), { code: 'ENOENT' });
  await assert.rejects(readFile(f.recordFile), { code: 'ENOENT' });
});

test('有效封装中的执行身份、任务内容或素材字节不一致也必须拒绝', async t => {
  const f = await fixture(t);
  await saveRecord(f.root, { ...f.record, executionId: 'execution-B' });
  await assert.rejects(readRecord(f.root), /execution-association/);
  await saveRecord(f.root, f.record);
  await save(path.join(f.root, 'task.json'), { ...f.task, id: 'task-B' });
  await assert.rejects(readRecord(f.root), /execution-association/);
  await save(path.join(f.root, 'task.json'), f.task);
  await writeFile(f.filePath, 'changed-material');
  await assert.rejects(readRecord(f.root), /material-changed/);
});

test('不兼容的流程和条件版本不能沿用旧进度', async t => {
  const f = await fixture(t);
  for (const [field, error] of [['flowHash', /workflow-incompatible/], ['contractHash', /contract-incompatible/]]) {
    await saveRecord(f.root, { ...f.record, [field]: 'different-version' });
    await assert.rejects(readRecord(f.root), error);
  }
});
