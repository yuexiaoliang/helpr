import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// 所有Git工作副本共用累计账本；创建工作副本不能得到一份新的默认额度。
const commonGitDirectory = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { encoding: 'utf8', timeout: 5000 },
).trim();
export const validationRoot = path.join(
  path.dirname(commonGitDirectory),
  '.local/workspace-validation',
);
export function debitValidationBudget(budget, kind, scope) {
  const uncapped =
    scope === 'upgrade09Repair' &&
    budget.upgrade09Repair?.approved === true &&
    budget.upgrade09Repair?.unlimited === true &&
    budget.upgrade09Repair?.active === true &&
    ['builds', 'installs', 'starts', 'faults', 'cleanups'].includes(kind);
  if (!uncapped && budget.used[kind] >= budget.limits[kind])
    throw Error('VALIDATION_BUDGET_EXHAUSTED');
  budget.used[kind]++;
  return budget;
}
export function spend(kind, scope) {
  fs.mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
  const file = path.join(validationRoot, 'budget.json');
  const budget = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {
        limits: { builds: 3, installs: 1, starts: 6, faults: 1, cleanups: 1 },
        used: { builds: 0, installs: 0, starts: 0, faults: 0, cleanups: 0 },
        modelCalls: 0,
        remoteWrites: 0,
      };
  debitValidationBudget(budget, kind, scope);
  fs.writeFileSync(file, JSON.stringify(budget, null, 2) + '\n', {
    mode: 0o600,
  });
  return budget;
}
