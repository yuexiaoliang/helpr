import {
  snapshotSchema,
  type WorkspaceBridge,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
  type UICommand,
} from '../shared/contracts';

const labels: Record<string, string> = {
  INVALID_REQUEST: '输入内容不符合要求，请检查后重试。',
  RECORD_VERSION_CONFLICT: '这项任务刚有新记录，请核对最新内容后重试。',
  REQUEST_CONTENT_CONFLICT:
    '这次请求与先前保存的内容不同。请先核对原任务；新目标需要另建任务。',
  UNSAVED_CHANGES: '仍有内容等待保存或保存失败。请先回到任务完成保存，再退出。',
  PAGE_LOAD_FAILED: '网页暂未打开。任务和地址已保存，请核对地址后重试。',
  PAGE_NOT_AVAILABLE: '网页暂不可用，请检查地址或系统授权后重试。',
};
export type WorkspaceView = {
  state: WorkspaceSnapshot;
  notice: string;
  panel: NonNullable<WorkspaceEvent['panel']>;
  saving: number;
};
export class WorkspaceStore {
  private view: WorkspaceView;
  private newGoal = '';
  private creationId = crypto.randomUUID();
  getCreationId = (): string => this.creationId;
  getNewGoal = (): string => this.newGoal;
  cacheNewGoal = (goal: string): void => {
    this.newGoal = goal;
  };
  renewCreationId = (): void => {
    this.creationId = crypto.randomUUID();
  };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly bridge: WorkspaceBridge,
    initial: WorkspaceSnapshot = { revision: 0, active: null, tasks: [] },
  ) {
    this.view = {
      state: initial,
      notice: '',
      panel: { kind: 'panel', panel: 'none' },
      saving: 0,
    };
    this.unsubscribe = bridge.subscribe((event) => {
      let state = this.view.state;
      if (event.state && event.state.revision >= state.revision)
        state = snapshotSchema.parse(event.state);
      this.update({
        ...this.view,
        state,
        notice: event.notice ?? this.view.notice,
        panel: event.panel ?? this.view.panel,
      });
    });
    void this.perform({ kind: 'snapshot' });
  }
  private update(view: WorkspaceView): void {
    this.view = view;
    this.listeners.forEach((listener) => listener());
  }
  get = (): WorkspaceView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async perform(command: UICommand): Promise<unknown> {
    this.update({ ...this.view, saving: this.view.saving + 1 });
    try {
      const result = await this.bridge.request(command);
      const direct = snapshotSchema.safeParse(result);
      const nested = snapshotSchema.safeParse(
        (result as { state?: unknown } | null)?.state,
      );
      const state = direct.success
        ? direct.data
        : nested.success
          ? nested.data
          : null;
      if (state && state.revision >= this.view.state.revision)
        this.update({ ...this.view, state });
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      const key = Object.keys(labels).find((code) => text.includes(code));
      this.update({
        ...this.view,
        notice: key
          ? (labels[key] ?? '')
          : '暂时未能保存。当前输入仍在，请保持窗口打开并重试。',
      });
      throw error;
    } finally {
      this.update({ ...this.view, saving: this.view.saving - 1 });
    }
  }
  dismissNotice = (): void => {
    this.update({ ...this.view, notice: '' });
  };
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
