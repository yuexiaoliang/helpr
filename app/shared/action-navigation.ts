import { z } from 'zod';
import { pageSourceSchema } from './model';
import type { WebAction } from './web-action';

// 时间相关的审计事实，不能用作动作已成功、目标归属或自动恢复的证明。
export const actionNavigationSchema = z
  .strictObject({
    id: z.string().uuid(),
    association: z.literal('during-action'),
    targetId: z.string().min(1),
    sourceGeneration: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    url: z.url().max(4096),
    mainFrame: z.boolean(),
    sameDocument: z.boolean(),
    inputEpoch: z.number().int().nonnegative(),
    observedAt: z.number().int().nonnegative(),
  })
  .refine((n) => n.generation === n.sourceGeneration + 1);
export type ActionNavigation = z.infer<typeof actionNavigationSchema>;
export const actionNavigationEventSchema = z.strictObject({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  navigation: actionNavigationSchema,
});
export type ActionNavigationEvent = z.infer<typeof actionNavigationEventSchema>;

// Chromium 的请求原因与受管鼠标发送共同提供链接导航依据；仍须核对新页面。
export const linkNavigationProofSchema = z.strictObject({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  targetId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  inputEpoch: z.number().int().nonnegative(),
  reason: z.literal('anchorClick'),
  url: z.url().max(4096),
  requestedAt: z.number().int().nonnegative(),
});
export type LinkNavigationProof = z.infer<typeof linkNavigationProofSchema>;
export const linkNavigationResolutionSchema = z.strictObject({
  proof: linkNavigationProofSchema,
  source: pageSourceSchema,
  pausedInputEpoch: z.number().int().nonnegative(),
});
/** 只接受完整观察中主frame、精确且唯一的同站链接；模型不能直接指定放行URL。 */
export function expectedNavigationLink(
  action: WebAction,
  source: { url: string; truncated: boolean },
  links: readonly { name: string; url: string }[] = [],
): string | undefined {
  if (
    source.truncated ||
    action.kind !== 'click' ||
    action.target.role !== 'link' ||
    !action.target.exact ||
    action.target.within ||
    (action.target.frameUrl && action.target.frameUrl !== source.url)
  )
    return;
  const matches = links.filter((l) => l.name === action.target.name);
  if (matches.length !== 1) return;
  try {
    const url = new URL(matches[0]!.url),
      origin = new URL(source.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.href === origin.href ||
      url.hash
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
