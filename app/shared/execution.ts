import { z } from 'zod';
import { pageSourceSchema } from './model';

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
export const roleLocatorSchema = z.strictObject({
  role: z.enum([
    'button',
    'link',
    'checkbox',
    'textbox',
    'combobox',
    'radio',
    'option',
    'menuitem',
    'row',
    'tab',
    'switch',
  ]),
  name: z.string().min(1).max(500),
  exact: z.boolean().default(true),
});
export const elementLocatorSchema = roleLocatorSchema.extend({
  within: roleLocatorSchema.optional(),
});
export const webActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), target: elementLocatorSchema }),
  z.strictObject({
    kind: z.literal('fill'),
    target: elementLocatorSchema,
    value: z.string().max(20000),
  }),
  z.strictObject({
    kind: z.literal('check'),
    target: elementLocatorSchema,
    checked: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('select'),
    target: elementLocatorSchema,
    value: z.string().max(500).describe('选项在页面中显示的完整标签'),
  }),
]);
export type WebAction = z.infer<typeof webActionSchema>;
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
  source: pageSourceSchema,
  resultSource: pageSourceSchema.optional(),
  binding: pageBindingSchema,
  evidence: z.array(z.string().max(2000)).max(10),
  returned: z.boolean(),
});
export type ActionFact = z.infer<typeof actionFactSchema>;
export const executionPauseReasonSchema = z.enum([
  'takeover',
  'page-change',
  'ownership-unknown',
  'native-unavailable',
]);
export type ExecutionPauseReason = z.infer<typeof executionPauseReasonSchema>;
export const pauseDescription = {
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
} satisfies Record<ExecutionPauseReason, { label: string; message: string }>;
export const executionSchema = z.strictObject({
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
});
export const nextStepSchema = z.strictObject({
  decision: z.enum(['act', 'complete', 'wait']),
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
