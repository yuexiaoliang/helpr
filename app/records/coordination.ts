import { randomUUID } from 'node:crypto';
import type { TaskExecution } from '../shared/execution';
import type { PageObservation } from '../shared/model';
import { pageSourceSchema } from '../shared/model';
import {
  sameAccount,
  sameSession,
  type CoordinationProposal,
  type SessionContext,
} from '../shared/coordination';

export function unresolved(e: TaskExecution) {
  return e.actions.some((a) =>
    ['reserved', 'dispatched', 'unknown'].includes(a.status),
  );
}
export function invalidateRun(e: TaskExecution) {
  e.runId = null;
  e.version++;
  for (const a of e.actions) {
    if (a.status === 'reserved' && a.dispatchState === 'not-dispatched')
      a.status = 'cancelled';
    else if (a.status === 'reserved' || a.status === 'dispatched')
      a.status = 'unknown';
  }
}
export function releaseUnusedClaims(e: TaskExecution) {
  for (const claim of e.resourceClaims ?? [])
    if (
      !e.actions.some(
        (a) => a.coordination?.claimId === claim.id && a.status !== 'cancelled',
      ) ||
      (e.result?.goalVersion === claim.goalVersion && !unresolved(e))
    )
      claim.status = 'released';
}
export function resourceConflict(
  e: TaskExecution,
  others: { taskId: string; execution: TaskExecution }[],
) {
  const c = e.coordination;
  if (!c) return undefined;
  const target = c.status === 'ready' ? c.target?.url : undefined;
  return others.find(
    ({ execution: other }) =>
      other.resourceClaims?.some(
        (claim) =>
          claim.status === 'held' &&
          claim.origin === c.session.origin &&
          (!target || !claim.targetUrl || claim.targetUrl === target),
      ) ||
      // 老格式动作没有精确目标，结果未明时仍占用整个网站。
      (!other.coordination &&
        other.resource &&
        new URL(other.resource).origin === c.session.origin &&
        (['checking', 'running'].includes(other.phase) || unresolved(other))),
  )?.taskId;
}
export function observeRelation(
  e: TaskExecution,
  session: SessionContext,
  source: PageObservation,
  proposal?: CoordinationProposal,
  authenticated = false,
) {
  const c = e.coordination;
  if (
    !c ||
    !sameSession(c.session, session) ||
    c.session.epoch !== session.epoch ||
    session.origin !== new URL(source.url).origin ||
    source.truncated
  )
    throw Error('COORDINATION_STALE');
  const unique = (link: { name: string; url: string }) =>
    source.links?.filter((l) => l.name === link.name).length === 1 &&
    source.links.some((l) => l.name === link.name && l.url === link.url);
  const proof =
    proposal ??
    (c.account && c.target && c.permissionEvidence
      ? {
          account: c.account,
          target: c.target,
          permissionEvidence: c.permissionEvidence,
        }
      : undefined);
  if (
    proposal &&
    (!unique(proposal.account) ||
      !unique(proposal.target) ||
      new URL(proposal.account.url).origin !== session.origin ||
      proposal.target.url !== source.url ||
      !proposal.permissionEvidence.every((v) => source.text.includes(v)))
  )
    throw Error('COORDINATION_EVIDENCE_MISSING');
  const valid =
    proof &&
    unique(proof.account) &&
    unique(proof.target) &&
    proof.target.url === source.url &&
    proof.permissionEvidence.every((v) => source.text.includes(v));
  if (c.account && (!valid || !sameAccount(c.account, proof.account))) {
    c.status = 'account-changed';
    return false;
  }
  if (
    c.target &&
    valid &&
    c.target.url !== proof.target.url &&
    e.resourceClaims?.some((r) => r.status === 'held')
  )
    throw Error('COORDINATION_TARGET_CHANGED');
  if (authenticated && !valid) throw Error('COORDINATION_EVIDENCE_MISSING');
  if (valid) {
    c.account = proof.account;
    c.target = proof.target;
    c.permissionEvidence = proof.permissionEvidence;
  }
  c.source = pageSourceSchema.strip().parse(source);
  // 无稳定身份时只能领取整个网站；不会凭标签页、文件名或 URL 路径推断独立。
  if (c.status !== 'login' || authenticated) c.status = 'ready';
  return true;
}
export function acquireResource(e: TaskExecution) {
  const c = e.coordination!;
  let claim = e.resourceClaims?.find(
    (r) =>
      r.origin === c.session.origin &&
      r.targetUrl === (c.target?.url ?? null) &&
      r.goalVersion === e.goalVersion,
  );
  if (!claim) {
    claim = {
      status: 'held',
      id: randomUUID(),
      runId: e.runId!,
      goalVersion: e.goalVersion,
      origin: c.session.origin,
      targetUrl: c.target?.url ?? null,
    };
    (e.resourceClaims ??= []).push(claim);
  } else {
    claim.runId = e.runId!;
    claim.status = 'held';
  }
  return { session: c.session, claimId: claim.id };
}

export function validCoordinationReferences(e: TaskExecution) {
  const claims = e.resourceClaims ?? [];
  if (new Set(claims.map((r) => r.id)).size !== claims.length) return false;
  if (
    claims.some(
      (r) =>
        r.goalVersion > e.goalVersion ||
        new URL(r.origin).origin !== r.origin ||
        (r.targetUrl && new URL(r.targetUrl).origin !== r.origin),
    )
  )
    return false;
  return e.actions.every(
    (a) =>
      !a.coordination ||
      claims.some(
        (r) =>
          r.id === a.coordination!.claimId &&
          r.goalVersion === a.goalVersion &&
          r.origin === a.coordination!.session.origin &&
          new URL(a.source.url).origin === r.origin,
      ),
  );
}
