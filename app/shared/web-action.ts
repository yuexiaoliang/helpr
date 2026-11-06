import { z } from 'zod';

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
  frameUrl: z.url().optional(),
});
export const webActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('upload'),
    materialId: z.string().uuid(),
    target: z.strictObject({
      fileIndex: z.number().int().nonnegative().max(100),
      frameUrl: z.url().optional(),
    }),
  }),
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
