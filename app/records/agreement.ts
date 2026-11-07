import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TaskExecution } from '../shared/execution';
import type { MaterialVersion } from '../shared/material';
import type { AgreementVersion, MaterialWork } from '../shared/agreement';
import { agreementGoal } from '../shared/agreement';
import { websiteURL } from '../shared/url-policy';
import { validateHistoricalCheck } from './publication';

type Row = { taskId: string; execution: TaskExecution | null | undefined };
export function agreementVersions(rows: Row[]) {
  return rows.flatMap((r) =>
    (r.execution?.agreements ?? []).map((agreement) => ({
      taskId: r.taskId,
      agreement,
    })),
  );
}
export function boundAgreement(e: TaskExecution, rows: Row[]) {
  const b = e.agreementBinding;
  return (
    b &&
    agreementVersions(rows).find(
      (v) =>
        v.taskId === b.ownerTaskId &&
        v.agreement.id === b.agreementId &&
        v.agreement.versionId === b.versionId,
    )?.agreement
  );
}
export function activeAgreement(a: AgreementVersion | undefined) {
  return !!a && a.acceptedAt !== null && a.revokedAt === null;
}
export function validateAgreementTerms(a: AgreementVersion['terms']) {
  if (
    !path.isAbsolute(a.selection.scope) ||
    path.normalize(a.selection.scope) !== a.selection.scope ||
    (a.selection.name &&
      path.basename(a.selection.name) !== a.selection.name) ||
    (a.selection.rule === 'date' &&
      (!a.selection.dateName?.includes('{date}') ||
        path.basename(a.selection.dateName) !== a.selection.dateName ||
        !!a.selection.name)) ||
    websiteURL(a.entryUrl) !== a.entryUrl
  )
    throw Error('AGREEMENT_SCOPE_INVALID');
}
function inScope(a: AgreementVersion, m: MaterialVersion) {
  const s = a.terms.selection;
  return (
    m.selection.scope === s.scope &&
    m.selection.rule === s.rule &&
    m.selection.name === s.name &&
    m.selection.extension === s.extension &&
    m.selection.dateName === s.dateName &&
    (m.source === s.scope || path.dirname(m.source) === s.scope) &&
    (!s.name || m.name === s.name) &&
    (!s.extension ||
      path.extname(m.name).toLowerCase() === s.extension.toLowerCase())
  );
}
export function workKey(
  a: AgreementVersion,
  w: Pick<MaterialWork, 'sha256' | 'binding'>,
) {
  // 路径和选择顺序不是工作的业务含义；改变范围仍须接受新版本。
  return createHash('sha256')
    .update(
      JSON.stringify([
        a.id,
        a.terms.entryUrl,
        a.terms.destination,
        a.terms.contentRules,
        a.terms.changedBytes,
        a.terms.period,
        w.sha256,
        w.binding.periodKey,
        w.binding.repeatIntent,
      ]),
    )
    .digest('hex');
}
export function agreementApplies(e: TaskExecution, rows: Row[]) {
  const a = boundAgreement(e, rows),
    b = e.agreementBinding;
  const m = e.materials?.find((v) => v.goalVersion === e.goalVersion);
  return !!(
    a &&
    activeAgreement(a) &&
    b &&
    b.goalVersion === e.goalVersion &&
    e.goal === agreementGoal(a.terms, b.periodKey) &&
    m &&
    inScope(a, m)
  );
}
export function canAutoApprove(e: TaskExecution, rows: Row[]) {
  const a = boundAgreement(e, rows),
    p = e.publication;
  const w = e.materialWorks?.find(
    (w) => w.binding.goalVersion === e.goalVersion,
  );
  const article = e.articles?.findLast((v) => v.goalVersion === e.goalVersion);
  return !!(
    a &&
    p &&
    w &&
    !w.requiresReview &&
    w.status === 'pending' &&
    agreementApplies(e, rows) &&
    !e.answers?.some((v) => v.goalVersion === e.goalVersion) &&
    p.origin === new URL(a.terms.entryUrl).origin &&
    p.destination === a.terms.destination &&
    article?.author === 'model' &&
    p.articleId === article.id &&
    p.content === article.content &&
    p.attachment?.materialId === w.materialId &&
    !rows.some((r) =>
      r.execution?.actions.some(
        (action) =>
          action.dispatchState === 'possible' &&
          action.status !== 'cancelled' &&
          action.submission?.publication.attachment?.targetUrl ===
            p.attachment?.targetUrl &&
          action.publicationApprovalId !== p.approvalId,
      ),
    )
  );
}
export function assertAgreementAuthority(e: TaskExecution, rows: Row[]) {
  if (!e.publication?.agreementVersionId) return;
  if (
    !canAutoApprove(e, rows) ||
    e.publication.agreementVersionId !== e.agreementBinding?.versionId
  )
    throw Error('AGREEMENT_EXPIRED');
}
export function syncMaterialWorks(e: TaskExecution) {
  for (const w of e.materialWorks ?? []) {
    const p = e.materialProcessing?.find((p) => p.workId === w.id);
    if (!p) continue;
    if (
      p.status === 'pending' &&
      e.actions.some(
        (a) => a.id === p.actionId && a.dispatchState === 'possible',
      )
    )
      p.status = 'unknown';
    w.actionId = p.actionId;
    w.resultId = p.resultId;
    w.status = p.status;
  }
}
export function validAgreementCatalog(rows: Row[]) {
  try {
    const all = agreementVersions(rows);
    const works = rows.flatMap((r) =>
      (r.execution?.materialWorks ?? []).map((w) => ({ ...r, work: w })),
    );
    if (
      new Set(all.map((v) => v.agreement.versionId)).size !== all.length ||
      new Set(works.map((v) => v.work.id)).size !== works.length ||
      new Set(works.map((v) => v.work.key)).size !== works.length
    )
      return false;
    for (const { taskId, agreement: a } of all) {
      validateAgreementTerms(a.terms);
      const siblings = all.filter((v) => v.agreement.id === a.id);
      if (
        siblings.some((v) => v.taskId !== taskId) ||
        siblings.filter((v) => activeAgreement(v.agreement)).length > 1 ||
        siblings.filter((v) => v.agreement.version === a.version).length !==
          1 ||
        (a.version > 1 &&
          !siblings.some((v) => v.agreement.version === a.version - 1)) ||
        (a.acceptedAt !== null && a.acceptedAt < a.createdAt) ||
        (a.revokedAt === null) !== (a.revocation === null)
      )
        return false;
    }
    for (const row of rows) {
      const e = row.execution;
      if (!e) continue;
      if (e.agreementBinding && boundAgreement(e, rows)?.acceptedAt == null)
        return false;
      for (const w of e.materialWorks ?? []) {
        const a = boundAgreement({ ...e, agreementBinding: w.binding }, rows);
        const m = e.materials?.find((m) => m.id === w.materialId);
        if (
          !a ||
          a.acceptedAt === null ||
          !m ||
          m.sha256 !== w.sha256 ||
          m.goalVersion !== w.binding.goalVersion ||
          w.key !== workKey(a, w) ||
          !inScope(a, m)
        )
          return false;
        if (
          (a.terms.period === 'per-period') !== !!w.binding.periodKey.trim() ||
          !!w.binding.repeatOf !== !!w.binding.repeatIntent
        )
          return false;
        const p = e.materialProcessing?.find((p) => p.workId === w.id);
        if (
          p &&
          (p.actionId !== w.actionId ||
            p.resultId !== w.resultId ||
            p.status !== w.status)
        )
          return false;
        if (
          !p &&
          (w.actionId !== null || w.resultId !== null || w.status !== 'pending')
        )
          return false;
        if (w.status === 'complete') {
          const check = [
            ...(e.publicationChecks ?? []),
            ...(e.publicationHistory ?? []).map((h) => h.check),
          ].find((c) => c.id === w.resultId);
          const action = e.actions.find((a) => a.id === w.actionId);
          if (!check || check.status !== 'verified' || !action) return false;
          validateHistoricalCheck(e, check, action);
        }
        if (
          w.binding.repeatOf &&
          !works.some(
            (v) =>
              v.work.id === w.binding.repeatOf &&
              v.work.status === 'complete' &&
              v.work.binding.agreementId === w.binding.agreementId &&
              v.work.sha256 === w.sha256,
          )
        )
          return false;
      }
      if (
        e.materialProcessing?.some(
          (p) => p.workId && !e.materialWorks?.some((w) => w.id === p.workId),
        )
      )
        return false;
      if (
        e.duplicateWork &&
        !works.some(
          (v) =>
            v.taskId === e.duplicateWork!.taskId &&
            v.work.id === e.duplicateWork!.workId,
        )
      )
        return false;
      if (e.duplicateWork) {
        const a = boundAgreement(e, rows),
          material = e.materials?.find(
            (m) => m.goalVersion === e.duplicateWork!.goalVersion,
          );
        const original = works.find(
          (v) => v.work.id === e.duplicateWork!.workId,
        )?.work;
        if (
          !a ||
          !material ||
          !e.agreementBinding ||
          original?.key !==
            workKey(a, { binding: e.agreementBinding, sha256: material.sha256 })
        )
          return false;
      }
      const p = e.publication;
      if (
        p?.agreementVersionId &&
        !e.materialWorks?.some(
          (w) =>
            w.id === p.workId &&
            w.binding.versionId === p.agreementVersionId &&
            w.materialId === p.attachment?.materialId,
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
