import { validArticleReferences } from './article';
import { createHash, randomUUID } from 'node:crypto';
import type { TaskExecution } from '../shared/execution';
import type { PublicationCheck } from '../shared/publication';
import {
  workflowBodySchema,
  learnedWorkflowSchema,
  type LearnedWorkflow,
} from '../shared/workflow';
import {
  samePublication,
  publicationFillBinding,
  verifyPublicationFields,
  publicationSchema,
} from '../shared/publication';
import { reboundAction } from '../shared/workflow-replay';
import { sameWorkflowOperation } from '../shared/workflow-repair';
import { workflowCatalog } from '../shared/workflow-catalog';
import { validCoordinationReferences } from './coordination';
import { selectedControl } from '../shared/selection';

export const workflowHash = (body: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(workflowBodySchema.strip().parse(body)))
    .digest('hex');

/** 与结果及候选同事务执行。冲突只保留候选，不覆盖头部或修改执行中的固定版本。 */
export function adoptWorkflow(
  e: TaskExecution,
  others: { execution: TaskExecution }[],
) {
  const w = e.learnedWorkflows?.at(-1);
  if (!w || e.workflowDecisions?.some((d) => d.version === w.version)) return;
  const catalog = workflowCatalog([...others, { execution: e }]);
  const heads = w.parentVersion
    ? catalog.heads
        .filter((h) => catalog.root(h) === catalog.root(w))
        .map((h) => h.version)
    : [];
  const status = !w.replay
    ? 'unusable'
    : !w.parentVersion || (heads.length === 1 && heads[0] === w.parentVersion)
      ? 'adopted'
      : 'conflict';
  // 保留旧格式的历史采用引用，避免同任务修正目标后丢掉旧采用事实。
  const prior = e.workflowAdoption;
  if (prior && !e.workflowDecisions?.some((d) => d.version === prior.version))
    (e.workflowDecisions ??= []).push({
      version: prior.version,
      expectedParent: prior.expectedParent,
      observedHeads: prior.expectedParent ? [prior.expectedParent] : [],
      status: 'adopted',
    });
  (e.workflowDecisions ??= []).push({
    version: w.version,
    expectedParent: w.parentVersion,
    observedHeads: heads,
    status,
  });
  if (status === 'adopted')
    e.workflowAdoption = {
      version: w.version,
      sha256: w.sha256,
      expectedParent: w.parentVersion,
    };
}

