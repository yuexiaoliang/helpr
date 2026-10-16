import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { observationSchema } from '../shared/contracts';

const methods = new Set([
  'Page.getFrameTree',
  'Page.captureScreenshot',
  'DOMSnapshot.captureSnapshot',
  'Accessibility.getFullAXTree',
]);
const replySchema = z.object({
  id: z.number(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
});
export type Qualification = {
  taskId: string;
  targetId: string;
  generation: number;
  token: string;
  revoked: boolean;
  sessionId?: string;
};
export class ObservationBroker {
  private sequence = 0;
  private closed = false;
  private buffer = '';
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly targets = new Map<
    string,
    { targetId: string; generation: number }
  >();
  private readonly clients = new Set<Qualification>();
  private readonly input: Writable;
  private readonly listeners = new Set<(message: unknown) => void>();
  constructor(host: ChildProcess) {
    this.input = host.stdio[3] as Writable;
    const output = host.stdio[4] as Readable;
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
        this.dispose();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!raw) continue;
        try {
          const decoded: unknown = JSON.parse(raw);
          if (typeof decoded === 'object' && decoded && 'method' in decoded)
            for (const listener of this.listeners) listener(decoded);
          const message = replySchema.safeParse(decoded);
          if (!message.success) continue;
          const p = this.pending.get(message.data.id);
          if (p) {
            this.pending.delete(message.data.id);
            clearTimeout(p.timer);
            if (message.data.error) p.reject(new Error('OBSERVATION_FAILED'));
            else p.resolve(message.data.result ?? {});
          }
        } catch {
          this.dispose();
          return;
        }
      }
    });
    this.input.on('error', () => this.dispose());
    output.on('close', () => this.dispose());
  }
  register(taskId: string, targetId: string, generation: number): void {
    this.targets.set(taskId, { targetId, generation });
  }
  unregister(taskId: string): void {
    this.targets.delete(taskId);
    for (const c of this.clients) if (c.taskId === taskId) c.revoked = true;
  }
  client(taskId: string): Qualification {
    const binding = this.targets.get(taskId);
    if (!binding) throw new Error('PAGE_NOT_AVAILABLE');
    const client = {
      taskId,
      ...binding,
      token: randomBytes(32).toString('hex'),
      revoked: false,
    };
    this.clients.add(client);
    return client;
  }
  owns(client: Qualification): boolean {
    return this.valid(client, client.token);
  }
  onEvent(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** 仅控制拥有者使用；不向网页或UI暴露原始协议入口。 */
  protocol(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) {
    return this.send(method, params, sessionId);
  }
  private valid(client: Qualification, token: string): boolean {
    const current = this.targets.get(client.taskId);
    return (
      !client.revoked &&
      token === client.token &&
      current?.targetId === client.targetId &&
      current.generation === client.generation
    );
  }
  private send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('CONTROL_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OBSERVATION_TIMEOUT'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + '\0',
        (error) => {
          if (error) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error('CONTROL_DISCONNECTED'));
          }
        },
      );
    });
  }
  async observe(
    client: Qualification,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const request = observationSchema.parse(input);
    if (!this.valid(client, request.token))
      throw new Error('OBSERVATION_NOT_AUTHORIZED');
    if (request.taskId !== client.taskId) throw new Error('TASK_NOT_OWNED');
    if (!methods.has(request.method))
      throw new Error('OBSERVATION_CAPABILITY_DENIED');
    if (!client.sessionId)
      client.sessionId = z.string().parse(
        (
          await this.send('Target.attachToTarget', {
            targetId: client.targetId,
            flatten: true,
          })
        ).sessionId,
      );
    if (!this.valid(client, request.token))
      throw new Error('OBSERVATION_NOT_AUTHORIZED');
    const params =
      request.method === 'Page.captureScreenshot'
        ? { format: 'png', captureBeyondViewport: false }
        : request.method === 'DOMSnapshot.captureSnapshot'
          ? { computedStyles: [] }
          : {};
    const result = await this.send(request.method, params, client.sessionId);
    if (!this.valid(client, request.token))
      throw new Error('STALE_OBSERVATION');
    return result;
  }
  async close(client: Qualification): Promise<void> {
    client.revoked = true;
    this.clients.delete(client);
    if (client.sessionId && !this.closed)
      await this.send('Target.detachFromTarget', {
        sessionId: client.sessionId,
      }).catch(() => {});
  }
  dispose(): void {
    this.closed = true;
    for (const c of this.clients) c.revoked = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CONTROL_DISCONNECTED'));
    }
    this.pending.clear();
    this.targets.clear();
  }
}
