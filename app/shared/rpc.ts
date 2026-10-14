import { rpcResponseSchema, type RPCReply } from './contracts';

export interface ProcessChannel {
  send: (message: unknown) => void;
  listen: (listener: (message: unknown) => void) => void;
  onExit: (listener: () => void) => void;
}
export class ProcessClient {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly channel: ProcessChannel) {
    channel.listen((message) => {
      const parsed = rpcResponseSchema.safeParse(message);
      if (parsed.success) this.receive(parsed.data);
    });
    channel.onExit(() => this.disconnect());
  }
  private receive(reply: RPCReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(reply.error));
    else pending.resolve(reply.value);
  }
  request(command: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('PROCESS_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('REQUEST_TIMEOUT'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.send({ id, command });
      } catch {
        this.disconnect();
      }
    });
  }
  disconnect(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('PROCESS_DISCONNECTED'));
    }
    this.pending.clear();
  }
}