/** 冷开和备份同时核对跨任务来源；不能只核对每份 JSON 自身的摘要。 */
export function validWorkflowCatalog(
  entries: { execution?: TaskExecution | null }[],
) {
  try {
    const catalog = workflowCatalog(entries);
    const versions = new Map(catalog.candidates.map((w) => [w.version, w]));
    if (versions.size !== catalog.candidates.length) return false;
    const adoptedParents = new Set<string>();
    for (const { execution: e } of entries) {
      if (!e) continue;
      for (const use of e.workflowUses ?? []) {
        const source = versions.get(use.workflow.version);
        if (!source || JSON.stringify(source) !== JSON.stringify(use.workflow))
          return false;
      }
      for (const w of e.learnedWorkflows ?? []) {
        if (
          w.parentVersion !==
          (e.workflowUses?.find((u) => u.goalVersion === w.goalVersion)
            ?.workflow.version ?? null)
        )
          return false;
        catalog.root(w);
      }
      for (const d of e.workflowDecisions ?? []) {
        const w = versions.get(d.version);
        if (
          !w ||
          d.observedHeads.some(
            (v) =>
              !versions.has(v) ||
              catalog.root(versions.get(v)!) !== catalog.root(w),
          )
        )
          return false;
        if (d.status === 'adopted' && d.expectedParent) {
          if (adoptedParents.has(d.expectedParent)) return false;
          adoptedParents.add(d.expectedParent);
        }
      }
      if (
        e.workflowAdoption &&
        e.workflowDecisions?.some(
          (d) =>
            d.version === e.workflowAdoption!.version && d.status !== 'adopted',
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
        (s.action.kind === 'select' && !s.selectionResult) ||
        ((s.action.kind === 'fill' || s.action.kind === 'select') &&
          !publicationFillBinding(p, s.action)) ||
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
    ...(p.fields ? { fields: p.fields } : {}),
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
              : publicationFillBinding(p, a.action)
                ? [publicationFillBinding(p, a.action)]
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
  if (e.historyCleanup && !e.materials?.length) return false;
  if (
    (e.historyCleanup ||
      e.materials?.some((m) => m.discardedAt !== undefined)) &&
    (!e.historyCleanup ||
      !e.materials ||
      e.materials.some((m) => m.discardedAt !== e.historyCleanup!.at) ||
      e.phase !== 'complete' ||
      e.runId ||
      e.question ||
      e.schedule ||
      e.scheduleOrigin ||
      e.agreements?.length ||
      e.agreementBinding ||
      e.actions.some((a) => !['confirmed', 'cancelled'].includes(a.status)) ||
      e.resourceClaims?.some((r) => r.status !== 'released') ||
      e.materialProcessing?.some((m) => m.status !== 'complete') ||
      e.materialWorks?.some((m) => m.status !== 'complete'))
  )
    return false;
  if (!validCoordinationReferences(e) || !validArticleReferences(e))
    return false;
  for (const a of e.actions) {
    if (a.submission?.publication.fields) {
      try {
        verifyPublicationFields(a.submission.publication, {
          ...a.source,
          text: '',
          controls: a.fieldResults,
        });
      } catch {
        return false;
      }
    } else if (a.fieldResults) return false;
    if (!a.selectionResult) continue;
    if (
      a.action.kind !== 'select' ||
      a.status !== 'confirmed' ||
      !a.resultSource ||
      a.source.url !== a.resultSource.url
    )
      return false;
    try {
      selectedControl(a.action, {
        ...a.resultSource,
        text: '',
        controls: [a.selectionResult],
      });
    } catch {
      return false;
    }
  }
  const checks = e.publicationChecks ?? [],
    history = e.publicationHistory?.map((h) => h.check) ?? [],
    workflows = e.learnedWorkflows ?? [];
  for (const use of e.workflowUses ?? []) {
    const shape = (fields: typeof use.fields, url: string) =>
      fields?.map(({ id, name, frameUrl }) => ({
        id,
        name,
        frameUrl: frameUrl ?? url,
      }));
    const expected = use.workflow.fields?.map((f) => ({
      ...f,
      ...(f.frameUrl === use.workflow.recovery.targetUrl
        ? { frameUrl: use.targetUrl }
        : {}),
    }));
    if (
      !publicationSchema.safeParse({
        content: use.content,
        destination: use.destination,
        fields: use.fields,
      }).success ||
      JSON.stringify(shape(use.fields, use.targetUrl)) !==
        JSON.stringify(shape(expected, use.targetUrl)) ||
      (use.approved &&
        (!publicationSchema.safeParse({
          content: use.approved.content,
          destination: use.destination,
          fields: use.approved.fields,
        }).success ||
          JSON.stringify(shape(use.approved.fields, use.targetUrl)) !==
            JSON.stringify(shape(use.fields, use.targetUrl))))
    )
      return false;
  }
  for (const workflow of workflows) {
    if (
      !publicationSchema.safeParse({
        content: workflow.parameters.find((p) => p.name === 'content')?.value,
        destination: workflow.parameters.find((p) => p.name === 'destination')
          ?.value,
        fields: workflow.fields,
      }).success
    )
      return false;
  }
  if (
    new Set(e.workflowRepairs?.map((r) => r.id)).size !==
      (e.workflowRepairs?.length ?? 0) ||
    new Set(e.workflowRepairs?.map((r) => r.useId)).size !==
      (e.workflowRepairs?.length ?? 0) ||
    e.workflowRepairs?.some(
      (r) =>
        !e.workflowUses?.some(
          (u) =>
            u.id === r.useId &&
            u.goalVersion === r.goalVersion &&
            u.targetUrl === r.source.url &&
            r.fromIndex <= u.workflow.steps.length,
        ),
    ) ||
    new Set(e.workflowDecisions?.map((d) => d.version)).size !==
      (e.workflowDecisions?.length ?? 0) ||
    e.workflowDecisions?.some(
      (d) =>
        !workflows.some(
          (w) =>
            w.version === d.version &&
            w.parentVersion === d.expectedParent &&
            (d.status !== 'adopted' ||
              !w.parentVersion ||
              (d.observedHeads.length === 1 &&
                d.observedHeads[0] === w.parentVersion)),
        ),
    )
  )
    return false;
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
        if (a.workflowStep.repairId)
          return (
            !e.workflowRepairs?.some(
              (r) =>
                r.id === a.workflowStep!.repairId &&
                r.useId === use.id &&
                a.workflowStep!.index >= r.fromIndex,
            ) ||
            !sameWorkflowOperation(
              use,
              a.workflowStep.index,
              a.action,
              a.effect,
            )
          );
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
        r = a.discoveredRecovery?.recovery ?? s?.recovery;
      if (!r) return false;
      return (
        !s?.publication.attachment ||
        r.targetUrl !== s.publication.attachment.targetUrl ||
        r.attachmentUrl !== s.publication.attachment.url ||
        r.url === r.targetUrl ||
        r.url === r.attachmentUrl ||
        new URL(r.url).origin !== new URL(r.targetUrl).origin ||
        a.source.url !== r.targetUrl ||
        (!a.discoveredRecovery && !a.observedUrls?.includes(r.url)) ||
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
            (a.discoveredRecovery?.recovery ?? a.submission?.recovery)?.rule ===
              c.recovery &&
            (a.discoveredRecovery?.recovery ?? a.submission?.recovery)?.url ===
              c.proposal.url,
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
          !(p.workId ? [...checks, ...history] : checks).some(
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
