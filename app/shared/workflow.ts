import { z } from 'zod';
import { richTextLocatorSchema, webActionSchema } from './web-action';
import { pageSourceSchema } from './model';
import { publicationFieldsSchema } from './publication';

const parameter = z.enum([
  'materialId',
  'content',
  'destination',
  'targetUrl',
  'attachmentUrl',
]);
// 跨次输入只携带语义和新值；节点只能在本次预览观察中取得。
export const workflowInputFieldsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      name: z.string().trim().min(1).max(500),
      frameUrl: z.url().optional(),
      value: z.string().trim().min(1).max(4000),
    }),
  )
  .min(1)
  .max(12);
export const workflowRichTextRuleSchema = z.strictObject({
  fieldId: z.string(),
  rule: z.literal('observed-structure-v1'),
  frame: z.enum(['main', 'exact']),
  frameUrl: z.url(),
  path: richTextLocatorSchema.shape.path,
  role: z.string().max(100),
  name: z.string().max(1000),
});
export const workflowChoiceSchema = z.strictObject({
  fields: workflowInputFieldsSchema.optional(),
  taskId: z.string(),
  version: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1).max(20000),
  destination: z.string().min(1).max(500),
});
export const workflowBodySchema = z.strictObject({
  fields: publicationFieldsSchema.optional(),
  format: z.literal(1),
  version: z.string().uuid(),
  parentVersion: z.string().uuid().nullable(),
  taskId: z.string(),
  goalVersion: z.number().int().positive(),
  goal: z.string(),
  createdAt: z.number().int().nonnegative(),
  applicability: z.strictObject({
    origin: z.string(),
    entryUrl: z.url(),
    mode: z.literal('attachment-publication'),
    validated: z.literal('same-inputs-only'),
    newInputs: z.literal('requires-validation'),
  }),
  parameters: z
    .array(
      z.strictObject({
        name: parameter,
        value: z.string(),
        source: z.enum([
          'material-version',
          'approved-publication',
          'preparation',
        ]),
        sourceId: z.string(),
      }),
    )
    .length(5),
  steps: z
    .array(
      z.strictObject({
        actionId: z.string(),
        runId: z.string(),
        action: webActionSchema,
        effect: z.enum(['interaction', 'upload', 'draft', 'publication']),
        bindings: z
          .array(
            z.strictObject({
              field: z.enum(['materialId', 'value']),
              parameter,
              fieldId: z.string().optional(),
            }),
          )
          .max(2),
        before: z.strictObject({
          source: pageSourceSchema,
          evidence: z.array(z.string()).max(10),
        }),
        after: z.strictObject({
          source: pageSourceSchema,
          evidence: z.array(z.string()).min(1).max(10),
        }),
        returned: z.boolean(),
      }),
    )
    .min(1)
    .max(60),
  resultRule: z.literal(
    'unique-target-approved-content-destination-and-attachment-sha256',
  ),
  recovery: z.strictObject({
    targetUrl: z.url(),
    targetFactId: z.string().uuid(),
    resultUrl: z.url(),
    uncertainDispatch: z.literal('read-only-no-resend'),
  }),
  evidence: z.strictObject({
    resultId: z.string().uuid(),
    materialId: z.string().uuid(),
    approvalId: z.string().uuid(),
  }),
  authority: z.literal('none'),
  replay: z
    .strictObject({
      format: z.literal(1),
      target: z.literal('explicit-current-url'),
      richTextFields: z
        .array(workflowRichTextRuleSchema)
        .min(1)
        .max(12)
        .optional(),
      attachmentLink: z.string().min(1).max(1000),
      resultLink: z.string().min(1).max(1000),
      publishedEvidence: z.array(z.string()).min(1).max(10),
    })
    .optional(),
});
export const learnedWorkflowSchema = workflowBodySchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LearnedWorkflow = z.infer<typeof learnedWorkflowSchema>;
export const workflowUseSchema = z.strictObject({
  approved: z
    .strictObject({
      id: z.string().uuid(),
      content: workflowChoiceSchema.shape.content,
      fields: publicationFieldsSchema.optional(),
    })
    .optional(),
  id: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  workflow: learnedWorkflowSchema,
  materialId: z.string().uuid(),
  targetUrl: z.url(),
  content: workflowChoiceSchema.shape.content,
  fields: workflowInputFieldsSchema.optional(),
  destination: workflowChoiceSchema.shape.destination,
  source: pageSourceSchema,
});
export type WorkflowUse = z.infer<typeof workflowUseSchema>;

export const workflowRepairSchema = z.strictObject({
  id: z.string().uuid(),
  useId: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  runId: z.string(),
  fromIndex: z.number().int().nonnegative().max(60),
  source: pageSourceSchema,
  reason: z.enum(['WORKFLOW_CONDITION_CHANGED', 'WORKFLOW_CONTROL_CHANGED']),
});
export const workflowDecisionSchema = z.strictObject({
  version: z.string().uuid(),
  expectedParent: z.string().uuid().nullable(),
  observedHeads: z.array(z.string().uuid()).max(60),
  status: z.enum(['adopted', 'conflict', 'unusable']),
});
