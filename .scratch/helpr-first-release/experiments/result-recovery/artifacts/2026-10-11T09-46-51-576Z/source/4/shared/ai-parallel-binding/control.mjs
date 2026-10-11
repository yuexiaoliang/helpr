import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function atomicJSON(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    const parent = await open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const natural = n => Number.isSafeInteger(n) && n >= 0;
function validateState(state) {
  if (state?.schema !== 1 || typeof state.id !== 'string' || !state.id ||
      !['calls', 'tokens', 'revisions'].every(key => natural(state.limits?.[key])) ||
      !Number.isFinite(state.deadline) || !natural(state.attempts) || !natural(state.priorRevisions || 0) ||
      !Array.isArray(state.requests) || !Array.isArray(state.versions) || !Array.isArray(state.results)) throw new Error('invalid-study-state');
  for (const [index, r] of state.requests.entries()) {
    if (r.id !== index + 1 || typeof r.label !== 'string' || !natural(r.tokens) ||
        !['reserved', 'settled', 'unknown'].includes(r.status) ||
        (r.usage?.total_tokens !== undefined && !natural(r.usage.total_tokens))) throw new Error('invalid-request-record');
  }
  for (const r of state.results) {
    if (!r.id || !r.key || !r.fingerprint || !['passed', 'failed'].includes(r.status) || !r.capture?.status) throw new Error('invalid-result-record');
  }
  for (const version of state.versions) if (!version.execution || !version.revision) throw new Error('invalid-version-record');
  return state;
}
async function readState(file) {
  let marker;
  try { marker = await read(file + '.registered'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let state;
  try { state = validateState(await read(file)); }
  catch (error) { if (error.code === 'ENOENT' && marker) throw new Error('study-record-missing'); throw error; }
  if (!marker || marker.id !== state.id) throw new Error('study-registration-missing');
  return state;
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid-lock-owner');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function acquireLock(file) {
  // 创建和回收都经过同一把短锁，避免两个恢复者删除彼此的新锁。
  const gate = file + '.acquiring', token = randomUUID();
  async function exclusive(change, retry = false) {
    const end = Date.now() + (retry ? 1000 : 0);
    while (true) {
      try { await mkdir(gate); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= end) throw new Error('study-locked: acquisition-in-progress');
        await delay(10);
      }
    }
    try { return await change(); } finally { await rm(gate, { recursive: true }); }
  }
  await exclusive(async () => {
    let owner;
    try { owner = await read(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (owner && isAlive(owner.pid)) throw new Error('study-locked');
    await atomicJSON(file, { pid: process.pid, token });
  });
  return () => exclusive(async () => {
    if ((await read(file)).token !== token) throw new Error('study-lock-lost');
    await rm(file);
  }, true);
}
function budget(state) {
  const knownTokens = state.requests.reduce((sum, r) => sum + (r.usage?.total_tokens ?? 0), 0);
  const heldTokens = state.requests.reduce((sum, r) => sum + (r.usage?.total_tokens === undefined ? r.tokens : 0), 0);
  return { calls: state.requests.length, callsRemaining: Math.max(0, state.limits.calls - state.requests.length),
    knownTokens, heldTokens, tokensRemaining: Math.max(0, state.limits.tokens - knownTokens - heldTokens),
    timeRemainingMs: Math.max(0, state.deadline - Date.now()),
    revisionsRemaining: Math.max(0, state.limits.revisions - (state.priorRevisions || 0) - Math.max(0, state.versions.length - 1)) };
}
function initialState(registration) {
  if (!registration) throw new Error('study-registration-required');
  return validateState({ schema: 1, ...structuredClone(registration), requests: structuredClone(registration.requests || []), versions: [], results: [], attempts: 0 });
}
export async function readStatus(ledgerPath, registration) {
  let state;
  try { state = await readState(ledgerPath); }
  catch (error) { if (error.code !== 'ENOENT' || !registration) throw error; state = initialState(registration); }
  if (registration && state.id !== registration.id) throw new Error('study-identity-mismatch');
  const ownerAlive = state.current && state.current.phase !== 'closed' ? isAlive(state.current.pid) : false;
  return { id: state.id, readAt: new Date().toISOString(), budget: budget(state), current: state.current,
    ownerAlive, results: state.results,
    inFlight: ownerAlive ? state.requests.filter(r => r.status === 'reserved') : [],
    unknownUsage: state.requests.filter(r => r.usage?.total_tokens === undefined && (!ownerAlive || r.status !== 'reserved')) };
}
export async function openRun({ ledgerPath, registration, output, fingerprint }) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const releaseLock = await acquireLock(ledgerPath + '.lock');
  let state;
  try {
    try { state = await readState(ledgerPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = initialState(registration);
      await atomicJSON(ledgerPath + '.registered', { id: state.id, at: new Date().toISOString() });
      await atomicJSON(ledgerPath, state);
    }
    if (state.id !== registration.id) throw new Error('study-identity-mismatch');
    if (!fingerprint?.execution || !fingerprint?.revision) throw new Error('missing-fingerprint');
    if (state.versions.at(-1)?.revision !== fingerprint.revision) {
      if (state.versions.length && state.versions.length + (state.priorRevisions || 0) > state.limits.revisions) throw new Error('revision-budget');
      state.versions.push({ ...fingerprint, at: new Date().toISOString() });
    }
    for (const request of state.requests) if (request.status === 'reserved') request.status = 'unknown';
    for (const result of state.results) if (result.capture.status === 'pending') {
      result.capture = { status: 'unavailable', error: 'capture-interrupted: original-page-lost' };
    }
    state.attempts++;
    state.current = { attempt: state.attempts, output, pid: process.pid, phase: 'ready', case: null, updatedAt: new Date().toISOString() };
    await atomicJSON(ledgerPath, state);
  } catch (error) {
    await releaseLock(); throw error;
  }
  let queue = Promise.resolve(), closed = false, poisoned = false;
  const update = change => {
    const operation = queue.then(async () => {
      if (closed || poisoned) throw new Error('study-unavailable');
      const next = structuredClone(state), result = change(next);
      next.current.updatedAt = new Date().toISOString();
      try { await atomicJSON(ledgerPath, next); }
      catch (error) { poisoned = true; throw error; }
      state = next; return result;
    });
    queue = operation.catch(() => {}); return operation;
  };
  const phase = (name, key) => update(next => { next.current.phase = name; next.current.case = key; });
  const retained = new Map();
  async function collectEvidence(key) {
    const source = retained.get(key);
    if (!source || closed) throw new Error('capture-source-unavailable');
    await phase('capture', key);
    let capture;
    try { capture = { status: 'passed', evidence: await source.capture(source.evidence) }; }
    catch (error) { capture = { status: 'failed', error: error.message, evidence: error.evidence }; }
    await update(next => { next.results.find(r => r.id === source.id).capture = capture; });
    await phase('ready', null);
    return capture;
  }
  return {
    collectEvidence,
    checkDispatch(id) {
      if (closed || poisoned || state.requests.find(r => r.id === id)?.status !== 'reserved') throw new Error('request-not-reserved');
      if (Date.now() >= state.deadline) throw new Error('time-budget');
    },
    async runCase({ key, execute, capture, cleanup }) {
      const previous = state.results.findLast(r => r.key === key && r.fingerprint === fingerprint.execution && r.status === 'passed');
      if (previous) return { ...structuredClone(previous), skipped: true };
      retained.clear();
      await phase('execute', key);
      const row = { id: randomUUID(), key, fingerprint: fingerprint.execution, output,
        startedAt: new Date().toISOString(), capture: { status: 'pending' } };
      try { row.evidence = await execute(); row.status = 'passed'; }
      catch (error) { row.status = 'failed'; row.error = error.message; }
      row.finishedAt = new Date().toISOString();
      await update(next => { next.results.push(structuredClone(row)); });
      if (row.status === 'passed' && capture) {
        retained.set(key, { id: row.id, capture, evidence: row.evidence });
        row.capture = await collectEvidence(key);
      } else row.capture = { status: 'not-requested' };
      await update(next => { Object.assign(next.results.find(r => r.id === row.id), { capture: row.capture }); });
      await phase('cleanup', key);
      try { await cleanup?.(); row.cleanup = { status: 'passed' }; }
      catch (error) { row.cleanup = { status: 'failed', error: error.message }; }
      await update(next => { Object.assign(next.results.find(r => r.id === row.id), { cleanup: row.cleanup }); });
      await phase('ready', null);
      return row;
    },
    reserveRequest({ label, tokens }) { return update(next => {
      if (!natural(tokens) || typeof label !== 'string') throw new Error('invalid-request-reservation');
      if (Date.now() >= next.deadline) throw new Error('time-budget');
      const remaining = budget(next);
      if (!remaining.callsRemaining) throw new Error('call-budget');
      if (tokens > remaining.tokensRemaining) throw new Error('token-budget');
      const id = next.requests.length + 1;
      next.requests.push({ id, label, tokens, output, status: 'reserved', startedAt: new Date().toISOString() });
      return id;
    }); },
    settleRequest(id, record) { return update(next => {
      const row = next.requests.find(r => r.id === id);
      if (!row || row.status !== 'reserved') throw new Error('invalid-request-settlement');
      Object.assign(row, { usage: natural(record.usage?.total_tokens) ? { total_tokens: record.usage.total_tokens } : undefined,
        error: record.error, status: 'settled', endedAt: new Date().toISOString() });
    }); },
    async close() {
      await queue; if (closed) return;
      try { if (!poisoned) await phase('closed', null); }
      finally { closed = true; await releaseLock(); }
    },
  };
}
