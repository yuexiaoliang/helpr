import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { writeValidationJSON } from './validation-json.mjs';

// 所有工作副本共享用量及候选编号。已结束的验收批次仍保留原限额和证据。
const commonGitDirectory = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { encoding: 'utf8', timeout: 5000 },
).trim();
export const validationRoot = path.join(
  path.dirname(commonGitDirectory),
  '.local/workspace-validation',
);
const localOperations = ['builds', 'installs', 'starts', 'faults', 'cleanups'];
const lockWait = new Int32Array(new SharedArrayBuffer(4));

function lockBudget(file) {
  const deadline = Date.now() + 12000;
  for (;;) {
    try {
      return lockfile.lockSync(file, { realpath: false });
    } catch (error) {
      if (error.code !== 'ELOCKED' || Date.now() >= deadline) throw error;
      Atomics.wait(lockWait, 0, 0, 25);
    }
  }
}

export function debitValidationBudget(budget, kind) {
  if (!localOperations.includes(kind)) throw Error('UNKNOWN_LOCAL_OPERATION');
  const used = budget.used[kind];
  if (
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isSafeInteger(used + 1)
  )
    throw Error('INVALID_VALIDATION_COUNTER');
  budget.used[kind] = used + 1;
  return budget;
}

// 构建和验证都可能写入同一文件。只在读、改、原子替换期间持锁。
export function updateValidationBudget(update, directory = validationRoot) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'budget.json');
  const release = lockBudget(file);
  try {
    const budget = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : {
          limits: {},
          used: Object.fromEntries(localOperations.map((kind) => [kind, 0])),
          modelCalls: 0,
          remoteWrites: 0,
        };
    update(budget);
    writeValidationJSON(file, budget);
    return budget;
  } finally {
    release();
  }
}

export function spend(kind) {
  return updateValidationBudget((budget) =>
    debitValidationBudget(budget, kind),
  );
}
