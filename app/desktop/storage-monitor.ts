import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ObservationBroker } from './observation-broker';

function onlyBlockUsageChanged(
  oldValue: string | undefined,
  newValue: string,
): boolean {
  try {
    const parse = (value: string) => {
      if (value.length > 20000) throw Error('PREFERENCE_TOO_LARGE');
      const data = z.record(z.string(), z.unknown()).parse(JSON.parse(value));
      const editor = z
        .record(z.string(), z.unknown())
        .parse(data['core/block-editor']);
      const preferences = z
        .record(z.string(), z.unknown())
        .parse(editor.preferences);
      const usage = z
        .record(
          z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
          z.strictObject({
            time: z.number().nonnegative(),
            count: z.number().int().positive(),
          }),
        )
        .parse(preferences.insertUsage);
      delete preferences.insertUsage;
      editor.preferences = preferences;
      data['core/block-editor'] = editor;
      return { usage, rest: JSON.stringify(data) };
    };
    const after = parse(newValue);
    const before =
      oldValue === undefined
        ? {
            usage: {} as typeof after.usage,
            rest: '{"core/block-editor":{"preferences":{}}}',
          }
        : parse(oldValue);
    if (before.rest !== after.rest) return false;
    const changed = Object.keys(after.usage).filter((key) => {
      const previous = before.usage[key],
        current = after.usage[key]!;
      return (
        !previous ||
        current.count !== previous.count ||
        current.time !== previous.time
      );
    });
    if (
      changed.length !== 1 ||
      !Object.keys(before.usage).every((key) => Object.hasOwn(after.usage, key))
    )
      return false;
    const key = changed[0]!,
      previous = before.usage[key],
      current = after.usage[key]!;
    return (
      current.count === (previous?.count ?? 0) + 1 &&
      current.time >= (previous?.time ?? 0)
    );
  } catch {
    return false;
  }
}

const editorPreferencesSchema = z.looseObject({
  _modified: z.iso.datetime(),
  core: z
    .looseObject({
      isComplementaryAreaVisible: z.boolean().optional(),
      openPanels: z.array(z.string().regex(/^[a-z0-9_-]{1,100}$/)).optional(),
    })
    .optional(),
});

const initialEditorPreferencesSchema = z.strictObject({
  core: z.strictObject({}),
  'core/edit-post': z
    .strictObject({ welcomeGuide: z.boolean().optional() })
    .optional(),
});

function onlyEditorPanelsChanged(
  oldValue: string | undefined,
  newValue: string,
) {
  try {
    const parse = (value: string) => {
      if (value.length > 20000) throw Error('PREFERENCE_TOO_LARGE');
      const { _modified, core, ...preferences } = editorPreferencesSchema.parse(
        JSON.parse(value),
      );
      const { isComplementaryAreaVisible, openPanels, ...rest } = core ?? {};
      return {
        modified: Date.parse(_modified),
        layout: { isComplementaryAreaVisible, openPanels },
        preferences: { ...preferences, core: rest },
      };
    };
    const after = parse(newValue);
    if (oldValue === undefined)
      return (
        (after.layout.isComplementaryAreaVisible !== undefined ||
          after.layout.openPanels !== undefined) &&
        initialEditorPreferencesSchema.safeParse(after.preferences).success
      );
    const before = parse(oldValue);
    return (
      after.modified >= before.modified &&
      !isDeepStrictEqual(before.layout, after.layout) &&
      isDeepStrictEqual(before.preferences, after.preferences)
    );
  } catch {
    return false;
  }
}

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
            key: z.string().optional(),
            oldValue: z.string().optional(),
            newValue: z.string().optional(),
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
        // WordPress 的区块推荐计数及编辑器面板布局只影响界面。
        if (
          ((method === 'DOMStorage.domStorageItemUpdated' &&
            params.oldValue !== undefined) ||
            method === 'DOMStorage.domStorageItemAdded') &&
          params.storageId.securityOrigin === owner.origin &&
          params.newValue
        ) {
          const before =
            method === 'DOMStorage.domStorageItemAdded'
              ? undefined
              : params.oldValue;
          const key = params.key ?? '';
          if (
            (/^WP_DATA_USER_[1-9]\d*$/.test(key) &&
              onlyBlockUsageChanged(before, params.newValue)) ||
            (/^WP_PREFERENCES_USER_[1-9]\d*$/.test(key) &&
              onlyEditorPanelsChanged(before, params.newValue))
          )
            return;
        }
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
