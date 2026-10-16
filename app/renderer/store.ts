import {
  snapshotSchema,
  type WorkspaceBridge,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
  type UICommand,
} from '../shared/contracts';

const labels: Record<string, string> = {
  EXECUTION_STOPPED: '这项任务已停止。明确继续后会先核对，再处理剩余工作。',
  EXECUTION_CONTINUE_REQUIRED:
    '这项任务已让出或暂停。请明确说“继续”，我会先核对当前网页。',
  NATIVE_INPUT_UNAVAILABLE:
    '本机输入识别暂不可用，自动操作已暂停。网页与文字保留，无需关闭系统安全设置。',
  INPUT_CHANGED_DURING_CONTINUE:
    '核对期间又发生了输入或页面变化，仍保持暂停。准备好后请再明确继续。',
  CONTROL_DISCONNECTED:
    '网页控制连接已中断，已暂停自动操作。请保留当前记录，重新打开 helpr 后再核对。',
  EXECUTION_RESULT_UNKNOWN: '先前操作的结果仍待核对，暂不发送后续操作。',
  EXECUTION_LIMIT: '本轮执行已达上限，已暂停并保留已有结果。',
  EXECUTION_PAGE_CHANGED: '网页已变化，已暂停；继续时先核对当前页面。',
  EXECUTION_EVIDENCE_MISSING: '当前页面不能支持所需结果，已暂停后续操作。',
  MODEL_NOT_CONFIGURED: '请先配置模型服务。问题和网页仍保留。',
  MODEL_AUTHENTICATION: '模型凭据未通过认证，请到模型设置核对后重新发送。',
  MODEL_CONNECTION: '暂时连接不上模型服务。网页与消息保留，不会自动重发。',
  MODEL_TIMEOUT: '等待模型回复超时，已停止接收；消耗仍可能未知，不会自动重发。',
  MODEL_FORMAT: '服务返回的回复格式不兼容。请核对服务协议后重新发送。',
  MODEL_CAPABILITY: '服务不支持这次请求的接口或能力，请核对服务配置。',
  MODEL_CREDENTIAL_UNAVAILABLE:
    '暂时无法访问受保护凭据。数据仍保留，请处理系统授权后重试；不会降级为明文保存。',
  MODEL_LIMIT:
    '请求次数、并发、预留消耗或输出已达上限。已发送的请求保留已有内容，不自动重试。',
  MODEL_BUSY: '这项任务正在回复，请等候或先停止本次回复。',
  MODEL_CANCELLED:
    '本次回复已停止，已生成内容保留。已发出的请求实际消耗可能未知。',
  MODEL_INTERRUPTED:
    '上次请求因程序中断而结束，已有内容保留；不会自动重新发送。',
  MODEL_PAGE_UNAVAILABLE: '暂时无法观察这项任务的网页，请先打开网页再询问。',
  MODEL_RECORDS_UNAVAILABLE:
    '请求记录暂时不可用，已阻断新的模型发送。请保留窗口并重新打开 helpr 后核对。',
  MODEL_RESPONSE_REDACTED:
    '服务回复包含受保护信息，已停止接收，原始内容不展示。',

  INVALID_REQUEST: '输入内容不符合要求，请检查后重试。',
  RECORD_VERSION_CONFLICT: '这项任务刚有新记录，请核对最新内容后重试。',
  REQUEST_CONTENT_CONFLICT:
    '这次请求与先前保存的内容不同。请先核对原任务；新目标需要另建任务。',
  UNSAVED_CHANGES: '仍有内容等待保存或保存失败。请先回到任务完成保存，再退出。',
  PAGE_LOAD_FAILED: '网页暂未打开。任务和地址已保存，请核对地址后重试。',
  PAGE_NOT_AVAILABLE: '网页暂不可用，请检查地址或系统授权后重试。',
};
export const modelErrorLabel = (code: string): string =>
  labels[code] ?? '模型请求未完成，请核对后重新发送。';
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
