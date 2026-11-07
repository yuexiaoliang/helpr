import type { TaskExecution, NextStep, WebAction } from './execution';
import type { PageObservation } from './model';
import { type WorkflowUse } from './workflow';

export function currentWorkflow(e: TaskExecution) {
  return e.workflowUses?.find((u) => u.goalVersion === e.goalVersion);
}

export function reboundAction(use: WorkflowUse, index: number): WebAction {
  const step = use.workflow.steps[index];
  if (!step) throw Error('WORKFLOW_NOT_APPLICABLE');
  const action = structuredClone(step.action);
  if (action.target.frameUrl === use.workflow.recovery.targetUrl)
    action.target.frameUrl = use.targetUrl;
  for (const binding of step.bindings) {
    if (
      binding.field === 'materialId' &&
      binding.parameter === 'materialId' &&
      action.kind === 'upload'
    )
      action.materialId = use.materialId;
    else if (
      binding.field === 'value' &&
      (action.kind === 'fill' || action.kind === 'select') &&
      (binding.parameter === 'content' || binding.parameter === 'destination')
    ) {
      action.value = binding.fieldId
        ? (() => {
            const field = (use.approved?.fields ?? use.fields)?.find(
              (f) => f.id === binding.fieldId,
            );
            if (
              !field ||
              binding.parameter !== 'content' ||
              action.kind !== 'fill'
            )
              throw Error('WORKFLOW_NOT_APPLICABLE');
            action.target = {
              role: 'textbox',
              name: field.name,
              exact: true,
              ...(field.frameUrl ? { frameUrl: field.frameUrl } : {}),
            };
            return field.value;
          })()
        : binding.parameter === 'content'
          ? (use.approved?.content ?? use.content)
          : use.destination;
    } else throw Error('WORKFLOW_NOT_APPLICABLE');
  }
  if (
    (action.kind === 'fill' ||
      action.kind === 'select' ||
      action.kind === 'upload') &&
    step.bindings.length !== 1
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
  return action;
}

export function observedControl(action: WebAction, source: PageObservation) {
  if (action.kind === 'upload')
    return source.text.includes(
      `[file ${action.target.fileIndex}] ${action.target.frameUrl ?? source.url}`,
    );
  if (!source.controls) return false;
  const target = action.target;
  const matches = source.controls.filter(
    (c) =>
      c.role === target.role &&
      c.name === target.name &&
      c.frameUrl === (target.frameUrl ?? source.url),
  );
  // 层级关系尚未进入观察协议，同名控件不能凭模型声明 within 消歧。
  return target.exact && matches.length === 1 && !matches[0]!.disabled;
}

function requireEvidence(values: string[], observation: PageObservation) {
  if (
    !values.length ||
    observation.truncated ||
    !values.every((s) => observation.text.includes(s))
  )
    throw Error('WORKFLOW_CONDITION_CHANGED');
  return values;
}

function link(observation: PageObservation, name: string, oldUrl: string) {
  const matches = (observation.links ?? []).filter((l) => l.name === name);
  if (!matches.length) throw Error('WORKFLOW_CONDITION_CHANGED');
  if (
    matches.length !== 1 ||
    matches[0]!.url === oldUrl ||
    new URL(matches[0]!.url).origin !== new URL(observation.url).origin ||
    !observation.text.split('\n').includes('[link-url] ' + matches[0]!.url)
  )
    throw Error('WORKFLOW_LINK_AMBIGUOUS');
  return matches[0]!.url;
}

/** 仅生成同一受控入口的提议。此函数没有网络、派发、授权或推进记录能力。 */
export function replayStep(
  e: TaskExecution,
  observation: PageObservation,
): NextStep {
  const use = currentWorkflow(e),
    recipe = use?.workflow.replay;
  if (
    !use ||
    !recipe ||
    e.loginOrigin ||
    observation.url !== use.targetUrl ||
    new URL(observation.url).origin !== use.workflow.applicability.origin ||
    e.observedAnomalies?.some((a) => a.goalVersion === e.goalVersion)
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
  const actions = e.actions.filter(
    (a) => a.goalVersion === e.goalVersion && a.status !== 'cancelled',
  );
  if (
    actions.some(
      (a, i) => a.workflowStep?.useId !== use.id || a.workflowStep.index !== i,
    )
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
  const pending = actions.find((a) => a.status !== 'confirmed');
  if (pending && (pending !== actions.at(-1) || !pending.returned))
    throw Error('EXECUTION_RESULT_UNKNOWN');
  const previous = pending
    ? {
        id: pending.id,
        status: 'confirmed' as const,
        evidence: requireEvidence(
          use.workflow.steps[pending.workflowStep!.index]!.after.evidence,
          observation,
        ),
      }
    : null;
  const oldAttachment = use.workflow.parameters.find(
    (p) => p.name === 'attachmentUrl',
  )!.value;
  const preparation: NonNullable<NextStep['preparation']> = [];
  if (
    !e.preparation?.some(
      (f) => f.goalVersion === e.goalVersion && f.kind === 'target',
    )
  )
    preparation.push({
      kind: 'target',
      url: use.targetUrl,
      materialId: null,
      evidence: requireEvidence(
        use.workflow.steps[0]!.before.evidence,
        observation,
      ),
    });
  if (pending?.action.kind === 'upload')
    preparation.push({
      kind: 'upload',
      url: link(observation, recipe.attachmentLink, oldAttachment),
      materialId: use.materialId,
      evidence: previous!.evidence,
    });
  if (pending?.effect === 'draft')
    preparation.push({
      kind: 'draft',
      url: use.targetUrl,
      materialId: null,
      evidence: previous!.evidence,
    });
  const base = {
    summary: '按已保存的做法核对本次网页。',
    previous,
    preparation,
    action: null,
  };
  const index = actions.length;
  if (index === use.workflow.steps.length) {
    const attachment = e.publication?.attachment;
    if (!pending?.submission || !attachment)
      throw Error('EXECUTION_RESULT_UNKNOWN');
    const url = link(
      observation,
      recipe.resultLink,
      use.workflow.recovery.resultUrl,
    );
    return {
      ...base,
      decision: 'complete',
      evidence: requireEvidence(recipe.publishedEvidence, observation),
      result: {
        url,
        targetUrl: use.targetUrl,
        attachmentUrl: attachment.url,
        publishedEvidence: recipe.publishedEvidence,
      },
    };
  }
  const step = use.workflow.steps[index]!;
  const evidence = requireEvidence(step.before.evidence, observation);
  const action = reboundAction(use, index);
  if (observation.controls && !observedControl(action, observation))
    throw Error('WORKFLOW_CONTROL_CHANGED');
  const needsPublication =
    step.effect === 'publication' ||
    step.bindings.some((b) => ['content', 'destination'].includes(b.parameter));
  if (!needsPublication)
    return { ...base, decision: 'act', evidence, effect: step.effect, action };
  const upload = e.preparation?.find(
    (f) =>
      f.goalVersion === e.goalVersion &&
      f.kind === 'upload' &&
      f.materialId === use.materialId,
  );
  if (!upload) throw Error('WORKFLOW_NOT_APPLICABLE');
  const publication = {
    ...((use.approved?.fields ?? use.fields)
      ? { fields: use.approved?.fields ?? use.fields }
      : {}),
    content: e.publication?.content ?? use.content,
    destination: use.destination,
    attachment: {
      materialId: use.materialId,
      targetUrl: use.targetUrl,
      url: upload.url,
    },
  };
  if (!e.publication?.approvalId)
    return { ...base, decision: 'review', evidence, publication };
  let recovery: NextStep['recovery'];
  if (step.effect === 'publication') {
    const url = link(
      observation,
      recipe.resultLink,
      use.workflow.recovery.resultUrl,
    );
    recovery = {
      rule: 'public-attachment-v1',
      url,
      targetUrl: use.targetUrl,
      attachmentUrl: upload.url,
      evidence: [recipe.resultLink],
    };
    requireEvidence(recovery.evidence, observation);
  }
  return {
    ...base,
    decision: 'act',
    evidence,
    effect: step.effect,
    action,
    publication,
    approvalId: e.publication.approvalId,
    ...(recovery ? { recovery } : {}),
  };
}
