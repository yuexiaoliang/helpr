import { createHash, randomUUID } from 'node:crypto';
import type { TaskExecution } from '../shared/execution';
import type { PublicationCheck } from '../shared/publication';
import {
  workflowBodySchema,
  learnedWorkflowSchema,
  type LearnedWorkflow,
} from '../shared/workflow';
import { samePublication } from '../shared/publication';
import { reboundAction } from '../shared/workflow-replay';
import { validCoordinationReferences } from './coordination';

export const workflowHash = (body: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(workflowBodySchema.strip().parse(body)))
    .digest('hex');

function replayRules(
  e: TaskExecution,
  result: PublicationCheck,
): LearnedWorkflow['replay'] {
  const p = e.publication!,
    a = p.attachment!;
  const actions = e.actions.filter(
    (s) => s.goalVersion === e.goalVersion && s.status !== 'cancelled',
  );
  const uniqueName = (url: string, links: { name: string; url: string }[]) => {
    const matches = links.filter((l) => l.url === url);
    return matches.length === 1 &&
      links.filter((l) => l.name === matches[0]!.name).length === 1
      ? matches[0]!.name
      : undefined;
  };
  const upload = actions.find((s) => s.action.kind === 'upload');
  const last = actions.at(-1);
  const attachmentLink = uniqueName(a.url, upload?.resultLinks ?? []);
  const resultLink =
    uniqueName(result.proposal.url, last?.observedLinks ?? []) ??
    uniqueName(result.proposal.url, last?.resultLinks ?? []);
  // 只归纳已经实际走通且绑定明确的线性路径。旧证据缺字段时不补造。
  if (
    !attachmentLink ||
    !resultLink ||
    p.content === p.destination ||
    actions.filter((s) => s.action.kind === 'upload').length !== 1 ||
    last?.effect !== 'publication' ||
    actions.some(
      (s) =>
        s.source.url !== a.targetUrl ||
        s.action.kind === 'check' ||
        ((s.action.kind === 'fill' || s.action.kind === 'select') &&
          ![p.content, p.destination].includes(s.action.value)) ||
        (s.action.target.frameUrl &&
          new URL(s.action.target.frameUrl).origin !== p.origin),
    )
  )
    return undefined;
  return {
    format: 1,
    target: 'explicit-current-url',
    attachmentLink,
    resultLink,
    publishedEvidence: result.proposal.publishedEvidence,
  };
}

/** 仅从已核对的实际动作形成候选，不接受模型脚本、预置网站步骤或扩大的授权。 */
export function learnWorkflow(
  taskId: string,
  e: TaskExecution,
  result: PublicationCheck,
): LearnedWorkflow {
  const p = e.publication!,
    attachment = p.attachment!;
  const target = e.preparation!.find(
    (f) => f.goalVersion === e.goalVersion && f.kind === 'target',
  )!;
  const upload = e.preparation!.find(
    (f) =>
      f.goalVersion === e.goalVersion &&
      f.kind === 'upload' &&
      f.materialId === attachment.materialId,
  )!;
  const body = workflowBodySchema.parse({
    format: 1,
    version: randomUUID(),
    parentVersion:
      e.workflowUses?.find((u) => u.goalVersion === e.goalVersion)?.workflow
        .version ?? null,
    taskId,
    goalVersion: e.goalVersion,
    goal: e.goal,
    createdAt: result.checkedAt,
    applicability: {
      origin: p.origin,
      entryUrl: e.actions.find((a) => a.goalVersion === e.goalVersion)!.source
        .url,
      mode: 'attachment-publication',
      validated: 'same-inputs-only',
      newInputs: 'requires-validation',
    },
    parameters: [
      {
        name: 'materialId',
        value: attachment.materialId,
        source: 'material-version',
        sourceId: attachment.materialId,
      },
      {
        name: 'content',
        value: p.content,
        source: 'approved-publication',
        sourceId: p.approvalId,
      },
      {
        name: 'destination',
        value: p.destination,
        source: 'approved-publication',
        sourceId: p.approvalId,
      },
      {
        name: 'targetUrl',
        value: target.url,
        source: 'preparation',
        sourceId: target.id,
      },
      {
        name: 'attachmentUrl',
        value: upload.url,
        source: 'preparation',
        sourceId: upload.id,
      },
    ],
    steps: e.actions
      .filter(
        (a) => a.goalVersion === e.goalVersion && a.status !== 'cancelled',
      )
      .map((a) => {
        if (
          a.status !== 'confirmed' ||
          !a.resultSource ||
          !a.preconditions?.length
        )
          throw Error('WORKFLOW_EVIDENCE_MISSING');
        return {
          actionId: a.id,
          runId: a.runId,
          action: a.action,
          effect:
            a.effect ?? (a.action.kind === 'upload' ? 'upload' : 'interaction'),
          bindings:
            a.action.kind === 'upload'
              ? [{ field: 'materialId', parameter: 'materialId' }]
              : (a.action.kind === 'fill' || a.action.kind === 'select') &&
                  [p.content, p.destination].includes(a.action.value)
                ? [
                    {
                      field: 'value',
                      parameter:
                        a.action.value === p.content
                          ? 'content'
                          : 'destination',
                    },
                  ]
                : [],
          before: { source: a.source, evidence: a.preconditions },
          after: { source: a.resultSource, evidence: a.evidence },
          returned: a.returned,
        };
      }),
    resultRule:
      'unique-target-approved-content-destination-and-attachment-sha256',
    recovery: {
      targetUrl: target.url,
      targetFactId: target.id,
      resultUrl: result.proposal.url,
      uncertainDispatch: 'read-only-no-resend',
    },
    evidence: {
      resultId: result.id,
      materialId: attachment.materialId,
      approvalId: p.approvalId,
    },
    authority: 'none',
    ...(replayRules(e, result) ? { replay: replayRules(e, result) } : {}),
  });
  return learnedWorkflowSchema.parse({ ...body, sha256: workflowHash(body) });
}

