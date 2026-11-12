import {
  resolveWorkflowFields,
  validWorkflowApproval,
} from './workflow-rich-text';
import type { Publication } from './publication';
import { richTextControl } from './rich-text';
import type { TaskExecution, NextStep, WebAction } from './execution';
import type { PageObservation } from './model';
import { type WorkflowUse } from './workflow';
import { expectedNavigationLink } from './action-navigation';
import { actionLandmark } from './web-action';
import { creationFieldsMatch } from './target-creation';

export function currentWorkflow(e: TaskExecution) {
  return e.workflowUses?.find((u) => u.goalVersion === e.goalVersion);
}

export function workflowTargetUrl(e: TaskExecution, use: WorkflowUse) {
  if (
    use.workflow.replay?.target !== 'observed-entry-route' ||
    use.workflow.applicability.entryUrl === use.workflow.recovery.targetUrl
  )
    return use.targetUrl;
  return e.preparation?.find(
    (f) => f.kind === 'target' && f.goalVersion === use.goalVersion,
  )?.url;
}

export function workflowPage(
  e: TaskExecution,
  use: WorkflowUse,
  index: number,
) {
  if (use.workflow.replay?.target !== 'observed-entry-route' || index === 0)
    return use.targetUrl;
  const previous = e.actions.filter(
    (a) => a.goalVersion === use.goalVersion && a.status !== 'cancelled',
  )[index - 1];
  return (
    previous?.resultSource?.url ??
    (previous?.navigation ? undefined : previous?.source.url)
  );
}

export function workflowCreation(use: WorkflowUse, index: number) {
  const navigation = use.workflow.steps[index]?.navigation;
  return navigation?.kind === 'create' ? navigation.creation : undefined;
}

export function workflowNavigationMatches(
  use: WorkflowUse,
  index: number,
  source: PageObservation,
  action: WebAction,
  targetUrl: string | undefined,
  creation: NextStep['targetCreation'],
) {
  const step = use.workflow.steps[index];
  const expected = workflowCreation(use, index);
  if (JSON.stringify(expected) !== JSON.stringify(creation)) return false;
  if (expected && !creationFieldsMatch(expected, source)) return false;
  if (step?.navigation?.kind !== 'link') return true;
  const href = expectedNavigationLink(action, source, source.links);
  if (!href) return false;
  const previous = step.after.source.url;
  if (previous === use.workflow.recovery.targetUrl) return href === targetUrl;
  const from = new URL(previous),
    to = new URL(href);
  if (from.origin !== to.origin || from.pathname !== to.pathname) return false;
  const contexts: [URL, URL][] = [
    [new URL(step.before.source.url), new URL(source.url)],
  ];
  const oldEditor = new URL(use.workflow.recovery.targetUrl);
  const editor = targetUrl ? new URL(targetUrl) : undefined;
  if (editor) contexts.push([oldEditor, editor]);
  const oldPath = oldEditor.pathname.split('/');
  const editorPath = editor?.pathname.split('/');
  const changedSegments =
    editorPath?.length === oldPath.length
      ? oldPath.flatMap((part, position) =>
          part === editorPath[position] ? [] : [position],
        )
      : [];
  const identifier = changedSegments.length === 1 ? changedSegments[0]! : -1;
  for (const key of new Set([
    ...from.searchParams.keys(),
    ...to.searchParams.keys(),
  ])) {
    const oldValues = from.searchParams.getAll(key),
      values = to.searchParams.getAll(key);
    if (oldValues.length !== values.length) return false;
    if (oldValues.length !== 1) {
      if (JSON.stringify(oldValues) !== JSON.stringify(values)) return false;
      continue;
    }
    const [value] = oldValues;
    const known = new Set<string>();
    for (const [historical, current] of contexts) {
      const old = historical.searchParams.getAll(key),
        next = current.searchParams.getAll(key);
      if (old.length === 1 && old[0] === value && next.length === 1)
        known.add(next[0]!);
    }
    if (
      identifier !== -1 &&
      oldPath[identifier] === value &&
      editorPath?.[identifier]
    )
      known.add(editorPath[identifier]);
    if (known.size > 1 || values[0] !== (known.values().next().value ?? value))
      return false;
  }
  return true;
}

