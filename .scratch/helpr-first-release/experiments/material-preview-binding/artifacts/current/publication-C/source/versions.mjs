import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// 一次性通用版本 Module：不识别 Excel 列、网站格式或发布按钮。
export const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
export const hash = v => createHash('sha256').update(Buffer.isBuffer(v) ? v : JSON.stringify(ordered(v))).digest('hex');
export const seal = value => ({ ...structuredClone(value), id: hash(value) });
export function intact(value) { const { id, ...body } = value; check(id === hash(body), 'record-digest-mismatch'); }

export function renderSuggestion(proposal, parsed) {
  check(typeof proposal.title === 'string' && Array.isArray(proposal.blocks) && proposal.blocks.length > 0, 'invalid-suggestion');
  const cells = new Map(parsed.cells.map(c => [c.ref, c]));
  const provenance = [];
  const paragraphs = proposal.blocks.map(block => {
    check(typeof block.template === 'string' && Array.isArray(block.bindings), 'invalid-block');
    const values = new Map();
    for (const b of block.bindings) {
      check(typeof b.key === 'string' && !values.has(b.key) && Array.isArray(b.refs) && b.refs.length, 'invalid-binding');
      const selected = b.refs.map(ref => { check(cells.has(ref), 'unknown-cell-reference'); return cells.get(ref); });
      let actual;
      if (b.operation === 'cell') { check(selected.length === 1, 'cell-needs-one-reference'); actual = selected[0].value; }
      else if (b.operation === 'sum') { check(selected.every(c => c.type === 'number') && new Set(b.refs).size === b.refs.length, 'invalid-sum-input'); actual = selected.reduce((s,c) => s+c.value,0); }
      else throw new Error('unsupported-derivation');
      check(actual !== null, 'blank-is-not-a-value');
      check(actual === b.value, 'fact-value-mismatch');
      check(block.template.includes('{{'+b.key+'}}'), 'unused-binding');
      values.set(b.key, String(actual));
      provenance.push({ ...b, sourceHash: parsed.sourceHash, formulaInputs: selected.filter(c => c.formula).map(c => ({ref:c.ref,formula:c.formula,cachedValue:c.value})) });
    }
    const rendered = block.template.replace(/\{\{([^{}]+)\}\}/g, (_, key) => { check(values.has(key),'missing-binding'); return values.get(key); });
    check(!rendered.includes('{{'), 'unresolved-template');
    return rendered;
  });
  return { title: proposal.title, body: paragraphs.join(' '), provenance };
}

export class PreviewLedger {
  constructor(state = { tasks: {}, requests: {}, authorities: {}, agreements: {}, events: [] }) { this.state = structuredClone(state); }
  event(type, data) { this.state.events.push({ at: new Date().toISOString(), type, ...structuredClone(data) }); }
  select(content) {
    intact(content);
    const task = this.state.tasks[content.task];
    if (task) for (const request of Object.values(this.state.requests)) if (request.task === content.task && request.status === 'pending') request.status = 'invalidated';
    this.state.tasks[content.task] = { task: content.task, execution: content.execution, epoch: content.epoch, content: content.id, active: true };
    this.event('content-selected', { task: content.task, content: content.id, source: content.material.sha256 });
  }
  request(content) {
    this.current(content);
    const r = seal({ task: content.task, execution: content.execution, epoch: content.epoch, content: content.id, sequence: Object.keys(this.state.requests).length+1 });
    this.state.requests[r.id] = { ...r, status: 'pending' };
    this.event('preview-requested', r); return r;
  }
  current(content) {
    intact(content); const t = this.state.tasks[content.task];
    check(t?.active, 'task-not-active');
    check(t.execution === content.execution && t.epoch === content.epoch && t.content === content.id, 'not-current-content');
  }
  reply(reply, content) {
    this.current(content);
    const r = this.state.requests[reply.request];
    check(r?.status === 'pending', 'request-not-pending');
    check(reply.task === r.task && reply.execution === r.execution && reply.epoch === r.epoch && reply.content === r.content && content.id === r.content, 'reply-scope-mismatch');
    check(reply.source === 'experiment-injected', 'experiment-source-required');
    const authority = seal({ kind: 'preview', task: content.task, execution: content.execution, epoch: content.epoch, content: content.id, request: r.id, source: reply.source });
    r.status = 'answered'; this.state.authorities[authority.id] = authority;
    this.event('confirmation-accepted', { reply, authority: authority.id }); return authority;
  }
  agreement(agreement) { intact(agreement); check(agreement.source === 'experiment-injected', 'experiment-source-required'); this.state.agreements[agreement.task] = agreement; this.event('agreement-set',{agreement}); }
  auto(content, agreement) {
    this.current(content); intact(agreement);
    check(this.state.agreements[content.task]?.id === agreement.id && agreement.active, 'agreement-not-current');
    check(content.task === agreement.task && hash(content.target) === hash(agreement.target) && content.rulesHash === agreement.rulesHash && content.material.selectionScope === agreement.selectionScope, 'agreement-scope-mismatch');
    const authority = seal({ kind:'agreement', task:content.task, execution:content.execution, epoch:content.epoch, content:content.id, agreement:agreement.id, source:agreement.source });
    this.state.authorities[authority.id] = authority; this.event('automatic-authorization',{authority}); return authority;
  }
  stop(task) { this.state.tasks[task].active = false; for (const r of Object.values(this.state.requests)) if (r.task === task && r.status === 'pending') r.status = 'invalidated'; this.event('stopped',{task}); }
  async validate(bundle, workflowBytes) {
    intact(bundle); const { content, authority, params } = bundle;
    this.current(content); intact(authority);
    check(hash(this.state.authorities[authority.id]) === hash(authority), 'unknown-authorization');
    check(authority.task === content.task && authority.execution === content.execution && authority.epoch === content.epoch && authority.content === content.id, 'authorization-scope-mismatch');
    if (authority.kind === 'agreement') {
      const agreement = this.state.agreements[content.task];
      check(agreement?.id === authority.agreement && agreement.active, 'agreement-not-current');
    }
    check(params.title === content.title && params.body === content.body && params.origin === content.target.origin && params.category === content.target.category && params.entryUrl === content.target.entryUrl, 'parameter-content-mismatch');
    check(params.filePath === content.material.snapshot && params.fileName === content.material.name && params.fileStem === content.material.name.replace(/\.xlsx$/, ''), 'parameter-material-mismatch');
    check(hash(workflowBytes) === bundle.workflowHash, 'workflow-version-mismatch');
    const bytes = await readFile(params.filePath);
    check(hash(bytes) === content.material.sha256, 'material-bytes-mismatch');
    return bytes;
  }
}

export function bindExecution(content, authority, workflowBytes) {
  return seal({ content, authority, workflowHash: hash(workflowBytes), params: {
    ...content.target, title: content.title, body: content.body,
    filePath: content.material.snapshot, fileName: content.material.name, fileStem: content.material.name.replace(/\.xlsx$/, ''),
  } });
}
