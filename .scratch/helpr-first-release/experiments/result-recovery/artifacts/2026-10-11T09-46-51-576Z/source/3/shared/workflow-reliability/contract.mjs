// 一次性候选约定实验；不包含网站名称、网页字段名或业务步骤。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export class Fault extends Error {
  constructor(code, detail = {}, status = 'blocked') { super(code); this.code = code; this.detail = detail; this.status = status; }
}
const fail = (condition, code, detail) => { if (!condition) throw new Fault(code, detail); };
const ops = new Set(['hover', 'click', 'fill', 'check', 'select', 'press', 'upload', 'wait', 'finish']);
const kinds = new Set(['visible', 'absent', 'text', 'value', 'checked', 'attribute', 'download']);
const effects = new Set(['read', 'edit', 'upload', 'commit']);

// 显式引用才绑定；字符串始终是字面量，禁止按样本值全局替换。
export function bind(value, inputs) {
  if (Array.isArray(value)) return value.map(v => bind(v, inputs));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'input')) {
      fail(Object.keys(value).every(k => ['input', 'field'].includes(k)), 'invalid-input-expression');
      const source = inputs[value.input];
      fail(!!source, 'missing-input', { input: value.input });
      if (value.field) {
        fail(source.type === 'file' && ['path', 'name', 'stem', 'sha256'].includes(value.field), 'invalid-file-field');
        return source[value.field];
      }
      fail(source.type === 'string', 'file-needs-explicit-field');
      return source.value;
    }
    if (Object.hasOwn(value, 'concat')) {
      fail(Object.keys(value).length === 1 && Array.isArray(value.concat), 'invalid-concat');
      return value.concat.map(v => { const text = bind(v, inputs); fail(typeof text === 'string', 'concat-needs-string'); return text; }).join('');
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, inputs)]));
  }
  return value;
}

export function validateWorkflow(flow, task) {
  fail(flow.schema === 1 && Array.isArray(flow.steps) && flow.steps.length > 0 && flow.steps.length <= 60, 'invalid-workflow');
  fail(flow.compatibility?.origin === task.origin && flow.compatibility?.kind === task.kind, 'not-applicable');
  fail(task.authorization?.origin === task.origin && task.authorization?.kind === task.kind && task.authorization?.inputsDigest === hash(task.inputs), 'authorization-mismatch');
  fail(new URL(task.entryUrl).origin === task.origin, 'entry-origin-mismatch');
  fail(Object.keys(flow.inputs || {}).length === Object.keys(task.inputs).length, 'input-schema-mismatch');
  for (const [key, type] of Object.entries(flow.inputs)) {
    fail(['string', 'file'].includes(type) && task.inputs[key]?.type === type, 'input-type-mismatch', { key });
    if (type === 'string') fail(typeof task.inputs[key].value === 'string' && task.inputs[key].value.length > 0, 'empty-input', { key });
    else fail(typeof task.inputs[key].path === 'string' && /^[a-f0-9]{64}$/.test(task.inputs[key].sha256 || ''), 'invalid-material', { key });
  }
  const ids = new Set();
  const validateCondition = c => {
    fail(kinds.has(c.kind) && !!c.target, 'invalid-condition');
    if (['text', 'value', 'attribute'].includes(c.kind)) fail(['equals', 'contains', 'startsWith', 'originEquals'].includes(c.compare), 'invalid-comparison');
    if (c.kind === 'attribute') fail(['href', 'aria-label', 'role', 'type', 'title', 'data-type'].includes(c.attribute), 'invalid-observed-attribute');
  };
  for (const step of flow.steps) {
    fail(typeof step.id === 'string' && !ids.has(step.id), 'invalid-step-id'); ids.add(step.id);
    fail(ops.has(step.action?.op) && !!step.action?.target && effects.has(step.effect), 'invalid-step');
    fail(Array.isArray(step.before) && Array.isArray(step.after), 'missing-step-conditions');
    if (['fill', 'check', 'select', 'upload'].includes(step.action.op)) fail(step.after.length > 0, 'missing-write-postcondition', { step: step.id });
    [...step.before, ...step.after].forEach(validateCondition);
    const action = bind(step.action, task.inputs);
    if (['fill', 'select', 'press', 'upload'].includes(action.op)) fail(typeof action.value === 'string', 'invalid-action-value');
    if (action.op === 'check') fail(typeof action.value === 'boolean', 'invalid-action-value');
    fail(action.op !== 'upload' || step.effect === 'upload', 'upload-effect-mismatch');
  }
  fail(flow.steps.at(-1).action.op === 'finish', 'missing-result-step');
  fail(Array.isArray(flow.entryChecks) && flow.entryChecks.length > 0 && Array.isArray(flow.commitChecks) && flow.commitChecks.length > 0, 'missing-state-checks');
  fail(Array.isArray(flow.resultChecks) && flow.resultChecks.length > 0, 'missing-result-checks');
  [...flow.entryChecks, ...flow.commitChecks, ...flow.resultChecks].forEach(validateCondition);
  // 每项委托的目标输入都须有对应结果检查；不会证明选中的网页字段含义正确。
  for (const key of task.requiredOutputs) {
    fail(flow.resultChecks.some(c => c.expected?.input === key &&
      (task.inputs[key].type === 'file' ? c.kind === 'download' && c.expected.field === 'sha256' : ['text', 'value'].includes(c.kind))), 'uncovered-output', { key });
  }
  bind(flow, task.inputs); // 一次性检查所有引用，避免开始写入后才发现参数缺失。
  return flow;
}

export async function validateMaterials(task) {
  for (const [key, input] of Object.entries(task.inputs)) {
    if (input.type === 'file') fail(hash(await readFile(input.path)) === input.sha256, 'material-changed', { key });
  }
}

// 修复仅允许改变一个动作的定位信息。目标、输入、效果分类、检查规则保持原版本。
export function applyRepair(flow, patch) {
  fail(patch && Object.keys(patch).every(k => ['stepId', 'target', 'reason'].includes(k)), 'repair-outside-allowed-fields');
  const candidate = structuredClone(flow), step = candidate.steps.find(s => s.id === patch.stepId);
  fail(!!step && !!patch.target && ['fill', 'check', 'select', 'hover', 'wait', 'click'].includes(step.action.op), 'repair-not-supported');
  fail(step.effect !== 'commit', 'commit-repair-needs-new-evidence');
  step.action.target = patch.target;
  return candidate;
}
