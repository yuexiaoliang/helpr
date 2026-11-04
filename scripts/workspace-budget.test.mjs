import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debitValidationBudget } from './workspace-budget.mjs';

test('明确取消总次数限制只适用于获批且仍在进行的09验证，保留累计数和其它事项上限', () => {
  const budget = {
    limits: { starts: 103, builds: 38, faults: 43 },
    used: { starts: 103, builds: 38, faults: 43 },
    upgrade09Repair: { approved: true, unlimited: true, active: true },
  };
  assert.throws(
    () => debitValidationBudget(budget, 'starts'),
    /VALIDATION_BUDGET_EXHAUSTED/,
  );
  debitValidationBudget(budget, 'starts', 'upgrade09Repair');
  assert.equal(budget.used.starts, 104);
  assert.equal(budget.limits.starts, 103);
  assert.throws(
    () => debitValidationBudget(budget, 'faults', 'upgrade09Repair'),
    /VALIDATION_BUDGET_EXHAUSTED/,
  );
  budget.upgrade09Repair.active = false;
  assert.throws(
    () => debitValidationBudget(budget, 'builds', 'upgrade09Repair'),
    /VALIDATION_BUDGET_EXHAUSTED/,
  );
});
