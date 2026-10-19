// 核对实际包同轮 CUA 收起后的公开检查点；不启动应用，不把源码检查当作实包通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validationRoot } from './workspace-budget.mjs';

const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8);
assert(round && /^[a-z0-9-]{1,40}$/.test(round), 'ROUND_REQUIRED');
const result = JSON.parse(fs.readFileSync(path.join(validationRoot, round, 'result.json')));
assert.equal(result.purpose, 'lifecycle-06');
const before = result.checkpoints.find((entry) => entry.label === 'both-started-before-hide');
const start = result.checkpoints.find((entry) => entry.label === 'hidden-before-release');
const hidden = result.checkpoints.find((entry) => entry.label === 'hidden-both-advanced-once');
assert(before && start && hidden && start.at > before.at && hidden.at > start.at, 'HIDDEN_CHECKPOINTS_REQUIRED');
assert.equal(start.window?.visible, false, 'HIDDEN_WINDOW_REQUIRED_BEFORE_RELEASE');
const states = ['A', 'B'].map((name) => {
  const initial = before.snapshot.tasks.find((task) => task.goal.startsWith('06 ' + name + '，'));
  const suspendedWindow = start.snapshot.tasks.find((task) => task.id === initial?.id);
  const current = hidden.snapshot.tasks.find((task) => task.id === initial?.id);
  assert(initial?.execution?.intent === 'automatic' && !before.gates[name].blocked && before.gates[name].available, 'BOTH_QUALIFIED_BEFORE_HIDE');
  assert(suspendedWindow?.execution?.intent === 'automatic' && suspendedWindow.execution.phase === 'checking' && start.gates[name].available && !start.gates[name].blocked, 'BOTH_QUALIFIED_WHILE_HIDDEN');
  assert(!result.effects.some((entry) => entry.name === name && entry.at <= start.at), 'NO_EFFECT_BEFORE_HIDDEN_RELEASE');
  return {
    name,
    intent: current?.execution?.intent,
    phase: current?.execution?.phase,
    pauseReason: current?.execution?.pauseReason,
    available: hidden.gates[name].available,
    blocked: hidden.gates[name].blocked,
    effects: result.effects.filter((entry) => entry.name === name && entry.at > start.at && entry.at <= hidden.at).map((entry) => entry.count),
  };
});
console.log(JSON.stringify({round,states}));
assert(states.every((state) => state.intent === 'automatic' && state.phase === 'running' && state.available && !state.blocked && state.effects.length === 1 && state.effects[0] === 1), 'HIDDEN_TASKS_MUST_ADVANCE_WITHOUT_PAUSING');
assert.equal(hidden.window?.visible, false, 'HIDDEN_WINDOW_MUST_REMAIN_HIDDEN');
