import { z } from 'zod';

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
