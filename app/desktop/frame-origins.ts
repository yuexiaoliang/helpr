import { z } from 'zod';

/** 宿主读取WebFrameMain原生属性；不运行网页脚本、不接受网页上报来源。 */
export const frameOriginsSchema = z.strictObject({
  targetId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  frames: z
    .array(
      z.strictObject({
        id: z.number().int().nonnegative(),
        parentId: z.number().int().nonnegative().nullable(),
        token: z.string().min(1),
        processId: z.number().int().nonnegative(),
        url: z.string(),
        origin: z.string(),
        detached: z.boolean(),
      }),
    )
    .min(1)
    .max(128),
});

export function frameOriginMatches(
  raw: unknown,
  url: string,
  parentUrl: string | undefined,
  origin: string,
): boolean {
  const parsed = frameOriginsSchema.safeParse(raw);
  if (!parsed.success) return false;
  const { frames } = parsed.data;
  if (
    new Set(frames.map((f) => f.id)).size !== frames.length ||
    new Set(frames.map((f) => `${f.processId}:${f.token}`)).size !==
      frames.length
  )
    return false;
  const matches = frames.filter((f) => f.url === url);
  if (matches.length !== 1) return false;
  const frame = matches[0]!;
  if (frame.detached || frame.origin !== origin) return false;
  if (parentUrl === undefined) return frame.parentId === null;
  const parents = frames.filter((f) => f.url === parentUrl);
  return (
    parents.length === 1 &&
    !parents[0]!.detached &&
    frame.parentId === parents[0]!.id
  );
}
