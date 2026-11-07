import { z } from 'zod';

export const MATERIAL_LIMIT = 8 * 1024 * 1024;
export const materialSelectionSchema = z.strictObject({
  scope: z.string().min(1).max(4096),
  rule: z.enum([
    'exact',
    'only',
    'latest',
    'latest-unprocessed',
    'all-unprocessed',
    'date',
  ]),
  dateName: z.string().max(255).optional(),
  name: z.string().min(1).max(255).nullable(),
  extension: z
    .string()
    .regex(/^\.[a-zA-Z0-9]+$/)
    .nullable(),
  basis: z.string().min(1).max(4000),
});
export type MaterialSelection = z.infer<typeof materialSelectionSchema>;
export const materialVersionSchema = z.strictObject({
  id: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(MATERIAL_LIMIT),
  name: z.string().min(1).max(255),
  source: z.string().min(1).max(4096),
  selectedAt: z.number().int().nonnegative(),
  selection: materialSelectionSchema,
});
export type MaterialVersion = z.infer<typeof materialVersionSchema>;
export const materialPayloadSchema = z.strictObject({
  name: materialVersionSchema.shape.name,
  sha256: materialVersionSchema.shape.sha256,
  base64: z.string().max(Math.ceil(MATERIAL_LIMIT / 3) * 4),
});
export const preparationProposalSchema = z.strictObject({
  kind: z.enum(['target', 'upload', 'draft']),
  url: z.url(),
  materialId: z.string().uuid().nullable(),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(10),
});
export const materialFailureMessage: Record<string, string> = {
  MATERIAL_SCOPE_REQUIRED:
    '请提供本次可取用的文件或文件夹绝对路径，并说明选哪一份。',
  MATERIAL_AMBIGUOUS:
    '范围内有多个符合条件的文件，无法唯一选择。请给出确切文件名或更明确的取材规则。',
  MATERIAL_MISSING: '指定范围内没有找到符合要求的文件，请核对路径或补充素材。',
  MATERIAL_ACCESS_DENIED:
    '无法读取指定素材，请检查文件访问权限或提供另一处可读取的位置。',
  MATERIAL_CHANGED:
    '读取时来源文件发生变化，尚未固定版本。请等文件保存完成后再试。',
  MATERIAL_TOO_LARGE:
    '当前支持固定不超过 8 MiB 的单份素材，请提供范围内更小的文件。',
};