/** 备份和冷开均验证候选摘要及采用、动作、结果、素材引用。 */
export function validPublicationReferences(
  taskId: string,
  e: TaskExecution,
): boolean {
  if (!validCoordinationReferences(e)) return false;
  const checks = e.publicationChecks ?? [],
    history = e.publicationHistory?.map((h) => h.check) ?? [],
    workflows = e.learnedWorkflows ?? [];
  if (
    new Set(e.workflowUses?.map((u) => u.id)).size !==
      (e.workflowUses?.length ?? 0) ||
    new Set(e.workflowUses?.map((u) => u.goalVersion)).size !==
      (e.workflowUses?.length ?? 0) ||
    e.workflowUses?.some(
      (u) =>
        u.workflow.sha256 !== workflowHash(u.workflow) ||
        !u.workflow.replay ||
        u.source.url !== u.targetUrl ||
        new URL(u.targetUrl).origin !== u.workflow.applicability.origin ||
        !e.materials?.some(
          (m) => m.id === u.materialId && m.goalVersion === u.goalVersion,
        ),
    ) ||
    e.actions.some((a) => {
      if (!a.workflowStep) return false;
      const use = e.workflowUses?.find(
        (u) =>
          u.id === a.workflowStep!.useId && u.goalVersion === a.goalVersion,
      );
      if (!use) return true;
      try {
        return (
          JSON.stringify(a.action) !==
          JSON.stringify(reboundAction(use, a.workflowStep.index))
        );
      } catch {
        return true;
      }
    })
  )
    return false;
  if (
    new Set([...checks, ...history].map((c) => c.id)).size !==
      checks.length + history.length ||
    new Set(workflows.map((w) => w.version)).size !== workflows.length
  )
    return false;
  if (
    [...checks, ...history].some(
      (c) =>
        !e.materials?.some(
          (m) => m.id === c.materialId && m.goalVersion === c.goalVersion,
        ) ||
        !e.actions.some(
          (a) =>
            a.id === c.actionId && a.publicationApprovalId === c.approvalId,
        ),
    )
  )
    return false;
  if (
    e.actions.some((a) => {
      const s = a.submission,
        r = s?.recovery;
      if (!r) return false;
      return (
        !s?.publication.attachment ||
        r.targetUrl !== s.publication.attachment.targetUrl ||
        r.attachmentUrl !== s.publication.attachment.url ||
        r.url === r.targetUrl ||
        r.url === r.attachmentUrl ||
        new URL(r.url).origin !== new URL(r.targetUrl).origin ||
        a.source.url !== r.targetUrl ||
        !a.observedUrls?.includes(r.url) ||
        !e.preparation?.some(
          (f) =>
            f.id === r.targetFactId &&
            f.kind === 'target' &&
            f.url === r.targetUrl &&
            f.goalVersion === a.goalVersion,
        ) ||
        !e.preparation?.some(
          (f) =>
            f.id === r.uploadFactId &&
            f.kind === 'upload' &&
            f.url === r.attachmentUrl &&
            f.goalVersion === a.goalVersion &&
            f.materialId === s.publication.attachment!.materialId,
        ) ||
        (a.goalVersion === e.goalVersion &&
          e.publication?.approvalId === a.publicationApprovalId &&
          !samePublication(e.publication!, s.publication))
      );
    })
  )
    return false;
  if (
    [...checks, ...history].some(
      (c) =>
        c.recovery &&
        !e.actions.some(
          (a) =>
            a.id === c.actionId &&
            a.submission?.recovery?.rule === c.recovery &&
            a.submission?.recovery?.url === c.proposal.url,
        ),
    )
  )
    return false;
  if (
    e.materialProcessing?.some(
      (p) =>
        !e.materials?.some(
          (m) => m.id === p.materialId && m.goalVersion === p.goalVersion,
        ) ||
        !e.actions.some(
          (a) =>
            a.id === p.actionId && a.publicationApprovalId === p.approvalId,
        ) ||
        (p.status === 'complete' &&
          !checks.some(
            (c) =>
              c.id === p.resultId &&
              c.status === 'verified' &&
              c.actionId === p.actionId,
          )),
    )
  )
    return false;
  if (
    workflows.some((w) => {
      const { sha256, ...body } = w;
      return (
        sha256 !== workflowHash(body) ||
        w.taskId !== taskId ||
        !checks.some(
          (c) => c.id === w.evidence.resultId && c.status === 'verified',
        ) ||
        w.steps.some(
          (s) =>
            !e.actions.some(
              (a) =>
                a.id === s.actionId &&
                a.status === 'confirmed' &&
                JSON.stringify(a.action) === JSON.stringify(s.action),
            ),
        )
      );
    })
  )
    return false;
  return (
    !e.workflowAdoption ||
    workflows.some(
      (w) =>
        w.version === e.workflowAdoption!.version &&
        w.sha256 === e.workflowAdoption!.sha256 &&
        w.parentVersion === e.workflowAdoption!.expectedParent,
    )
  );
}
