import { z } from 'zod';
import {
  expectedNavigationLink,
  type LinkNavigationProof,
} from '../shared/action-navigation';
import type { WebActionJob } from './execution-service';
import type { ObservationBroker } from './observation-broker';

/** 独立只读CDP订阅跨越旧工作者撤权；16秒后必定释放，不拥有输入权限。 */
export class LinkNavigationWatch {
  private readonly watchers = new Set<() => void>();
  constructor(
    private readonly broker: Pick<
      ObservationBroker,
      'client' | 'observe' | 'protocol' | 'close' | 'onEvent' | 'onInputSent'
    >,
    private readonly received: (proof: LinkNavigationProof) => void,
  ) {}
  async start(job: WebActionJob) {
    const url = expectedNavigationLink(
      job.action,
      job.source,
      job.source.links,
    );
    if (!url) return;
    const q = this.broker.client(job.taskId);
    if (
      q.targetId !== job.binding.targetId ||
      q.generation !== job.binding.generation
    ) {
      await this.broker.close(q);
      throw Error('EXECUTION_PAGE_CHANGED');
    }
    let removeEvent = () => {},
      removeInput = () => {},
      released = false,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      removeEvent();
      removeInput();
      this.watchers.delete(close);
      void this.broker.close(q);
    };
    const timer = setTimeout(close, 16000);
    this.watchers.add(close);
    try {
      const frame = z
        .object({
          frameTree: z.object({ frame: z.object({ id: z.string() }) }),
        })
        .parse(
          await this.broker.observe(q, {
            taskId: job.taskId,
            token: q.token,
            method: 'Page.getFrameTree',
          }),
        ).frameTree.frame.id;
      removeInput = this.broker.onInputSent((client, method, params) => {
        if (
          client.taskId !== job.taskId ||
          client.targetId !== q.targetId ||
          client.generation !== q.generation ||
          client.inputEpoch !== q.inputEpoch
        )
          return;
        if (
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mouseReleased' &&
          params.button === 'left'
        )
          released = true;
      });
      removeEvent = this.broker.onEvent((input) => {
        const event = z
          .object({
            sessionId: z.string(),
            method: z.literal('Page.frameRequestedNavigation'),
            params: z.object({
              frameId: z.string(),
              reason: z.string(),
              disposition: z.string(),
              url: z.string(),
            }),
          })
          .safeParse(input);
        if (!event.success || event.data.sessionId !== q.sessionId) return;
        const p = event.data.params;
        // 首个请求不匹配就关闭，不在其它导航之后寻找一个可放行事件。
        close();
        if (
          !released ||
          p.frameId !== frame ||
          p.reason !== 'anchorClick' ||
          p.disposition !== 'currentTab' ||
          p.url !== url
        )
          return;
        this.received({
          taskId: job.taskId,
          runId: job.runId,
          actionId: job.actionId,
          targetId: q.targetId,
          generation: q.generation,
          inputEpoch: q.inputEpoch,
          reason: 'anchorClick',
          url,
          requestedAt: Date.now(),
        });
      });
      await this.broker.protocol('Page.enable', {}, q.sessionId);
      if (closed || !job.qualified() || job.signal.aborted)
        throw Error('EXECUTION_STOPPED');
    } catch (error) {
      close();
      throw error;
    }
  }
  dispose() {
    for (const close of this.watchers) close();
  }
}
