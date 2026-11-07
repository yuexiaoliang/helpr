import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { observationSchema } from '../shared/contracts';
import type { InputGate } from './input-gate';

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
  inputEpoch: number;
  sessionId?: string;
  frames?: Set<string>;
};
export class ObservationBroker {
  private sequence = 0;
  private closed = false;
  private buffer = '';
  private reading = false;
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
  private readonly inputListeners = new Set<
    (
      client: Qualification,
      method: string,
      params: Record<string, unknown>,
    ) => void
  >();
  onInputSent(
    listener: (
      client: Qualification,
      method: string,
      params: Record<string, unknown>,
    ) => void,
  ) {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }
  private readonly disconnectListeners = new Set<() => void>();
  constructor(
    host: ChildProcess,
    private readonly inputGate?: Pick<InputGate, 'state' | 'permit'>,
    private readonly beforeInput?: (taskId: string) => Promise<void>,
  ) {
    this.input = host.stdio[3] as Writable;
    const output = host.stdio[4] as Readable;
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
        this.dispose();
        return;
      }
      if (!this.reading) void this.readPackets();
    });
    this.input.on('error', () => this.dispose());
    output.on('close', () => this.dispose());
  }
  /** 每条消息之间交还事件循环，让前一响应的 Promise 转接完成后再交付后续事件。
   * 同一 pipe 数据块里同步发事件会越过响应，令工作者在 frame 登记前丢掉主世界。
   */
  private async readPackets() {
    this.reading = true;
    try {
      while (!this.closed) {
        const end = this.buffer.indexOf('\0');
        if (end < 0) break;
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!raw) continue;
        const decoded: unknown = JSON.parse(raw);
        if (typeof decoded === 'object' && decoded && 'method' in decoded)
          for (const listener of this.listeners) listener(decoded);
        const message = replySchema.safeParse(decoded);
        if (message.success) {
          const p = this.pending.get(message.data.id);
          if (p) {
            this.pending.delete(message.data.id);
            clearTimeout(p.timer);
            if (message.data.error) p.reject(new Error('OBSERVATION_FAILED'));
            else p.resolve(message.data.result ?? {});
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch {
      this.dispose();
    } finally {
      this.reading = false;
    }
  }
  register(taskId: string, targetId: string, generation: number): void {
    if (this.closed) return;
    this.targets.set(taskId, { targetId, generation });
  }
  unregister(taskId: string): void {
    this.targets.delete(taskId);
    for (const c of this.clients) if (c.taskId === taskId) c.revoked = true;
  }
  client(taskId: string): Qualification {
    if (this.closed) throw Error('CONTROL_DISCONNECTED');
    const binding = this.targets.get(taskId);
    if (!binding) throw new Error('PAGE_NOT_AVAILABLE');
    const client = {
      taskId,
      ...binding,
      token: randomBytes(32).toString('hex'),
      revoked: false,
      inputEpoch: this.inputGate?.state(taskId).epoch ?? 0,
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
  available(taskId: string) {
    return !this.closed && this.targets.has(taskId);
  }
  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  /** 仅控制拥有者使用；不向网页或UI暴露原始协议入口。 */
  protocol(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    qualification?: Qualification,
  ) {
    if (qualification && method.startsWith('Input.') && this.beforeInput)
      return this.beforeInput(qualification.taskId).then(() =>
        this.send(method, params, sessionId, qualification),
      );
    return this.send(method, params, sessionId, qualification);
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
    qualification?: Qualification,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('CONTROL_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OBSERVATION_TIMEOUT'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      const send = () => {
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
        if (qualification && method.startsWith('Input.'))
          for (const listener of this.inputListeners)
            listener(qualification, method, params);
      };
      try {
        if (qualification && this.inputGate)
          this.inputGate.permit(
            qualification.taskId,
            qualification.inputEpoch,
            send,
          );
        else send();
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(Error('EXECUTION_STOPPED'));
      }
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
    if (
      request.frameId &&
      (request.method !== 'Accessibility.getFullAXTree' ||
        !client.frames?.has(request.frameId))
    )
      throw Error('FRAME_NOT_OWNED');
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
          : request.frameId
            ? { frameId: request.frameId }
            : {};
    const result = await this.send(request.method, params, client.sessionId);
    if (request.method === 'Page.getFrameTree') {
      client.frames = new Set();
      const learn = (input: unknown) => {
        const node = z
          .object({
            frame: z.object({ id: z.string() }),
            childFrames: z.array(z.unknown()).optional(),
          })
          .parse(input);
        client.frames!.add(node.frame.id);
        node.childFrames?.forEach(learn);
      };
      learn(result.frameTree);
    }
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
    if (this.closed) return;
    this.closed = true;
    this.buffer = '';
    for (const c of this.clients) c.revoked = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CONTROL_DISCONNECTED'));
    }
    this.pending.clear();
    this.targets.clear();
    for (const listener of this.disconnectListeners) listener();
    this.disconnectListeners.clear();
  }
}
