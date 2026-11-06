import { randomUUID } from 'node:crypto';
import type { SessionContext } from '../shared/coordination';

/** 一个实际 Electron Session 的观察代次。不会读取、保存或传播 Cookie 值。 */
export class WebsiteSessions {
  private readonly boot = randomUUID();
  private readonly epochs = new Map<string, number>();
  constructor(private readonly id: string) {}
  context(url: string): SessionContext {
    const origin = new URL(url).origin;
    if (!this.epochs.has(origin)) this.epochs.set(origin, 0);
    return {
      id: this.id,
      origin,
      epoch: `${this.boot}:${this.epochs.get(origin)!}`,
    };
  }
  changed(domain: string) {
    const host = domain.replace(/^\./, '').toLowerCase();
    const affected: SessionContext[] = [];
    for (const [origin, epoch] of this.epochs) {
      const name = new URL(origin).hostname.toLowerCase();
      if (
        name === host ||
        (domain.startsWith('.') && name.endsWith('.' + host))
      ) {
        this.epochs.set(origin, epoch + 1);
        affected.push(this.context(origin));
      }
    }
    return affected;
  }
  storageChanged(origin: string) {
    this.context(origin);
    this.epochs.set(origin, this.epochs.get(origin)! + 1);
    return this.context(origin);
  }
}