export function reboundAction(
  use: WorkflowUse,
  index: number,
  fields: Publication['fields'] = use.approved?.fields ?? use.fields,
  sourceUrl = use.approved?.targetUrl ?? use.targetUrl,
): WebAction {
  const step = use.workflow.steps[index];
  if (!step) throw Error('WORKFLOW_NOT_APPLICABLE');
  const action = structuredClone(step.action);
  const node = 'richTextNodeId' in action.target;
  if (
    node &&
    (!step.bindings?.length || !use.workflow.replay?.richTextFields?.length)
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
  if (!validWorkflowApproval(use)) throw Error('WORKFLOW_NOT_APPLICABLE');
  if (action.target.frameUrl === step.before.source.url)
    action.target.frameUrl = sourceUrl;
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
            const field = fields?.find((f) => f.id === binding.fieldId);
            if (
              !field ||
              binding.parameter !== 'content' ||
              action.kind !== 'fill'
            )
              throw Error('WORKFLOW_NOT_APPLICABLE');
            const locator = field.richText;
            if (
              node !== !!locator ||
              (node &&
                !use.workflow.replay?.richTextFields?.some(
                  (r) => r.fieldId === field.id,
                ))
            )
              throw Error('WORKFLOW_NOT_APPLICABLE');
            action.target = locator
              ? structuredClone(locator)
              : {
                  role: 'textbox',
                  name: field.name,
                  exact: true,
                  ...(field.frameUrl
                    ? {
                        frameUrl:
                          field.frameUrl === use.targetUrl
                            ? sourceUrl
                            : field.frameUrl,
                      }
                    : {}),
                };
            return field.value;
          })()
        : binding.parameter === 'content'
          ? (use.approved?.content ?? use.content)
          : use.destination;
    } else throw Error('WORKFLOW_NOT_APPLICABLE');
  }
  if (
    node &&
    !step.bindings.some(
      (b) => b.fieldId && b.field === 'value' && b.parameter === 'content',
    )
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
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
  if (actionLandmark(action))
    return !!expectedNavigationLink(action, source, source.links);
  if (!source.controls) return false;
  try {
    const rich = richTextControl(action, source);
    if ('richTextNodeId' in action.target) return !!rich;
  } catch {
    return false;
  }
  const target = action.target;
  if ('richTextNodeId' in target) return false;
  const matches = source.controls.filter(
    (c) =>
      c.role === target.role &&
      c.name === target.name &&
      c.frameUrl === (target.frameUrl ?? source.url),
  );
  // 普通控件仍按完整观察的精确名称核对。
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
    new URL(observation.url).origin !== use.workflow.applicability.origin ||
    e.observedAnomalies?.some((a) => a.goalVersion === e.goalVersion)
  )
    throw Error('WORKFLOW_NOT_APPLICABLE');
  const actions = e.actions.filter(
    (a) => a.goalVersion === e.goalVersion && a.status !== 'cancelled',
  );
  const index = actions.length;
  const targetUrl = workflowTargetUrl(e, use);
  if (observation.url !== workflowPage(e, use, index))
    throw Error('WORKFLOW_NOT_APPLICABLE');
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
    targetUrl === observation.url &&
    !e.preparation?.some(
      (f) => f.goalVersion === e.goalVersion && f.kind === 'target',
    )
  )
    preparation.push({
      kind: 'target',
      url: targetUrl,
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
  if (pending?.effect === 'draft' && targetUrl)
    preparation.push({
      kind: 'draft',
      url: targetUrl,
      materialId: null,
      evidence: previous!.evidence,
    });
  const base = {
    summary: '按已保存的做法核对本次网页。',
    previous,
    preparation,
    action: null,
  };
  if (index === use.workflow.steps.length) {
    const attachment = e.publication?.attachment;
    if (!pending?.submission || !attachment || !targetUrl || !recipe.resultLink)
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
        targetUrl,
        attachmentUrl: attachment.url,
        publishedEvidence: recipe.publishedEvidence,
      },
    };
  }
  const step = use.workflow.steps[index]!;
  const evidence = requireEvidence(step.before.evidence, observation);
  const needsPublication =
    step.effect === 'publication' ||
    step.bindings.some((b) => ['content', 'destination'].includes(b.parameter));
  const fields =
    use.approved?.fields ??
    (needsPublication ? resolveWorkflowFields(use, observation) : use.fields);
  const action = reboundAction(use, index, fields, observation.url);
  if (observation.controls && !observedControl(action, observation))
    throw Error('WORKFLOW_CONTROL_CHANGED');
  const targetCreation = workflowCreation(use, index);
  if (
    !workflowNavigationMatches(
      use,
      index,
      observation,
      action,
      targetUrl,
      targetCreation,
    )
  )
    throw Error('WORKFLOW_CONDITION_CHANGED');
  if (!needsPublication)
    return {
      ...base,
      decision: 'act',
      evidence,
      effect: step.effect,
      action,
      ...(targetCreation ? { targetCreation } : {}),
    };
  const upload = e.preparation?.find(
    (f) =>
      f.goalVersion === e.goalVersion &&
      f.kind === 'upload' &&
      f.materialId === use.materialId,
  );
  if (!upload || targetUrl !== observation.url)
    throw Error('WORKFLOW_NOT_APPLICABLE');
  const publication = {
    ...(fields ? { fields } : {}),
    content: e.publication?.content ?? use.content,
    destination: use.destination,
    attachment: {
      materialId: use.materialId,
      targetUrl,
      url: upload.url,
    },
  };
  if (!e.publication?.approvalId)
    return { ...base, decision: 'review', evidence, publication };
  let recovery: NextStep['recovery'];
  if (step.effect === 'publication' && recipe.resultLink) {
    const url = link(
      observation,
      recipe.resultLink,
      use.workflow.recovery.resultUrl,
    );
    recovery = {
      rule: 'public-attachment-v1',
      url,
      targetUrl,
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
