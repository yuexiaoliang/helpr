import { z } from 'zod';

export const VERSION_SOURCE =
  'https://raw.githubusercontent.com/yuexiaoliang/helpr/refs/heads/codex/updates-stable/macos-arm64.json';
export const versionNumber = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
export const versionManifestSchema = z.strictObject({
  schema: z.literal(1),
  version: versionNumber,
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.enum(['arm64', 'x64']),
  minOS: versionNumber,
  dataFormats: z.array(z.number().int().positive()).min(1).max(16),
  stateModels: z.array(z.number().int().positive()).min(1).max(16),
  notes: z.array(z.string().min(1).max(300)).max(10),
  downloadURL: z.string().max(2048).nullable(),
});
export type VersionManifest = z.infer<typeof versionManifestSchema>;
export const versionCurrentSchema = z.strictObject({
  version: versionNumber,
  platform: z.string(),
  arch: z.string(),
  osVersion: versionNumber,
  dataFormat: z.number().int().positive(),
  stateModel: z.number().int().positive(),
});
export type VersionCurrent = z.infer<typeof versionCurrentSchema>;
export const versionResultKind = z.enum([
  'available',
  'latest',
  'older',
  'offline',
  'timeout',
  'source',
  'format',
  'architecture',
  'system',
  'data',
  'link',
]);
const resultSchema = z.strictObject({
  kind: versionResultKind,
  release: versionManifestSchema.optional(),
});
export type VersionResult = z.infer<typeof resultSchema>;
export const versionStatusSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  current: versionCurrentSchema,
  source: z.string(),
  phase: z.enum(['idle', 'checking', 'done']),
  origin: z.enum(['automatic', 'manual']).nullable(),
  result: resultSchema.nullable(),
  checkedAt: z.number().nullable(),
  lastSuccess: z
    .strictObject({
      kind: versionResultKind,
      version: versionNumber,
      checkedAt: z.number(),
    })
    .nullable(),
  noticeVisible: z.boolean(),
  openFailed: z.boolean(),
});
export type VersionStatus = z.infer<typeof versionStatusSchema>;
export const versionUICommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('version-status') }),
  z.strictObject({ kind: z.literal('version-check') }),
  z.strictObject({ kind: z.literal('version-dismiss') }),
  z.strictObject({
    kind: z.literal('version-open'),
    revision: z.number().int().nonnegative(),
  }),
]);
export const versionLabels: Record<
  VersionResult['kind'],
  { title: string; detail: string }
> = {
  available: {
    title: '发现可用新版',
    detail: '该版本适用于这台 Mac。可以先继续任务，方便时再手动下载。',
  },
  latest: {
    title: '已是最新版本',
    detail: '本机已安装可信来源中的最新适用版本。',
  },
  older: {
    title: '当前版本无需更新',
    detail: '来源列出的版本早于本机，保留当前版本，不提供降级入口。',
  },
  offline: {
    title: '未能检查新版',
    detail:
      '暂时无法连接版本来源，当前是否最新尚未确认。任务可以继续，网络恢复后再试。',
  },
  timeout: {
    title: '新版检查超时',
    detail:
      '未能及时取得版本信息，当前是否最新尚未确认。等待下次检查或手动重试。',
  },
  source: {
    title: '无法验证版本来源',
    detail: '连接或来源校验未通过，不能使用本次版本信息或下载位置。',
  },
  format: {
    title: '版本信息无法识别',
    detail: '信息损坏或不完整，无法确认版本和兼容性。保留本机版本，稍后再试。',
  },
  architecture: {
    title: '该版本不适用于这台 Mac',
    detail: '版本的平台或处理器架构不适用，暂不提供下载入口。',
  },
  system: {
    title: '新版需要更高的 macOS',
    detail: '当前系统不符合新版要求，暂不提供下载入口。',
  },
  data: {
    title: '新版暂不能接续当前资料',
    detail:
      '新版未声明支持当前资料格式或任务状态，不建议更换，原资料和工作保持。',
  },
  link: {
    title: '下载入口未通过校验',
    detail: '下载位置与可信版本不匹配，不提供可打开的链接。',
  },
};
