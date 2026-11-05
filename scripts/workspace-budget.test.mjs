import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  debitValidationBudget,
  updateValidationBudget,
} from './workspace-budget.mjs';

test('旧总额用尽后仍可隔离调试，原用量、限额及已结束批次逐值保留', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpr-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const used = {
    builds: 41,
    installs: 19,
    starts: 131,
    faults: 45,
    cleanups: 21,
  };
  const old = {
    used,
    limits: { ...used },
    upgrade09Repair: { active: false },
    modelCalls: 7,
    remoteWrites: 2,
  };
  const file = path.join(dir, 'budget.json');
  fs.writeFileSync(file, JSON.stringify(old));
  for (const kind of Object.keys(used))
    updateValidationBudget(
      (budget) => debitValidationBudget(budget, kind),
      dir,
    );
  const saved = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(saved), {
    ...old,
    used: { builds: 42, installs: 20, starts: 132, faults: 46, cleanups: 22 },
  });
  for (const key of ['modelCalls', 'remoteWrites', 'unrecognized'])
    assert.throws(
      () => updateValidationBudget((b) => debitValidationBudget(b, key), dir),
      /UNKNOWN_LOCAL_OPERATION/,
    );
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('新工作副本首次记账无需配置额度；损坏的旧计数不会被重置或覆盖', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpr-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'budget.json');
  const created = updateValidationBudget(
    (b) => debitValidationBudget(b, 'starts'),
    dir,
  );
  assert.equal(created.used.starts, 1);
  const damaged = JSON.stringify({ used: { starts: null } });
  fs.writeFileSync(file, damaged);
  assert.throws(
    () =>
      updateValidationBudget((b) => debitValidationBudget(b, 'starts'), dir),
    /INVALID_VALIDATION_COUNTER/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});

test('并发构建与验证共享账本，产生的编号唯一且批次更新不会丢失', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpr-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const module = new URL('./workspace-budget.mjs', import.meta.url).href;
  const worker = `
    import { updateValidationBudget, debitValidationBudget } from ${JSON.stringify(module)};
    const [dir, caller] = process.argv.slice(1);
    const numbers = [];
    for (let i = 0; i < 5; i++) {
      const budget = updateValidationBudget(b => {
        debitValidationBudget(b, 'builds');
        b[caller] = i + 1;
      }, dir);
      numbers.push(budget.used.builds);
    }
    console.log(JSON.stringify(numbers));
  `;
  const results = await Promise.all(
    ['first', 'second'].map((caller) =>
      promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', worker, dir, caller],
        { timeout: 15000 },
      ),
    ),
  );
  const numbers = results
    .flatMap((r) => JSON.parse(r.stdout))
    .sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json')));
  assert.equal(budget.first, 5);
  assert.equal(budget.second, 5);
});
