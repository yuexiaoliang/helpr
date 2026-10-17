import { z } from 'zod';

const point = z.enum([
  'records-before',
  'records-after',
  'suspension',
  'input',
  'recovery',
]);
const command = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('arm'),
    point,
    taskId: z.string().min(1).max(100),
  }),
  z.strictObject({
    action: z.literal('release'),
    point,
    taskId: z.string().min(1).max(100),
  }),
  z.strictObject({ action: z.literal('status') }),
]);
type Point = z.infer<typeof point>;
/** 仅继承父通道的验证模式创建。只延迟真实消息，不生成意图或执行资格。 */
export class ValidationBarriers {
  private readonly waits = new Map<
    string,
    { reached: boolean; release: () => void; promise: Promise<void> }
  >();
  private readonly history: {
    point: Point;
    taskId: string;
    stage: string;
    at: number;
  }[] = [];
  control(input: unknown) {
    const job = command.parse(input);
    if (job.action !== 'status') {
      const key = job.point + ':' + job.taskId;
      if (job.action === 'arm') {
        if (
          this.waits.has(key) ||
          this.history.length >= 200 ||
          this.waits.size >= 16
        )
          throw Error('VALIDATION_BARRIER_LIMIT');
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.waits.set(key, { reached: false, release, promise });
      } else {
        const wait = this.waits.get(key);
        if (!wait?.reached) throw Error('VALIDATION_BARRIER_NOT_REACHED');
        this.history.push({
          point: job.point,
          taskId: job.taskId,
          stage: 'released',
          at: Date.now(),
        });
        this.waits.delete(key);
        wait.release();
      }
    }
    return {
      waits: [...this.waits].map(([key, wait]) => ({
        key,
        reached: wait.reached,
      })),
      history: [...this.history],
    };
  }
  async pass(point: Point, taskId: string) {
    const wait = this.waits.get(point + ':' + taskId);
    if (!wait) return;
    if (wait.reached) throw Error('VALIDATION_BARRIER_REUSED');
    wait.reached = true;
    this.history.push({ point, taskId, stage: 'reached', at: Date.now() });
    await wait.promise;
  }
}
