import { workflowInputFieldsSchema } from './workflow';
import type { LearnedWorkflow, WorkflowUse } from './workflow';
import type { TaskExecution } from './execution';
import type { PageObservation } from './model';
import type { Publication } from './publication';
import { publicationSchema, publicationFieldsSchema } from './publication';
import { richTextControl } from './rich-text';

/** 仅由已核实的原动作及其完整源控件归纳；历史节点仍留作审计，不是选择规则。 */
export function workflowRichTextRules(
  fields: Publication['fields'],
  actions: TaskExecution['actions'],
  targetUrl: string,
): NonNullable<LearnedWorkflow['replay']>['richTextFields'] {
  const rules = fields
    ?.filter((f) => f.richText)
    .map((field) => {
      const matches = actions.filter(
        (a) =>
          a.action.kind === 'fill' &&
          JSON.stringify(a.action.target) === JSON.stringify(field.richText) &&
          a.action.value === field.value &&
          a.status === 'confirmed',
      );
      if (matches.length !== 1) throw Error('WORKFLOW_NOT_APPLICABLE');
      const a = matches[0]!;
      const control = richTextControl(
        a.action,
        {
          ...a.source,
          text: '',
          controls: a.richTextSource ? [a.richTextSource] : [],
        },
        true,
      )!;
      if (
        a.source.url !== targetUrl ||
        !a.richTextResult ||
        a.richTextResult.textValue !== field.value
      )
        throw Error('WORKFLOW_NOT_APPLICABLE');
      return {
        fieldId: field.id,
        rule: 'observed-structure-v1' as const,
        frame:
          field.frameUrl === targetUrl ? ('main' as const) : ('exact' as const),
        frameUrl: field.frameUrl!,
        path: field.richText!.path,
        role: control.role,
        name: control.name,
      };
    });
  return rules?.length ? rules : undefined;
}

export function workflowFieldShape(
  fields: Publication['fields'],
  from: string,
  to: string,
) {
  return fields?.map(({ id, name, frameUrl }) => ({
    id,
    name,
    frameUrl: frameUrl === from ? to : frameUrl,
  }));
}

/** 本次新输入的完整拼接和语义必须不变；不接收模型提供的历史节点。 */
export function validWorkflowInputs(
  use: Pick<
    WorkflowUse,
    'workflow' | 'fields' | 'content' | 'destination' | 'targetUrl'
  >,
) {
  const rules = use.workflow.replay?.richTextFields;
  if (
    JSON.stringify(
      workflowFieldShape(use.fields, use.targetUrl, use.targetUrl),
    ) !==
    JSON.stringify(
      workflowFieldShape(
        use.workflow.fields,
        use.workflow.recovery.targetUrl,
        use.targetUrl,
      ),
    )
  )
    return false;
  if (use.fields && !workflowInputFieldsSchema.safeParse(use.fields).success)
    return false;
  if (
    use.workflow.fields?.some(
      (f) => !!f.richText !== !!rules?.some((r) => r.fieldId === f.id),
    )
  )
    return false;
  return (
    publicationSchema.safeParse({
      content: use.content,
      destination: use.destination,
    }).success &&
    (!use.fields ||
      (use.fields.map((f) => f.value).join('\n\n') === use.content &&
        new Set(use.fields.map((f) => f.id)).size === use.fields.length))
  );
}

/** 只选择当前观察已经证明的完整控件，不从历史backend或DOM文字合成观察。 */
export function resolveWorkflowFields(
  use: WorkflowUse,
  source: PageObservation,
): Publication['fields'] {
  if (
    !validWorkflowInputs(use) ||
    source.url !== use.targetUrl ||
    source.truncated
  )
    throw Error('WORKFLOW_CONTROL_CHANGED');
  const fields = use.fields?.map((field) => {
    const rule = use.workflow.replay?.richTextFields?.find(
      (r) => r.fieldId === field.id,
    );
    if (!rule) return field;
    const frameUrl = rule.frame === 'main' ? source.url : rule.frameUrl;
    const matches = source.controls?.filter(
      (c) => c.frameUrl === frameUrl && c.richText?.locator?.path === rule.path,
    );
    const control = matches?.[0];
    if (
      matches?.length !== 1 ||
      !control?.richText?.locator ||
      control.role !== rule.role ||
      control.name !== rule.name
    )
      throw Error('WORKFLOW_CONTROL_CHANGED');
    try {
      richTextControl(
        { kind: 'fill', target: control.richText.locator, value: field.value },
        source,
        true,
      );
    } catch {
      throw Error('WORKFLOW_CONTROL_CHANGED');
    }
    return {
      ...field,
      frameUrl,
      richText: structuredClone(control.richText.locator),
    };
  });
  return fields ? publicationFieldsSchema.parse(fields) : undefined;
}

export function validWorkflowApproval(use: WorkflowUse) {
  if (!use.approved) return true;
  if (
    JSON.stringify(
      workflowFieldShape(use.approved.fields, use.targetUrl, use.targetUrl),
    ) !==
    JSON.stringify(workflowFieldShape(use.fields, use.targetUrl, use.targetUrl))
  )
    return false;
  if (
    use.approved.fields?.some((f) => {
      const rule = use.workflow.replay?.richTextFields?.find(
        (r) => r.fieldId === f.id,
      );
      return rule
        ? !f.richText ||
            f.richText.path !== rule.path ||
            f.richText.frameUrl !==
              (rule.frame === 'main' ? use.targetUrl : rule.frameUrl)
        : !!f.richText;
    })
  )
    return false;
  return publicationSchema.safeParse({
    content: use.approved.content,
    fields: use.approved.fields,
    destination: use.destination,
  }).success;
}
