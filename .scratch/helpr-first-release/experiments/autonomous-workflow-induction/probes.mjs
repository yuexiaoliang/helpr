// 完整探索失败后的独立对照；不会派发浏览器动作，也不作为流程已学会的证据。
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, createClient } from '../model-api/client.mjs';
import { save, taskFromProposal, validateStep, hash } from './runtime.mjs';
import { parseInstruction } from './prompts.mjs';
import { fixture } from './fixtures.mjs';

const root = path.resolve('artifacts/probes'); await mkdir(root, { recursive: true });
const calls = [], result = { startedAt: new Date().toISOString(), modelCalls: calls, cases: [] };
const { config, apiKey } = await loadConfig('../model-api/config.example.json', '../model-api/.env.local');
config.timeoutMs = 120000;
const client = createClient(config, apiKey, calls);
const object = { type: 'object', additionalProperties: true };
const decisionSchema = { type: 'object', properties: {
  note: { type: 'string' }, action: object, effect: { type: 'string', enum: ['read', 'edit', 'upload', 'commit'] },
  before: { type: 'array', items: object }, after: { type: 'array', items: object }, commitChecks: { type: 'array', items: object }
}, required: ['action', 'effect', 'before', 'after', 'commitChecks'], additionalProperties: false };
async function ask(label, messages, schema) {
  await save(root + '/' + label + '-input.json', { messages, schema });
  const tools = [{ type: 'function', function: { name: 'record_proposal', description: '记录本次实验的结构化提议，不执行任何动作。', parameters: schema } }];
  try {
    const answer = await client.request(label, { messages, tools, tool_choice: { type: 'function', function: { name: 'record_proposal' } }, max_tokens: 6500, temperature: 0 });
    await save(root + '/' + label + '-answer.json', answer);
    const call = answer.tool_calls?.[0];
    if (answer.tool_calls?.length !== 1 || call.function.name !== 'record_proposal') throw new Error('unexpected-tool-call');
    return JSON.parse(call.function.arguments);
  } finally { await save(root + '/meta.json', result); }
}
const learning = JSON.parse(await readFile('artifacts/attempt-d/learn/results.json'));
const raw = await readFile('artifacts/attempt-d/model/08-explore-5/answer.txt', 'utf8');
const recordedInput = JSON.parse(await readFile('artifacts/attempt-d/model/08-explore-5/input.json'));
for (const [label, messages] of [
  ['native-format-repair', [{ role: 'system', content: '通过指定工具修正给定输出的 JSON 语法。保持所有字段、动作、条件及值原意，不执行操作。' }, { role: 'user', content: raw }]],
  ['native-fresh-proposal', [{ role: 'system', content: recordedInput.instruction + '\n通过指定工具提供提议。' }, { role: 'user', content: JSON.stringify(recordedInput.input) }]]
]) {
  try {
    const proposal = await ask(label, messages, decisionSchema);
    validateStep({ id: 'probe', ...proposal }, learning.task);
    result.cases.push({ label, validJsonAndLocalShape: true, proposal, semanticCorrectness: 'not-established', dispatched: false });
  } catch (e) { result.cases.push({ label, validJsonAndLocalShape: false, error: e.message, dispatched: false }); }
  console.log(JSON.stringify(result.cases.at(-1)));
}
const variants = ['publish', 'draft', 'update', 'summarize'];
const fixtures = [];
for (let i = 0; i < variants.length; i++) fixtures.push(await fixture(root, 'case-' + i, variants[i]));
const input = {
  template: { kind: learning.task.kind, goal: learning.task.goal, constraints: learning.task.constraints,
    inputs: Object.fromEntries(Object.entries(learning.task.inputs).map(([k, v]) => [k, { type: v.type, description: learning.task.sources[k]?.description }])) },
  requests: fixtures.map((f, i) => ({ id: 'case-' + i, request: f.envelope.text, attachments: f.envelope.attachments.map(({ id, name }) => ({ id, name })) }))
};
try {
  const proposal = await ask('applicability-batch', [{ role: 'system', content: parseInstruction + '\n分别判断每个请求，返回 {cases:[{id,proposal:上述格式}]}。不执行任何网页操作。' },
    { role: 'user', content: JSON.stringify(input) }], { type: 'object', properties: { cases: { type: 'array', items: object } }, required: ['cases'], additionalProperties: false });
  for (let i = 0; i < variants.length; i++) {
    const p = proposal.cases.find(c => c.id === 'case-' + i)?.proposal;
    const task = taskFromProposal(p, fixtures[i].envelope, learning.task);
    result.cases.push({ label: 'applicability-' + variants[i], compatible: !task.rejected, expectedCompatible: i === 0,
      correct: (!task.rejected) === (i === 0), reason: p.reason, citationChecksPassed: true, dispatched: false });
  }
} catch (e) { result.cases.push({ label: 'applicability-batch', error: e.message, complete: false }); }
result.endedAt = new Date().toISOString(); result.tokens = calls.reduce((s, c) => s + (c.usage?.total_tokens || 0), 0);
result.sourceHashes = Object.fromEntries(await Promise.all(['probes.mjs', 'runtime.mjs', 'prompts.mjs', 'fixtures.mjs'].map(async f => [f, hash(await readFile(f))])));
await save(root + '/meta.json', result);
console.log(JSON.stringify(result));
