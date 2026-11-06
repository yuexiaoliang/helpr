import type { TaskExecution, ActionFact } from '../shared/execution';
import type { PageObservation } from '../shared/model';
import type {
  Publication,
  DownloadCheck,
  PublicationCheck,
} from '../shared/publication';
import { samePublication } from '../shared/publication';
import { learnWorkflow } from './workflow';

export function attachmentBinding(e: TaskExecution, p: Publication) {
  const a = p.attachment;
  const materials =
    e.materials?.filter((m) => m.goalVersion === e.goalVersion) ?? [];
  if (
    !a ||
    materials.length !== 1 ||
    materials[0]!.id !== a.materialId ||
    !e.preparation?.some(
      (f) =>
        f.goalVersion === e.goalVersion &&
        f.kind === 'target' &&
        f.url === a.targetUrl,
    ) ||
    !e.preparation.some(
      (f) =>
        f.goalVersion === e.goalVersion &&
        f.kind === 'upload' &&
        f.materialId === a.materialId &&
        f.url === a.url,
    )
  )
    throw Error('PUBLICATION_BINDING_MISMATCH');
  return materials[0]!;
}

export function submissionReady(
  e: TaskExecution,
  p: Publication,
  source: PageObservation,
  download?: DownloadCheck,
) {
  const m = attachmentBinding(e, p),
    a = p.attachment!;
  if (!e.publication?.approvalId || !samePublication(e.publication, p))
    throw Error('PARTICIPATION_REQUIRED');
  if (
    source.url !== a.targetUrl ||
    !source.text.includes(p.content) ||
    !source.text.includes(p.destination) ||
    !source.text.split('\n').includes('[link-url] ' + a.url)
  )
    throw Error('EXECUTION_EVIDENCE_MISSING');
  if (
    !download ||
    download.url !== a.url ||
    download.sha256 !== m.sha256 ||
    download.bytes !== m.bytes ||
    source.observedAt < download.checkedAt ||
    Date.now() - download.checkedAt > 30000
  )
    throw Error('PUBLICATION_BYTES_UNVERIFIED');
  if (
    e.actions.some(
      (a) =>
        a.goalVersion === e.goalVersion &&
        a.effect === 'publication' &&
        a.status !== 'cancelled',
    )
  )
    throw Error('PUBLICATION_ALREADY_DISPATCHED');
}

/** 核实结果、素材处理事实、任务进度与学得候选由调用方在同一短事务提交。 */
export function recordPublicationResult(
  taskId: string,
  e: TaskExecution,
  check: PublicationCheck,
  action: ActionFact,
) {
  const p = e.publication!,
    material = attachmentBinding(e, p);
  if (
    check.actionId !== action.id ||
    action.effect !== 'publication' ||
    !['unknown', 'dispatched', 'confirmed'].includes(action.status) ||
    check.approvalId !== p.approvalId ||
    check.approvalId !== action.publicationApprovalId ||
    check.goalVersion !== e.goalVersion ||
    check.materialId !== material.id ||
    check.proposal.targetUrl !== p.attachment!.targetUrl ||
    check.proposal.attachmentUrl !== p.attachment!.url ||
    check.source.observedAt < action.source.observedAt
  )
    throw Error('PUBLICATION_BINDING_MISMATCH');
  if (
    check.status === 'verified' &&
    (e.observedAnomalies?.some((o) => o.goalVersion === e.goalVersion) ||
      !Object.values(check.checks).every(Boolean) ||
      check.failure !== 'none' ||
      check.anomalies.length ||
      check.extraResults.length ||
      !check.pageSha256 ||
      !check.download ||
      check.download.sha256 !== material.sha256 ||
      check.download.bytes !== material.bytes ||
      check.download.url !== p.attachment!.url ||
      check.download.checkedAt < action.source.observedAt)
  )
    throw Error('EXECUTION_EVIDENCE_MISSING');
  if (
    e.actions.some(
      (a) =>
        a.id !== action.id &&
        ['reserved', 'dispatched', 'unknown'].includes(a.status),
    )
  )
    throw Error('EXECUTION_RESULT_UNKNOWN');
  if ((e.publicationChecks?.length ?? 0) >= 60) throw Error('EXECUTION_LIMIT');
  (e.publicationChecks ??= []).push(check);
  const processing = e.materialProcessing?.find(
    (m) => m.actionId === action.id,
  );
  if (!processing) throw Error('PUBLICATION_BINDING_MISMATCH');
  processing.status = check.status === 'verified' ? 'complete' : 'unknown';
  processing.resultId = check.id;
  if (check.status !== 'verified') return;
  action.status = 'confirmed';
  action.evidence = check.proposal.publishedEvidence;
  action.resultSource = check.source;
  e.result = {
    goalVersion: e.goalVersion,
    source: check.source,
    evidence: [
      `已独立核对公开内容、目标栏目和附件字节：${check.proposal.url}`,
      `SHA-256：${check.download!.sha256}`,
    ],
  };
  // 老执行若缺少步骤前条件，只记录已经成立的业务结果，不伪造学习证据。
  if (
    e.actions
      .filter(
        (a) => a.goalVersion === e.goalVersion && a.status !== 'cancelled',
      )
      .every(
        (a) =>
          a.status === 'confirmed' && a.preconditions?.length && a.resultSource,
      )
  ) {
    const workflow = learnWorkflow(taskId, e, check);
    (e.learnedWorkflows ??= []).push(workflow);
    e.workflowAdoption = {
      version: workflow.version,
      sha256: workflow.sha256,
      expectedParent: workflow.parentVersion,
    };
  }
}
