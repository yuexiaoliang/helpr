import { z } from 'zod';
import { websiteURL } from './url-policy';

export const startupFailureCodeSchema = z.enum([
  'STARTUP_NOT_AUTHORIZED',
  'APPLICATION_IMAGE_REQUIRED',
  'HOST_OWNER_REQUIRED',
  'HOST_PROFILE_REQUIRED',
  'VALIDATION_PROFILE_REQUIRED',
  'RECORDS_UNAVAILABLE',
  'ENOENT',
  'EACCES',
  'MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM',
  'ERR_REQUIRE_ASYNC_MODULE',
  'STARTUP_FAILED',
]);
export const startupFailureSchema = z.strictObject({
  startupFailure: z.strictObject({
    stage: z.enum([
      'image',
      'ownership',
      'application',
      'host-module',
      'controller-init',
      'reopen',
    ]),
    code: startupFailureCodeSchema,
  }),
});
export type StartupStage = z.infer<
  typeof startupFailureSchema
>['startupFailure']['stage'];

const id = z.string().min(1).max(100);
const website = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      websiteURL(value);
      return true;
    } catch {
      return false;
    }
  }, 'URL_DENIED');
const taskFields = {
  requestId: id,
  taskId: id,
  expectedVersion: z.number().int().positive().optional(),
};
const taskCommand = <const K extends string>(kind: K) =>
  z.strictObject({ ...taskFields, kind: z.literal(kind) });
export const recordCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    requestId: id,
    goal: z.string().trim().min(1).max(600),
  }),
  z.strictObject({
    ...taskFields,
    kind: z.literal('message'),
    text: z.string().trim().min(1).max(20000),
  }),
  z.strictObject({
    ...taskFields,
    kind: z.literal('draft'),
    text: z.string().max(20000),
  }),
  z.strictObject({ ...taskFields, kind: z.literal('navigate'), url: website }),
  z.strictObject({
    ...taskFields,
    kind: z.literal('page'),
    url: website,
    phase: z.enum(['loading', 'manual', 'error']),
    error: z
      .enum(['', 'PAGE_LOAD_FAILED', 'NAVIGATION_DENIED', 'PERMISSION_DENIED'])
      .default(''),
  }),
  taskCommand('select'),
  taskCommand('hide-task'),
  taskCommand('minimize'),
]);
export type RecordCommand = z.infer<typeof recordCommandSchema>;
export const taskSchema = z.strictObject({
  id,
  goal: z.string(),
  created: z.number(),
  url: z.string(),
  draft: z.string(),
  hidden: z.boolean(),
  minimized: z.boolean(),
  phase: z.enum(['no-page', 'loading', 'manual', 'error']),
  error: z.string(),
  version: z.number().int(),
  messages: z.array(
    z.strictObject({ role: z.enum(['user', 'system']), text: z.string() }),
  ),
});
export type Task = z.infer<typeof taskSchema>;
export const snapshotSchema = z.strictObject({
  revision: z.number().int(),
  active: id.nullable(),
  tasks: z.array(taskSchema),
});
export type WorkspaceSnapshot = z.infer<typeof snapshotSchema>;
export const panelSchema = z.strictObject({
  kind: z.literal('panel'),
  panel: z.enum(['none', 'new', 'tasks', 'quit', 'preview', 'close-task']),
  taskId: id.optional(),
  x: z.number().min(0).max(10000).optional(),
  focus: z.boolean().optional(),
  delayed: z.boolean().optional(),
});
export const uiCommandSchema = z.union([
  recordCommandSchema.refine((command) => command.kind !== 'page'),
  z.strictObject({ kind: z.literal('snapshot') }),
  z.strictObject({ kind: z.literal('quit') }),
  z.strictObject({ kind: z.literal('hide') }),
  z.strictObject({ kind: z.literal('dismiss-notice') }),
  z.strictObject({ kind: z.literal('cancel-create'), requestId: id }),
  z.strictObject({ kind: z.literal('reload'), taskId: id }),
  panelSchema,
]);
export type UICommand = z.infer<typeof uiCommandSchema>;
export type WorkspaceEvent = {
  state?: WorkspaceSnapshot;
  notice?: string;
  panel?: z.infer<typeof panelSchema>;
};
export type WorkspaceBridge = {
  request: (command: UICommand) => Promise<unknown>;
  subscribe: (listener: (event: WorkspaceEvent) => void) => () => void;
};
export const observationSchema = z.strictObject({
  taskId: id,
  token: z.string(),
  method: z.string().max(100),
});
export const rpcRequestSchema = z.strictObject({
  id: z.number().int().positive(),
  command: z.unknown(),
});
export const rpcResponseSchema = z.strictObject({
  id: z.number().int().positive(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export type RPCReply = z.infer<typeof rpcResponseSchema>;
export function errorCode(error: unknown): string {
  if (error instanceof z.ZodError) return 'INVALID_REQUEST';
  if (error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message))
    return error.message;
  return 'RECORDS_UNAVAILABLE';
}
