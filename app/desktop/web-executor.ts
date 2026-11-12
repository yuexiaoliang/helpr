import { richTextControl } from '../shared/rich-text';
import { richTextLines } from './rich-text-input';
import { utilityProcess } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import type { WebActionJob, BoundObservation } from './execution-service';
import { ExecutionProtocol, type ProtocolClient } from './execution-protocol';
import { actionFailureCodeSchema } from '../shared/execution';
import { materialPayloadSchema } from '../shared/material';
import { expectedNavigationLink } from '../shared/action-navigation';
import { actionLandmark } from '../shared/web-action';

/** 每次启动的工作者只持有一个动作；取消撤销通道并结束工作者，不关闭用户网页。 */
export class WebExecutor {
  private readonly active = new Map<
    string,
    { worker: ReturnType<typeof utilityProcess.fork>; client: ProtocolClient }
  >();
  constructor(
    private readonly protocol: ExecutionProtocol,
    private readonly observe: (
      taskId: string,
      signal: AbortSignal,
    ) => Promise<BoundObservation>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly failure: (taskId: string, code: string) => void,
    private readonly ownsProcess?: (pid: number | undefined) => boolean,
    private readonly material?: (command: unknown) => Promise<unknown>,
    private readonly actionWindow?: (command: unknown) => Promise<unknown>,
    private readonly watchNavigation?: (job: WebActionJob) => Promise<void>,
  ) {}
  async perform(job: WebActionJob): Promise<void> {
    if (!job.qualified() || job.signal.aborted)
      throw Error('EXECUTION_STOPPED');
    const payload =
      job.action.kind === 'upload'
        ? materialPayloadSchema.parse(
            await this.material?.({
              kind: 'payload',
              taskId: job.taskId,
              runId: job.runId,
              actionId: job.actionId,
            }),
          )
        : undefined;
    if (!job.qualified() || job.signal.aborted)
      throw Error('EXECUTION_STOPPED');
    const current = await this.observe(job.taskId, job.signal);
    if (!job.qualified() || job.signal.aborted)
      throw Error('EXECUTION_STOPPED');
    if (
      current.binding.targetId !== job.binding.targetId ||
      current.binding.generation !== job.binding.generation ||
      current.observation.fingerprint !== job.source.fingerprint
    )
      throw Error('EXECUTION_PAGE_CHANGED');
    const landmark = actionLandmark(job.action);
    const landmarkHref = landmark
      ? expectedNavigationLink(job.action, job.source, job.source.links)
      : undefined;
    if (
      landmark &&
      (!landmarkHref ||
        expectedNavigationLink(
          job.action,
          current.observation,
          current.observation.links,
        ) !== landmarkHref)
    )
      throw Error('EXECUTION_PAGE_CHANGED');
    const richSource = richTextControl(job.action, current.observation);
    const richText = !!richSource;
    const prefixes =
      richText && job.action.kind === 'fill'
        ? richTextLines(job.action.value).map((_, i, lines) =>
            lines.slice(0, i + 1).join('\n'),
          )
        : [];
    const richTextInitial =
      richText && 'richTextNodeId' in job.action.target
        ? richSource.textValue
        : undefined;
    if (richTextInitial !== undefined) prefixes.unshift(richTextInitial);
    try {
      await this.watchNavigation?.(job);
      await this.actionWindow?.({
        kind: 'action-window-arm',
        taskId: job.taskId,
        actionId: job.actionId,
        runId: job.runId,
        ...job.binding,
      });
      if (!job.qualified() || job.signal.aborted)
        throw Error('EXECUTION_STOPPED');
      await new Promise<void>((resolve, reject) => {
        const worker = utilityProcess.fork(
          path.join(__dirname, 'executor.cjs'),
          [],
          { env: this.env, stdio: 'ignore', serviceName: 'helpr 单步网页操作' },
        );
        let client: ProtocolClient | undefined,
          ended = false;
        let checkpointIndex = 0;
        let checking = false;
        const cleanup = () => {
          clearTimeout(timer);
          job.signal.removeEventListener('abort', cancel);
          if (client) this.protocol.close(client);
          else worker.kill();
          this.active.delete(job.taskId);
        };
        const finish = (error?: Error) => {
          if (ended) return;
          ended = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(Error('EXECUTION_STOPPED'));
        const timer = setTimeout(
          () => finish(Error('EXECUTION_ACTION_UNKNOWN')),
          16000,
        );
        try {
          client = this.protocol.open(
            job.taskId,
            job.binding,
            job.qualified,
            (packet) => worker.postMessage({ protocol: packet }),
            () => {
              worker.kill();
            },
          );
        } catch {
          finish(Error('EXECUTION_PAGE_CHANGED'));
          return;
        }
        this.active.set(job.taskId, { worker, client });
        job.signal.addEventListener('abort', cancel, { once: true });
        worker.once('exit', () => finish(Error('EXECUTION_ACTION_UNKNOWN')));
        worker.on('message', (input: unknown) => {
          if (ended) return;
          const check = z
            .object({
              richTextCheck: z.object({
                id: z.number().int(),
                expected: z.string(),
              }),
            })
            .safeParse(input);
          if (check.success) {
            const { id, expected } = check.data.richTextCheck;
            if (
              checking ||
              id !== checkpointIndex + 1 ||
              expected !== prefixes[checkpointIndex]
            ) {
              finish(Error('EXECUTION_ACTION_UNKNOWN'));
              return;
            }
            checking = true;
            void (async () => {
              if (ended || !job.qualified() || job.signal.aborted)
                throw Error('EXECUTION_STOPPED');
              const next = await this.observe(job.taskId, job.signal);
              const control = richTextControl(
                job.action,
                next.observation,
                true,
              )!;
              if (
                ended ||
                !job.qualified() ||
                job.signal.aborted ||
                next.binding.targetId !== job.binding.targetId ||
                next.binding.generation !== job.binding.generation ||
                next.observation.url !== job.source.url ||
                JSON.stringify(next.session) !==
                  JSON.stringify(current.session) ||
                control.richText?.backendNodeId !==
                  richSource?.richText?.backendNodeId ||
                control.textValue !== expected
              )
                throw Error('EXECUTION_ACTION_UNKNOWN');
              checkpointIndex++;
              checking = false;
              worker.postMessage({ richTextChecked: id });
            })().catch(() => finish(Error('EXECUTION_ACTION_UNKNOWN')));
            return;
          }
          const protocol = z.object({ protocol: z.unknown() }).safeParse(input);
          if (protocol.success && client) {
            void this.protocol.command(client, protocol.data.protocol);
            return;
          }
          const outcome = z
            .object({
              done: z.boolean().optional(),
              failed: z.boolean().optional(),
              code: actionFailureCodeSchema.optional(),
            })
            .safeParse(input);
          if (outcome.success && (outcome.data.done || outcome.data.failed)) {
            if (outcome.data.failed)
              this.failure(
                job.taskId,
                outcome.data.code ?? 'EXECUTION_ACTION_UNKNOWN',
              );
            finish(
              outcome.data.done &&
                job.qualified() &&
                !checking &&
                checkpointIndex === prefixes.length
                ? undefined
                : Error('EXECUTION_ACTION_UNKNOWN'),
            );
          }
        });
        if (!job.qualified() || job.signal.aborted) {
          cancel();
          return;
        }
        worker.once('spawn', () => {
          if (ended) return;
          if (this.ownsProcess && !this.ownsProcess(worker.pid)) {
            finish(Error('RUNTIME_GROUP_UNAVAILABLE'));
            return;
          }
          worker.postMessage({
            job: job.action,
            payload,
            richText,
            richTextInitial,
            landmarkHref,
          });
        });
      });
    } finally {
      await this.actionWindow?.({
        kind: 'action-window-disarm',
        taskId: job.taskId,
        actionId: job.actionId,
      });
    }
  }
  revoke(taskId: string) {
    const active = this.active.get(taskId);
    if (active) this.protocol.close(active.client);
    this.protocol.revoke(taskId);
  }
  dispose() {
    for (const taskId of this.active.keys()) this.revoke(taskId);
    this.protocol.dispose();
  }
}
