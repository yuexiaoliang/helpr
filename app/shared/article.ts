import { z } from 'zod';

export const EXCEL_PARSER = 'sheetjs-ce@0.20.3';
export const ARTICLE_PROMPT_VERSION = 'excel-article-v1';
export const excelCellSchema = z.strictObject({
  address: z.string().regex(/^[A-Z]+[1-9][0-9]*$/),
  type: z.string().max(20),
  raw: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  display: z.string().max(4000),
  format: z.string().max(1000),
  formula: z.string().max(4000).nullable(),
  status: z.enum([
    'value',
    'blank',
    'formula-unverified',
    'error',
    'date-invalid',
    'hidden',
    'merged',
  ]),
  master: z.string().nullable(),
});
export const excelDataSchema = z.strictObject({
  parser: z.literal(EXCEL_PARSER),
  dateSystem: z.enum(['1900', '1904']),
  recalculated: z.literal(false),
  sheets: z
    .array(
      z.strictObject({
        name: z.string().max(100),
        hidden: z.boolean(),
        cells: z.array(excelCellSchema).max(2000),
      }),
    )
    .max(20),
  notices: z.array(z.string().max(2000)).max(20),
});
export type ExcelData = z.infer<typeof excelDataSchema>;
export const contentSourceSchema = excelDataSchema.extend({
  id: z.string().uuid(),
  materialId: z.string().uuid(),
  materialSha256: z.string().regex(/^[a-f0-9]{64}$/),
  goalVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  requirements: z.strictObject({
    id: z.string().uuid(),
    goal: z.string(),
    answers: z.array(
      z.strictObject({ questionId: z.string().uuid(), text: z.string() }),
    ),
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ContentSource = z.infer<typeof contentSourceSchema>;
export const contentRequestText = (source: ContentSource) =>
  `${ARTICLE_PROMPT_VERSION}\n${source.id}\n${source.sha256}\n${source.requirements.id}`;
export const citationSchema = z.strictObject({
  sheet: z.string().max(100),
  address: excelCellSchema.shape.address,
  quote: z.string().min(1).max(4000),
});
export const articleDraftSchema = z.strictObject({
  destination: z.string().trim().min(1).max(600),
  // 每段包含标题或正文；非素材事实须明确作为建议，不能混入来源核对。
  blocks: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(4000),
        kind: z.enum(['fact', 'suggestion']),
        citations: z.array(citationSchema).max(30),
      }),
    )
    .min(1)
    .max(30),
});
export type ArticleDraft = z.infer<typeof articleDraftSchema>;
export const articleVersionSchema = articleDraftSchema.extend({
  blocks: z.array(articleDraftSchema.shape.blocks.element).max(30),
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  sourceId: z.string().uuid(),
  goalVersion: z.number().int().positive(),
  content: z.string().min(1).max(4000),
  author: z.enum(['model', 'user']),
  modelCallId: z.string().nullable(),
  promptVersion: z.literal(ARTICLE_PROMPT_VERSION),
  createdAt: z.number().int().nonnegative(),
});
export type ArticleVersion = z.infer<typeof articleVersionSchema>;
export const articleText = (draft: ArticleDraft) =>
  draft.blocks
    .map((b) => (b.kind === 'suggestion' ? `建议：${b.text}` : b.text))
    .join('\n\n');

export const excelFailureMessage: Record<string, string> = {
  EXCEL_UNSUPPORTED:
    '当前可读取未加密的 .xlsx 工作簿；旧版 .xls、宏文件、CSV、外部数据连接及加密文件暂不支持。请另存为普通 .xlsx 后重新委托。',
  EXCEL_LIMIT:
    '表格超过本次读取范围（解压后 16 MiB、20 张表、合计 2000 个单元格、每表 2000 行和 100 列）。没有截断内容生成文章，请提供较小的工作簿。',
  EXCEL_INVALID:
    '这份固定素材无法完整解析，未据此生成内容。请检查文件是否损坏或另存为普通 .xlsx 后重新委托。',
  ARTICLE_FACT_INVALID:
    '文章建议中的来源或数字无法核对，尚未进入发布预览。请补充内容要求或明确排除不确定的单元格后继续。',
};
