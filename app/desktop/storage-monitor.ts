import { z } from 'zod';
import type { ObservationBroker } from './observation-broker';

/** 控制拥有者独占的只读变化通知。只传播来源，不保存键、值或数据库内容。 */
export class StorageMonitor {
  private readonly targets = new Map<
    string,
    {
      targetId: string;
      origin: string;
      sessionId?: string;
      ready: Promise<void>;
    }
  >();
  constructor(
    private readonly broker: Pick<
      ObservationBroker,
      'client' | 'close' | 'protocol' | 'onEvent'
    >,
    private readonly changed: (origin: string) => void,
  ) {
    broker.onEvent((input) => {
      const event = z
        .object({
          method: z.string(),
          sessionId: z.string(),
          params: z.object({
            origin: z.string().optional(),
            storageId: z
              .object({
                securityOrigin: z.string().optional(),
                isLocalStorage: z.boolean(),
              })
              .optional(),
          }),
        })
        .safeParse(input);
      if (!event.success) return;
      const { method, sessionId, params } = event.data;
      const owner = [...this.targets.values()].find(
        (t) => t.sessionId === sessionId,
      );
      if (!owner) return;
      if (
        method.startsWith('DOMStorage.domStorage') &&
        params.storageId?.isLocalStorage
      ) {
        // 嵌入网页的共享存储也可能影响所属任务；缺身份不推断无影响。
        this.changed(owner.origin);
        if (
          params.storageId.securityOrigin &&
          params.storageId.securityOrigin !== owner.origin
        )
          this.changed(params.storageId.securityOrigin);
      } else if (
        [
          'Storage.indexedDBContentUpdated',
          'Storage.indexedDBListUpdated',
        ].includes(method)
      )
        this.changed(owner.origin);
    });
  }
  async ensure(taskId: string, origin: string) {
    const qualification = this.broker.client(taskId);
    const previous = this.targets.get(taskId);
    if (
      previous?.targetId === qualification.targetId &&
      previous.origin === origin
    ) {
      await this.broker.close(qualification);
      return previous.ready;
    }
    if (previous?.sessionId)
      await this.broker
        .protocol('Target.detachFromTarget', { sessionId: previous.sessionId })
        .catch(() => {});
    const entry: {
      targetId: string;
      origin: string;
      sessionId?: string;
      ready: Promise<void>;
    } = {
      targetId: qualification.targetId,
      origin,
      ready: Promise.resolve(),
    };
    this.targets.set(taskId, entry);
    entry.ready = (async () => {
      const attached = await this.broker.protocol('Target.attachToTarget', {
        targetId: entry.targetId,
        flatten: true,
      });
      entry.sessionId = z
        .object({ sessionId: z.string() })
        .parse(attached).sessionId;
      await this.broker.protocol('DOMStorage.enable', {}, entry.sessionId);
      await this.broker.protocol(
        'Storage.trackIndexedDBForOrigin',
        { origin },
        entry.sessionId,
      );
    })();
    await this.broker.close(qualification);
    return entry.ready;
  }
}
