import assert from 'node:assert/strict';
import { showInspectableWindow } from './version-window-ready.mjs';

// 用观察到的公开RPC响应序列复核验证器；不启动Electron，不充抵实包通过。
let time = 0, attempts = 0;
const calls = [], observations = [];
const inspection = { window: { visible: false } };
await showInspectableWindow({
  deadline: 15000, now: () => time, ready: () => false,
  wait: async ms => { time += ms; }, observe: value => observations.push(value),
  request: async command => {
    calls.push(command.kind);
    if (command.kind === 'inspect' && ++attempts < 3) throw Error('RECORDS_UNAVAILABLE');
    return inspection;
  },
});
assert.deepEqual(calls, ['inspect', 'inspect', 'inspect', 'show']);
assert.equal(observations.filter(row => row.error).length, 2);
assert.equal(time, 200);

for (const [error, ready] of [['DATA_CORRUPT', false], ['RECORDS_UNAVAILABLE', true]]) {
  let count = 0;
  await assert.rejects(showInspectableWindow({ deadline: 15000, now: () => 0, ready: () => ready, observe: () => {}, request: async () => { count++; throw Error(error); } }), { message: error });
  assert.equal(count, 1);
}

let count = 0;
await assert.rejects(showInspectableWindow({ deadline: 15000, now: () => 0, ready: () => false, observe: () => {}, wait: async () => {}, request: async () => { count++; throw Error('RECORDS_UNAVAILABLE'); } }), { message: 'RECORDS_UNAVAILABLE' });
assert.equal(count, 20);

let clock = 0;
const late = [];
await assert.rejects(showInspectableWindow({ deadline: 15000, now: () => clock, ready: () => false, observe: () => {}, request: async command => { late.push(command.kind); clock = 15001; return inspection; } }), { message: 'READY_DEADLINE' });
assert.deepEqual(late, ['inspect']);
console.log(JSON.stringify({ passed: true, scenarios: 5, appStarts: 0, models: 0, scope: 'validation readiness protocol, not packaged acceptance' }));
