import { randomUUID } from 'node:crypto';
import type { ActionNavigationEvent } from '../shared/action-navigation';

type Window = {
  taskId: string;
  runId: string;
  actionId: string;
  targetId: string;
  generation: number;
  inputEpoch: number;
};
/** 宿主只关联同一派发窗口内的首个导航；绝不授予导航或新页执行资格。 */
export class ActionNavigationWindows {
  private readonly windows = new Map<string, Window & { expires: number }>();
  constructor(private readonly now = Date.now) {}
  arm(window: Window) {
    if (this.windows.has(window.taskId)) throw Error('ACTION_WINDOW_EXISTS');
    this.windows.set(window.taskId, { ...window, expires: this.now() + 16000 });
  }
  disarm(taskId: string, actionId?: string) {
    if (!actionId || this.windows.get(taskId)?.actionId === actionId)
      this.windows.delete(taskId);
  }
  started(input: {
    taskId: string;
    targetId: string;
    generation: number;
    inputEpoch: number;
    blocked: boolean;
    available: boolean;
    url: string;
    mainFrame: boolean;
    sameDocument: boolean;
  }): ActionNavigationEvent | undefined {
    const window = this.windows.get(input.taskId);
    this.windows.delete(input.taskId);
    const observedAt = this.now();
    if (
      !window ||
      window.expires <= observedAt ||
      input.blocked ||
      !input.available ||
      window.targetId !== input.targetId ||
      window.generation !== input.generation ||
      window.inputEpoch !== input.inputEpoch
    )
      return;
    // 无效协议仍按原宿主策略暂停，但不保存为可核对的网站导航。
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return;
    }
    if (!['https:', 'http:'].includes(url.protocol) || input.url.length > 4096)
      return;
    return {
      taskId: window.taskId,
      runId: window.runId,
      actionId: window.actionId,
      navigation: {
        id: randomUUID(),
        association: 'during-action',
        targetId: window.targetId,
        sourceGeneration: window.generation,
        generation: window.generation + 1,
        inputEpoch: window.inputEpoch,
        observedAt,
        url: input.url,
        mainFrame: input.mainFrame,
        sameDocument: input.sameDocument,
      },
    };
  }
}
