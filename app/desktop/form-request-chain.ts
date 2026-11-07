import { z } from 'zod';
import {
  validFormRequestChain,
  type FormRequestChain,
} from '../shared/form-navigation-chain';

/** 独立CDP会话的主文档网络链；不读取POST正文、Cookie或响应正文。 */
export class FormRequestChainWatch {
  private chain: FormRequestChain | undefined;
  private response = false;
  private committed = false;
  private finished = false;
  private invalid = false;
  constructor(
    private readonly source: string,
    private readonly requested: string,
    private readonly frameId: string,
    private readonly sessionId: string,
  ) {}
  event(method: string, input: unknown): FormRequestChain | undefined {
    if (this.invalid) return;
    try {
      if (method === 'Page.frameRequestedNavigation')
        throw Error('EXTRA_NAVIGATION');
      if (method === 'Network.requestWillBeSent') {
        const p = z
          .object({
            requestId: z.string(),
            loaderId: z.string(),
            frameId: z.string().optional(),
            type: z.string().optional(),
            request: z.object({ url: z.string(), method: z.string() }),
            redirectResponse: z
              .object({ url: z.string(), status: z.number() })
              .optional(),
          })
          .parse(input);
        if (p.type !== 'Document') return;
        if (p.frameId !== this.frameId || this.response || this.committed)
          throw Error('UNOWNED_DOCUMENT');
        if (!this.chain) {
          if (
            p.redirectResponse ||
            p.request.method !== 'POST' ||
            p.request.url !== this.requested ||
            !p.loaderId
          )
            throw Error('NOT_FORM_REQUEST');
          this.chain = {
            requestId: p.requestId,
            loaderId: p.loaderId,
            frameId: this.frameId,
            sessionId: this.sessionId,
            requests: [{ url: p.request.url, method: 'POST' }],
            finalUrl: p.request.url,
            status: 200,
          };
        } else {
          if (
            p.requestId !== this.chain.requestId ||
            p.loaderId !== this.chain.loaderId ||
            !p.redirectResponse ||
            p.redirectResponse.url !== this.chain.finalUrl ||
            p.request.method !== 'GET' ||
            this.chain.requests.length >= 9
          )
            throw Error('UNOWNED_REDIRECT');
          this.chain.requests.push({
            url: p.request.url,
            method: 'GET',
            redirectStatus: p.redirectResponse.status,
          });
          this.chain.finalUrl = p.request.url;
        }
        if (!validFormRequestChain(this.chain, this.source, this.requested))
          throw Error('INVALID_CHAIN');
      }
      if (method === 'Network.responseReceived') {
        const p = z
          .object({
            requestId: z.string(),
            loaderId: z.string(),
            frameId: z.string().optional(),
            type: z.string(),
            response: z.object({ url: z.string(), status: z.number() }),
          })
          .parse(input);
        if (p.type !== 'Document') return;
        if (
          !this.chain ||
          p.requestId !== this.chain.requestId ||
          p.loaderId !== this.chain.loaderId ||
          p.frameId !== this.frameId ||
          p.response.url !== this.chain.finalUrl ||
          p.response.status < 200 ||
          p.response.status >= 300 ||
          this.response
        )
          throw Error('WRONG_RESPONSE');
        this.chain.status = p.response.status;
        this.response = true;
      }
      if (method === 'Page.frameNavigated') {
        const p = z
          .object({
            frame: z.object({
              id: z.string(),
              parentId: z.string().optional(),
              loaderId: z.string(),
              url: z.string(),
            }),
          })
          .parse(input);
        if (p.frame.parentId) throw Error('EXTRA_FRAME');
        if (
          !this.chain ||
          p.frame.id !== this.frameId ||
          p.frame.loaderId !== this.chain.loaderId ||
          p.frame.url !== this.chain.finalUrl ||
          this.committed
        )
          throw Error('WRONG_COMMIT');
        this.committed = true;
      }
      if (method === 'Network.loadingFailed') {
        const p = z.object({ requestId: z.string() }).parse(input);
        if (p.requestId === this.chain?.requestId) throw Error('LOAD_FAILED');
      }
      if (method === 'Network.loadingFinished') {
        const p = z.object({ requestId: z.string() }).parse(input);
        if (p.requestId === this.chain?.requestId) this.finished = true;
      }
      if (this.chain && this.response && this.committed && this.finished)
        return structuredClone(this.chain);
    } catch {
      this.invalid = true;
    }
  }
}
