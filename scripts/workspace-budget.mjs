import fs from 'node:fs';
import path from 'node:path';
export const validationRoot = path.resolve('.local/workspace-validation');
export function spend(kind) {
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
  if (budget.used[kind] >= budget.limits[kind])
    throw Error('VALIDATION_BUDGET_EXHAUSTED');
  budget.used[kind]++;
  fs.writeFileSync(file, JSON.stringify(budget, null, 2) + '\n', {
    mode: 0o600,
  });
  return budget;
}
