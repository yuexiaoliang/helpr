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
// 仅由完整DOM快照形成的结构路径；不接受任意CSS、XPath或网页脚本。
export const richTextLocatorSchema = z.strictObject({
  richTextNodeId: z.number().int().positive(),
  path: z
    .string()
    .max(2000)
    .regex(
      /^html:nth-child\(1\)(?: > [a-z][a-z0-9-]*:nth-child\([1-9][0-9]*\)){1,32}$/,
    ),
  frameUrl: z.url(),
});
export const fillLocatorSchema = z.union([
  elementLocatorSchema,
  richTextLocatorSchema,
]);
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
    target: fillLocatorSchema,
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
