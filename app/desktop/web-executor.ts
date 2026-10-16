import { utilityProcess } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import type { WebActionJob, BoundObservation } from './execution-service';
import { ExecutionProtocol, type ProtocolClient } from './execution-protocol';
import { actionFailureCodeSchema } from '../shared/execution';

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
  ) {}
  async perform(job: WebActionJob): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const worker = utilityProcess.fork(
        path.join(__dirname, 'executor.cjs'),
        [],
        { env: this.env, stdio: 'ignore', serviceName: 'helpr 单步网页操作' },
      );
      let client: ProtocolClient | undefined,
        ended = false;
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
            outcome.data.done && job.qualified()
              ? undefined
              : Error('EXECUTION_ACTION_UNKNOWN'),
          );
        }
      });
      if (!job.qualified() || job.signal.aborted) {
        cancel();
        return;
      }
      worker.postMessage({ job: job.action });
    });
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
