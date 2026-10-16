import { z } from 'zod';
import { ObservationBroker, type Qualification } from './observation-broker';
import type { BoundObservation } from './execution-service';

type JSONMap = Record<string, unknown>;
const packetSchema = z.object({
  id: z.number().int().positive(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});
const eventSchema = z.object({
  method: z.string(),
  sessionId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const pageMethods = new Set(
  'Page.enable Page.getFrameTree Page.setLifecycleEventsEnabled Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument Page.createIsolatedWorld Page.getLayoutMetrics Page.handleJavaScriptDialog Page.setInterceptFileChooserDialog Page.bringToFront Runtime.enable Runtime.disable Runtime.evaluate Runtime.callFunctionOn Runtime.getProperties Runtime.releaseObject Runtime.releaseObjectGroup Runtime.runIfWaitingForDebugger Runtime.addBinding Runtime.removeBinding DOM.getDocument DOM.describeNode DOM.resolveNode DOM.getContentQuads DOM.getBoxModel DOM.scrollIntoViewIfNeeded DOM.querySelector DOM.querySelectorAll Network.enable Log.enable Inspector.enable Input.dispatchMouseEvent Input.dispatchKeyEvent Input.insertText'.split(
    ' ',
  ),
);
export type ProtocolClient = {
  qualification: Qualification;
  virtual: Set<string>;
  ids: Set<number>;
  closed: boolean;
  qualified: () => boolean;
  deliver: (packet: unknown) => void;
  close: () => void;
};
type Session = {
  client: ProtocolClient;
  targetId: string;
  parent?: string;
  frames: Set<string>;
  contexts: Set<number>;
  objects: Set<string>;
  nodes: Set<number>;
};
/** 私有管道转接。实际IPC通道拥有者绑定任务；消息不能自报另一个任务或浏览器能力。 */
export class ExecutionProtocol {
  private readonly sessions = new Map<string, Session>();
  private readonly clients = new Set<ProtocolClient>();
  private readonly removeListener: () => void;
  constructor(private readonly pipe: ObservationBroker) {
    this.removeListener = pipe.onEvent((p) => this.event(p));
  }
  open(
    taskId: string,
    binding: BoundObservation['binding'],
    qualified: () => boolean,
    deliver: (packet: unknown) => void,
    onClose: () => void,
  ): ProtocolClient {
    const q = this.pipe.client(taskId);
    if (
      q.targetId !== binding.targetId ||
      q.generation !== binding.generation
    ) {
      void this.pipe.close(q);
      throw Error('EXECUTION_PAGE_CHANGED');
    }
    const c: ProtocolClient = {
      qualification: q,
      virtual: new Set(),
      ids: new Set(),
      closed: false,
      qualified,
      deliver,
      close: onClose,
    };
    this.clients.add(c);
    return c;
  }
  private live(c: ProtocolClient) {
    return !c.closed && c.qualified() && this.pipe.owns(c.qualification);
  }
  private send(
    c: ProtocolClient,
    method: string,
    params: JSONMap = {},
    sessionId?: string,
  ) {
    return this.pipe.protocol(method, params, sessionId, c.qualification);
  }
  private deliver(c: ProtocolClient, packet: unknown) {
    try {
      c.deliver(packet);
    } catch {
      // 工作者退出只撤销其自己的通道，不能使另一个任务失去控制连接。
      this.close(c);
    }
  }
  private async attach(c: ProtocolClient, targetId: string, parent?: string) {
    if (targetId !== c.qualification.targetId) throw Error('TARGET_NOT_OWNED');
    const info = await this.send(c, 'Target.getTargetInfo', { targetId });
    if (!this.live(c)) throw Error('EXECUTION_STOPPED');
    const reply = await this.send(c, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = z.string().parse(reply.sessionId);
    if (!this.live(c)) {
      void this.pipe
        .protocol('Target.detachFromTarget', { sessionId })
        .catch(() => {});
      throw Error('EXECUTION_STOPPED');
    }
    this.sessions.set(sessionId, {
      client: c,
      targetId,
      parent,
      frames: new Set(),
      contexts: new Set(),
      objects: new Set(),
      nodes: new Set(),
    });
    return { sessionId, info: info.targetInfo };
  }
  private learn(s: Session, value: unknown) {
    if (!value || typeof value !== 'object') return;
    const v = value as JSONMap;
    const remote = (o: unknown) => {
      if (
        o &&
        typeof o === 'object' &&
        'objectId' in o &&
        typeof o.objectId === 'string' &&
        'type' in o
      )
        s.objects.add(o.objectId);
    };
    const node = (o: unknown) => {
      if (!o || typeof o !== 'object') return;
      const n = o as JSONMap;
      if (typeof n.backendNodeId === 'number' && typeof n.nodeType === 'number')
        s.nodes.add(n.backendNodeId);
      if (Array.isArray(n.children)) n.children.forEach(node);
    };
    const frame = (o: unknown) => {
      if (!o || typeof o !== 'object') return;
      const t = o as JSONMap;
      if (
        t.frame &&
        typeof t.frame === 'object' &&
        'id' in t.frame &&
        typeof t.frame.id === 'string'
      )
        s.frames.add(t.frame.id);
      if (Array.isArray(t.childFrames)) t.childFrames.forEach(frame);
    };
    if (
      v.frame &&
      typeof v.frame === 'object' &&
      'id' in v.frame &&
      typeof v.frame.id === 'string'
    )
      s.frames.add(v.frame.id);
    frame(v.frameTree);
    node(v.node);
    node(v.root);
    remote(v.result);
    remote(v.object);
    if (Array.isArray(v.result))
      for (const d of v.result) {
        if (d && typeof d === 'object') {
          const p = d as JSONMap;
          remote(p.value);
          remote(p.get);
          remote(p.set);
        }
      }
  }
  private event(input: unknown) {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) return;
    const m = parsed.data;
    const s = m.sessionId ? this.sessions.get(m.sessionId) : undefined;
    if (!s || !this.live(s.client)) return;
    const p = m.params ?? {};
    if (m.method === 'Target.attachedToTarget') {
      const child = z
        .object({
          sessionId: z.string(),
          targetInfo: z.object({ targetId: z.string(), type: z.string() }),
        })
        .safeParse(p);
      if (!child.success) return;
      if (child.data.targetInfo.type !== 'iframe') {
        void this.pipe
          .protocol('Target.detachFromTarget', {
            sessionId: child.data.sessionId,
          })
          .catch(() => {});
        return;
      }
      this.sessions.set(child.data.sessionId, {
        client: s.client,
        targetId: child.data.targetInfo.targetId,
        parent: m.sessionId,
        frames: new Set(),
        contexts: new Set(),
        objects: new Set(),
        nodes: new Set(),
      });
    }
    if (
      m.method === 'Target.detachedFromTarget' &&
      typeof p.sessionId === 'string'
    )
      this.sessions.delete(p.sessionId);
    if (m.method === 'Runtime.executionContextsCleared') {
      s.contexts.clear();
      s.objects.clear();
      s.nodes.clear();
    }
    if (m.method === 'Runtime.executionContextCreated') {
      const c = z
        .object({
          context: z.object({
            id: z.number(),
            auxData: z.object({ frameId: z.string().optional() }).optional(),
          }),
        })
        .safeParse(p);
      if (c.success) {
        s.contexts.add(c.data.context.id);
        if (c.data.context.auxData?.frameId)
          s.frames.add(c.data.context.auxData.frameId);
      }
    }
    if (
      m.method === 'Runtime.executionContextDestroyed' &&
      typeof p.executionContextId === 'number'
    )
      s.contexts.delete(p.executionContextId);
    if (m.method === 'Page.frameAttached' && typeof p.frameId === 'string')
      s.frames.add(p.frameId);
    if (m.method === 'Page.frameDetached' && typeof p.frameId === 'string')
      s.frames.delete(p.frameId);
    this.learn(s, p);
    this.deliver(s.client, input);
  }
  async command(c: ProtocolClient, input: unknown): Promise<void> {
    const parsed = packetSchema.safeParse(input);
    if (!parsed.success) return;
    const { id, method, sessionId } = parsed.data,
      p = parsed.data.params ?? {};
    const deliver = (body: JSONMap) =>
      this.deliver(c, { id, ...(sessionId ? { sessionId } : {}), ...body });
    try {
      if (!this.live(c)) throw Error('EXECUTION_STOPPED');
      if (c.ids.has(id) || c.ids.size >= 4000)
        throw Error('PROTOCOL_REQUEST_REPEATED');
      c.ids.add(id);
      if (JSON.stringify(input).length > 4 * 1024 * 1024)
        throw Error('PROTOCOL_PACKET_LIMIT');
      const root = !sessionId || c.virtual.has(sessionId),
        s = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!root && (!s || s.client !== c)) throw Error('SESSION_NOT_OWNED');
      let result: JSONMap;
      if (method === 'Target.getTargets') {
        const reply = await this.send(c, method);
        const infos = z
          .array(z.object({ targetId: z.string() }).passthrough())
          .parse(reply.targetInfos);
        result = {
          targetInfos: infos.filter(
            (i) => i.targetId === c.qualification.targetId,
          ),
        };
      } else if (method === 'Target.getTargetInfo') {
        if (p.targetId && p.targetId !== c.qualification.targetId)
          throw Error('TARGET_NOT_OWNED');
        result = await this.send(c, method, {
          targetId: c.qualification.targetId,
        });
      } else if (method === 'Target.attachToBrowserTarget') {
        const virtual = 'virtual-' + c.qualification.token;
        c.virtual.add(virtual);
        result = { sessionId: virtual };
      } else if (method === 'Target.attachToTarget') {
        const attached = await this.attach(
          c,
          z.string().parse(p.targetId),
          root ? undefined : sessionId,
        );
        result = { sessionId: attached.sessionId };
      } else if (method === 'Target.detachFromTarget') {
        const key = z.string().parse(p.sessionId);
        if (this.sessions.get(key)?.client !== c)
          throw Error('SESSION_NOT_OWNED');
        this.sessions.delete(key);
        result = await this.send(c, method, { sessionId: key });
      } else if (method === 'Target.setAutoAttach') {
        if (p.flatten !== true || p.autoAttach !== true)
          throw Error('AUTO_ATTACH_DENIED');
        if (root) {
          const attached = await this.attach(c, c.qualification.targetId);
          this.deliver(c, {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: attached.sessionId,
              targetInfo: attached.info,
              waitingForDebugger: false,
            },
            ...(sessionId ? { sessionId } : {}),
          });
          result = {};
        } else
          result = await this.send(
            c,
            method,
            {
              autoAttach: true,
              flatten: true,
              waitForDebuggerOnStart: true,
              filter: [{ type: 'iframe' }, { exclude: true }],
            },
            sessionId,
          );
      } else if (root) {
        if (method !== 'Browser.getVersion')
          throw Error('ROOT_CAPABILITY_DENIED');
        result = await this.send(c, method);
      } else {
        if (!s || !pageMethods.has(method))
          throw Error('PAGE_CAPABILITY_DENIED');
        if (p.targetId || p.sessionId || p.browserContextId)
          throw Error('NESTED_ROUTING_DENIED');
        if (p.frameId && !s.frames.has(z.string().parse(p.frameId)))
          throw Error('FRAME_NOT_OWNED');
        for (const key of ['contextId', 'executionContextId'])
          if (p[key] !== undefined && !s.contexts.has(Number(p[key])))
            throw Error('CONTEXT_NOT_OWNED');
        if (p.objectId && !s.objects.has(z.string().parse(p.objectId)))
          throw Error('OBJECT_NOT_OWNED');
        if (p.arguments !== undefined)
          for (const a of z
            .array(z.object({ objectId: z.string().optional() }).passthrough())
            .parse(p.arguments)) {
            if (a.objectId && !s.objects.has(a.objectId))
              throw Error('OBJECT_NOT_OWNED');
          }
        if (p.backendNodeId && !s.nodes.has(Number(p.backendNodeId)))
          throw Error('NODE_NOT_OWNED');
        if (method === 'Page.handleJavaScriptDialog' && p.accept !== false)
          throw Error('DIALOG_CONFIRMATION_REQUIRED');
        if (method === 'Page.createIsolatedWorld')
          p.grantUniveralAccess = false;
        if (!this.live(c)) throw Error('EXECUTION_STOPPED');
        result = await this.send(c, method, p, sessionId);
        this.learn(s, result);
      }
      if (!this.live(c)) throw Error('EXECUTION_STOPPED');
      deliver({ result });
    } catch {
      deliver({
        error: {
          code: -32001,
          message: 'EXECUTION_CAPABILITY_REVOKED_OR_DENIED',
        },
      });
    }
  }
  close(c: ProtocolClient) {
    if (c.closed) return;
    c.closed = true;
    this.clients.delete(c);
    for (const [id, s] of this.sessions)
      if (s.client === c) {
        this.sessions.delete(id);
        void this.pipe
          .protocol('Target.detachFromTarget', { sessionId: id })
          .catch(() => {});
      }
    void this.pipe.close(c.qualification);
    c.close();
  }
  revoke(taskId: string) {
    for (const c of this.clients)
      if (c.qualification.taskId === taskId) this.close(c);
  }
  dispose() {
    for (const c of this.clients) this.close(c);
    this.removeListener();
  }
}
