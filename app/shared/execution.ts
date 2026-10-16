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
