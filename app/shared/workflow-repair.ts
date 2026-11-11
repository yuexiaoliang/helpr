import type { PageObservation } from './model';
import { resolveWorkflowFields } from './workflow-rich-text';
import type { TaskExecution, WebAction, NextStep } from './execution';
import {
  currentWorkflow,
  reboundAction,
  workflowPage,
  workflowTargetUrl,
  workflowNavigationMatches,
} from './workflow-replay';
import type { WorkflowUse } from './workflow';

export function currentRepair(e: TaskExecution) {
  const use = currentWorkflow(e);
  return e.workflowRepairs?.find(
    (r) => r.useId === use?.id && r.goalVersion === e.goalVersion,
  );
}

/** 只允许调整观察条件和定位，不能增加、删去或改变原路径的动作效果及参数。 */
export function sameWorkflowOperation(
  use: WorkflowUse,
  index: number,
  action: WebAction,
  effect: NextStep['effect'],
  sourceUrl?: string,
) {
  const expected = reboundAction(use, index, undefined, sourceUrl);
  const withoutTarget = (operation: WebAction) => ({
    ...operation,
    target: null,
  });
  const rich =
    'richTextNodeId' in action.target || 'richTextNodeId' in expected.target;
  return (
    (!rich ||
      JSON.stringify(action.target) === JSON.stringify(expected.target)) &&
    effect === use.workflow.steps[index]?.effect &&
    JSON.stringify(withoutTarget(action)) ===
      JSON.stringify(withoutTarget(expected)) &&
    new URL(action.target.frameUrl ?? use.targetUrl).origin ===
      new URL(use.targetUrl).origin
  );
}

export function withinWorkflowScope(
  e: TaskExecution,
  step: NextStep,
  source?: PageObservation,
) {
  const use = currentWorkflow(e);
  if (!use) return false;
  const targetUrl = workflowTargetUrl(e, use);
  const p = step.publication;
  let fields = use.approved?.fields ?? e.publication?.fields ?? use.fields;
  if (
    p &&
    !use.approved &&
    !e.publication &&
    use.workflow.replay?.richTextFields
  ) {
    if (!source) return false;
    try {
      fields = resolveWorkflowFields(
        use,
        source,
        use.workflow.replay.target === 'observed-entry-route' &&
          !!currentRepair(e),
      );
    } catch {
      return false;
    }
  }
  if (
    p &&
    (p.content !==
      (use.approved?.content ?? e.publication?.content ?? use.content) ||
      p.destination !== use.destination ||
      JSON.stringify(p.fields) !== JSON.stringify(fields) ||
      !p.attachment ||
      p.attachment.materialId !== use.materialId ||
      p.attachment.targetUrl !== targetUrl ||
      (e.publication?.attachment &&
        p.attachment.url !== e.publication.attachment.url))
  )
    return false;
  if (
    step.preparation?.some((f) =>
      f.kind === 'target' || f.kind === 'draft'
        ? f.url !== targetUrl
        : f.materialId !== use.materialId,
    )
  )
    return false;
  if (step.material || step.workflow) return false;
  if (step.action) {
    const index = e.actions.filter(
      (a) => a.goalVersion === e.goalVersion && a.status !== 'cancelled',
    ).length;
    try {
      return (
        !!source &&
        source.url === workflowPage(e, use, index) &&
        sameWorkflowOperation(
          use,
          index,
          step.action,
          step.effect,
          source.url,
        ) &&
        workflowNavigationMatches(
          use,
          index,
          source,
          step.action,
          targetUrl,
          step.targetCreation,
        )
      );
    } catch {
      return false;
    }
  }
  return true;
}
