import { FormRequestChainWatch } from './form-request-chain';
import { creationFieldsMatch } from '../shared/target-creation';
import { z } from 'zod';
import {
  expectedNavigationLink,
  directFormButton,
  sameSiteFormURL,
  type FormNavigationProof,
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
    private readonly receivedForm?: (proof: FormNavigationProof) => void,
  ) {}
  async start(job: WebActionJob) {
    const url = expectedNavigationLink(
      job.action,
      job.source,
      job.source.links,
    );
    const form =
      !!this.receivedForm &&
      !!job.targetCreation &&
      directFormButton(job.action, job.source) &&
      creationFieldsMatch(job.targetCreation, job.source);
    if (!url && !form) return;
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
      formProof: FormNavigationProof | undefined,
      chainWatch: FormRequestChainWatch | undefined,
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
        if (chainWatch) {
          const message = z
            .object({
              sessionId: z.string(),
              method: z.string(),
              params: z.unknown(),
            })
            .safeParse(input);
          if (!message.success || message.data.sessionId !== q.sessionId)
            return;
          const chain = chainWatch.event(
            message.data.method,
            message.data.params,
          );
          if (chain && formProof) {
            close();
            this.receivedForm?.({ ...formProof, chain });
          }
          return;
        }
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
        if (
          !released ||
          p.frameId !== frame ||
          p.reason !== (form ? 'formSubmissionPost' : 'anchorClick') ||
          p.disposition !== 'currentTab' ||
          (form ? !sameSiteFormURL(job.source.url, p.url, true) : p.url !== url)
        ) {
          close();
          return;
        }
        const proof = {
          taskId: job.taskId,
          runId: job.runId,
          actionId: job.actionId,
          targetId: q.targetId,
          generation: q.generation,
          inputEpoch: q.inputEpoch,
          url: p.url,
          requestedAt: Date.now(),
        };
        if (form) {
          formProof = { ...proof, reason: 'formSubmissionPost' };
          chainWatch = new FormRequestChainWatch(
            job.source.url,
            p.url,
            frame,
            q.sessionId,
          );
        } else {
          close();
          this.received({ ...proof, reason: 'anchorClick' });
        }
      });
      await this.broker.protocol('Page.enable', {}, q.sessionId);
      if (form) await this.broker.protocol('Network.enable', {}, q.sessionId);
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
