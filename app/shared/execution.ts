import { z } from 'zod';
import { pageSourceSchema } from './model';
import { webActionSchema } from './web-action';
import {
  publicationSchema,
  downloadCheckSchema,
  publicationResultProposalSchema,
  publicationCheckSchema,
  publicationRecoverySchema,
} from './publication';
import { learnedWorkflowSchema } from './workflow';
import {
  materialSelectionSchema,
  materialVersionSchema,
  preparationProposalSchema,
} from './material';

export const systemConditionSchema = z.enum([
  'screen-locked',
  'sleeping',
  'session-unavailable',
]);
export type SystemCondition = z.infer<typeof systemConditionSchema>;
export const systemConditionLabel: Record<SystemCondition, string> = {
  'screen-locked': '屏幕锁定',
  sleeping: '电脑休眠',
  'session-unavailable': '系统会话尚未就绪',
};

export const executionPhaseSchema = z.enum([
  'queued',
  'checking',
  'running',
  'stopped',
  'unknown',
  'paused',
  'complete',
  'failed',
]);
export { webActionSchema, elementLocatorSchema } from './web-action';
export type { WebAction } from './web-action';
export const actionFailureCodeSchema = z.enum([
  'EXECUTION_CONNECT_UNSTABLE',
  'EXECUTION_CONNECT_INVISIBLE',
  'EXECUTION_CONNECT_VIEWPORT',
  'EXECUTION_CONNECT_CAPABILITY',
  'EXECUTION_CONNECT_TIMEOUT',
  'EXECUTION_CONNECT_UNAVAILABLE',
  'EXECUTION_ACT_UNSTABLE',
  'EXECUTION_ACT_INVISIBLE',
  'EXECUTION_ACT_VIEWPORT',
  'EXECUTION_ACT_CAPABILITY',
  'EXECUTION_ACT_TIMEOUT',
  'EXECUTION_ACT_UNAVAILABLE',
  'EXECUTION_ACT_OBSCURED',
  'EXECUTION_ACT_LOCATOR_MISSING',
  'EXECUTION_ACT_NAVIGATION',
  'EXECUTION_ACT_STABILITY_WAIT',
  'EXECUTION_ACT_SCROLL_WAIT',
  'EXECUTION_ACT_INPUT_WAIT',
  'EXECUTION_ACT_HIT_TARGET_WAIT',
]);
export const pageBindingSchema = z.strictObject({
  targetId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export const actionFactSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string(),
  goalVersion: z.number().int(),
  status: z.enum([
    'reserved',
    'dispatched',
    'unknown',
    'confirmed',
    'cancelled',
  ]),
  summary: z.string().max(1500),
  action: webActionSchema,
  effect: z.enum(['interaction', 'upload', 'draft', 'publication']).optional(),
  preconditions: z.array(z.string().min(1).max(2000)).max(10).optional(),
  submission: z
    .strictObject({
      publication: publicationSchema,
      download: downloadCheckSchema,
      recovery: publicationRecoverySchema
        .extend({
          targetFactId: z.string().uuid(),
          uploadFactId: z.string().uuid(),
        })
        .optional(),
    })
    .optional(),
  publicationApprovalId: z.string().uuid().optional(),
  source: pageSourceSchema,
  observedUrls: z.array(z.url().max(4096)).max(300).optional(),
  resultSource: pageSourceSchema.optional(),
  binding: pageBindingSchema,
  evidence: z.array(z.string().max(2000)).max(10),
  returned: z.boolean(),
  dispatchState: z.enum(['not-dispatched', 'possible']).optional(),
});
export type ActionFact = z.infer<typeof actionFactSchema>;
export const executionPauseReasonSchema = z.enum([
  'takeover',
  'page-change',
  'ownership-unknown',
  'native-unavailable',
  'record-unavailable',
  'backup-restore',
]);
export type ExecutionPauseReason = z.infer<typeof executionPauseReasonSchema>;
export const pauseDescription = {
  'backup-restore': {
    label: '恢复资料 · 等待核对',
    message:
      '资料已恢复，自动工作保持暂停。先核对实际结果，再选择继续哪些任务。',
  },
  takeover: {
    label: '已让出操作',
    message:
      '你已接手网页，我已让出操作。页面与文字保留，明确继续后先核对再续做。',
  },
  'page-change': {
    label: '页面变化 · 已暂停',
    message:
      '页面或控制归属已变化，旧操作资格失效。重新识别后仍需明确继续，先核对现有结果。',
  },
  'ownership-unknown': {
    label: '归属待核对',
    message:
      '暂时无法确认输入归属，窗口内任务已暂停；没有认定你接管了两项。重新识别后请分别明确继续。',
  },
  'native-unavailable': {
    label: '本机能力不可用',
    message:
      '本机输入识别暂不可用，已暂停自动操作并保留网页。能力恢复后仍需明确继续，无需关闭系统安全设置。',
  },
  'record-unavailable': {
    label: '保存中断 · 已暂停',
    message:
      '任务变化在记录连接中断时未能保存，已暂停自动操作。保存恢复后请核对任务，再明确继续。',
  },
} satisfies Record<ExecutionPauseReason, { label: string; message: string }>;
export { publicationSchema } from './publication';
export type { Publication } from './publication';
const questionSchema = z.strictObject({
  type: z.enum(['review', 'login']).optional(),
  runId: z.string().optional(),
  id: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  text: z.string().trim().min(1).max(1500),
  url: z.string(),
});
export const participationReplySchema = z.strictObject({
  kind: z.literal('participation-reply'),
  taskId: z.string().min(1),
  questionId: questionSchema.shape.id,
  text: z.string().trim().min(1).max(4000),
});
export type ParticipationReply = z.infer<typeof participationReplySchema>;
const decisionFields = {
  kind: z.literal('participation-decision'),
  taskId: z.string().min(1),
  questionId: questionSchema.shape.id,
};
export const participationDecisionSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...decisionFields,
    operation: z.literal('edit'),
    content: publicationSchema.shape.content,
  }),
  z.strictObject({ ...decisionFields, operation: z.literal('approve') }),
  z.strictObject({ ...decisionFields, operation: z.literal('login-check') }),
]);
export type ParticipationDecision = z.infer<typeof participationDecisionSchema>;
export const executionSchema = z.strictObject({
  observedAnomalies: z
    .array(
      z.strictObject({
        goalVersion: z.number().int().positive(),
        source: pageSourceSchema,
        anomalies: z.array(z.string()).max(20),
        extraResults: z.array(z.url()).max(50),
      }),
    )
    .optional(),
  publicationChecks: z.array(publicationCheckSchema).max(60).optional(),
  publicationHistory: z
    .array(
      z.strictObject({
        check: publicationCheckSchema,
        reason: z.enum(['stale-worker', 'changed-intent']),
      }),
    )
    .max(60)
    .optional(),
  materialProcessing: z
    .array(
      z.strictObject({
        materialId: z.string().uuid(),
        goalVersion: z.number().int().positive(),
        targetUrl: z.url(),
        approvalId: z.string().uuid(),
        actionId: z.string(),
        status: z.enum(['pending', 'unknown', 'complete']),
        resultId: z.string().uuid().nullable(),
      }),
    )
    .optional(),
  learnedWorkflows: z.array(learnedWorkflowSchema).max(60).optional(),
  workflowAdoption: z
    .strictObject({
      version: z.string().uuid(),
      sha256: z.string(),
      expectedParent: z.string().uuid().nullable(),
    })
    .optional(),
  prepared: z
    .strictObject({
      goalVersion: z.number().int().positive(),
      source: pageSourceSchema,
      evidence: z.array(z.string()).min(1).max(10),
    })
    .optional(),
  materials: z.array(materialVersionSchema).optional(),
  preparation: z
    .array(
      preparationProposalSchema.extend({
        id: z.string().uuid(),
        goalVersion: z.number().int().positive(),
        actionId: z.string().nullable(),
        source: pageSourceSchema,
        verification: z.literal('page-observed'),
      }),
    )
    .optional(),
  publication: publicationSchema
    .extend({
      revision: z.number().int().positive(),
      approvalId: z.string().uuid().nullable(),
      origin: z.string(),
    })
    .optional(),
  loginOrigin: z.string().optional(),
  question: questionSchema.optional(),
  answers: z
    .array(
      questionSchema.extend({ answer: participationReplySchema.shape.text }),
    )
    .optional(),
  restoreReview: z
    .enum(['required', 'ready', 'unknown', 'complete'])
    .optional(),
  modelVersion: z.literal(1).default(1),
  recoveryPending: z.boolean().optional(),
  recoverySource: z
    .strictObject({ url: z.string(), goalVersion: z.number().int().positive() })
    .optional(),
  intent: z.enum(['automatic', 'stopped']),
  phase: executionPhaseSchema,
  version: z.number().int().positive(),
  intentId: z.string().min(1),
  goalVersion: z.number().int().positive(),
  goal: z.string(),
  runId: z.string().nullable(),
  resource: z.string().nullable(),
  summary: z.string(),
  pauseReason: executionPauseReasonSchema.optional(),
  actions: z.array(actionFactSchema),
  result: z
    .strictObject({
      goalVersion: z.number().int().positive(),
      source: pageSourceSchema,
      evidence: z.array(z.string()).min(1).max(10),
    })
    .optional(),
});
export type TaskExecution = z.infer<typeof executionSchema>;
export const executionIntentSchema = z.strictObject({
  kind: z.literal('execution-intent'),
  requestId: z.string().min(1).max(100),
  taskId: z.string().min(1),
  intent: z.enum(['start', 'stop', 'continue', 'revise']),
  expectedVersion: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(20000).optional(),
});
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;
export const executionControlSchema = z.strictObject({
  blocked: z.boolean(),
  stopSaved: z.boolean(),
  message: z.string(),
  reason: executionPauseReasonSchema.optional(),
  system: z.boolean().optional(),
});
export const nextStepSchema = z.strictObject({
  recovery: publicationRecoverySchema.optional(),
  effect: actionFactSchema.shape.effect,
  result: publicationResultProposalSchema.optional(),
  anomalies: z.array(z.string().min(1).max(2000)).max(20).optional(),
  extraResults: z.array(z.url()).max(50).optional(),
  decision: z.enum([
    'observe',
    'material',
    'prepared',
    'act',
    'complete',
    'wait',
    'ask',
    'review',
    'login',
    'authenticated',
  ]),
  material: materialSelectionSchema.nullable().optional(),
  preparation: z.array(preparationProposalSchema).max(5).optional(),
  publication: publicationSchema.nullable().optional(),
  approvalId: z.string().uuid().nullable().optional(),
  summary: z.string().min(1).max(1500),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
  previous: z
    .strictObject({
      id: z.string(),
      status: z.enum(['confirmed', 'unknown']),
      evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
    })
    .nullable(),
  action: webActionSchema.nullable(),
});
export type NextStep = z.infer<typeof nextStepSchema>;
