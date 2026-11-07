import { z } from 'zod';

const epoch = z.number().int().nonnegative();
const url = z.url().max(4096);
export const blockReceiptSchema = z.strictObject({
  requestId: z.string().min(1),
  before: epoch,
  after: epoch,
});
export const formRequestChainSchema = z.strictObject({
  requestId: z.string().min(1),
  loaderId: z.string().min(1),
  frameId: z.string().min(1),
  sessionId: z.string().min(1),
  requests: z
    .array(
      z.strictObject({
        url,
        method: z.enum(['POST', 'GET']),
        redirectStatus: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(9),
  finalUrl: url,
  status: z.number().int().min(200).max(299),
});
export type FormRequestChain = z.infer<typeof formRequestChainSchema>;
export const hostFormChainSchema = z.strictObject({
  navigationId: z.string().uuid(),
  targetId: z.string().min(1),
  generation: epoch,
  events: z
    .array(
      blockReceiptSchema.extend({
        kind: z.enum(['start', 'redirect']),
        url,
      }),
    )
    .min(1)
    .max(9),
});
export type HostFormChain = z.infer<typeof hostFormChainSchema>;
export const formChainResolutionSchema = z.strictObject({
  host: hostFormChainSchema,
  control: z.array(blockReceiptSchema).min(1).max(9),
});
export type FormChainResolution = z.infer<typeof formChainResolutionSchema>;
export function validFormRequestChain(
  chain: FormRequestChain,
  source: string,
  requested: string,
) {
  return (
    chain.requests[0]?.url === requested &&
    chain.requests[0].method === 'POST' &&
    chain.requests[0].redirectStatus === undefined &&
    chain.finalUrl === chain.requests.at(-1)?.url &&
    chain.requests.every((r, i) => {
      const u = new URL(r.url);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        u.origin === new URL(source).origin &&
        !u.hash &&
        !u.username &&
        !u.password &&
        u.href === r.url &&
        (i === 0 ||
          (r.method === 'GET' &&
            (i === 1
              ? r.redirectStatus === 303
              : [301, 302, 303, 307, 308].includes(r.redirectStatus ?? 0))))
      );
    })
  );
}
/** 每个原生代次必须有唯一、恰好+1的撤权回执，且回执属于逐项匹配的宿主导航。 */
export function formChainEpoch(
  chain: FormRequestChain,
  evidence: FormChainResolution,
  navigation: {
    id: string;
    targetId: string;
    generation: number;
    inputEpoch: number;
  },
): number | undefined {
  const { host, control } = evidence;
  if (
    host.navigationId !== navigation.id ||
    host.targetId !== navigation.targetId ||
    host.generation !== navigation.generation ||
    host.events.length !== chain.requests.length ||
    !host.events.every(
      (e, i) =>
        e.kind === (i === 0 ? 'start' : 'redirect') &&
        e.url === chain.requests[i]?.url,
    ) ||
    host.events[0]?.before !== navigation.inputEpoch ||
    !host.events.every(
      (e, i) => i === 0 || e.before > host.events[i - 1]!.before,
    ) ||
    new Set(host.events.map((e) => e.requestId)).size !== host.events.length ||
    new Set(control.map((e) => e.requestId)).size !== control.length ||
    !control.some((e) => e.requestId === host.events[0]?.requestId) ||
    !control.every((e) =>
      host.events.some(
        (h) => h.requestId === e.requestId && e.before >= h.after,
      ),
    )
  )
    return;
  const all = [...host.events, ...control].sort((a, b) => a.before - b.before);
  let expected = navigation.inputEpoch;
  for (const e of all) {
    if (e.before !== expected || e.after !== expected + 1) return;
    expected = e.after;
  }
  return expected;
}
