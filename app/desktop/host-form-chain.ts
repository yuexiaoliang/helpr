import type { ActionNavigationEvent } from '../shared/action-navigation';
import type { HostFormChain } from '../shared/form-navigation-chain';

/** 宿主审计与网络证明独立；任何其它导航/暂停都使此链失效。 */
export class HostFormChains {
  private readonly chains = new Map<
    string,
    { chain: HostFormChain; expires: number }
  >();
  constructor(private readonly now = Date.now) {}
  invalidate(taskId: string | null) {
    if (taskId) this.chains.delete(taskId);
    else this.chains.clear();
  }
  start(
    event: ActionNavigationEvent,
    receipt: { requestId: string; before: number; after: number },
  ) {
    const n = event.navigation;
    this.invalidate(event.taskId);
    if (
      !n.mainFrame ||
      n.sameDocument ||
      receipt.before !== n.inputEpoch ||
      receipt.after !== receipt.before + 1
    )
      return;
    this.chains.set(event.taskId, {
      expires: this.now() + 16000,
      chain: {
        navigationId: n.id,
        targetId: n.targetId,
        generation: n.generation,
        events: [{ ...receipt, kind: 'start', url: n.url }],
      },
    });
  }
  redirect(
    taskId: string,
    targetId: string,
    generation: number,
    url: string,
    main: boolean,
    receipt: { requestId: string; before: number; after: number },
  ) {
    const chain = this.get(taskId);
    if (
      !chain ||
      !main ||
      chain.targetId !== targetId ||
      chain.generation !== generation ||
      chain.events.length >= 9 ||
      receipt.after !== receipt.before + 1
    ) {
      this.invalidate(taskId);
      return;
    }
    this.chains
      .get(taskId)!
      .chain.events.push({ ...receipt, kind: 'redirect', url });
  }
  get(taskId: string): HostFormChain | undefined {
    const item = this.chains.get(taskId);
    if (!item || item.expires <= this.now()) {
      this.invalidate(taskId);
      return;
    }
    return structuredClone(item.chain);
  }
}
