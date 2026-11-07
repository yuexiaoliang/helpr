import {
  snapshotSchema,
  type WorkspaceBridge,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
  type UICommand,
} from '../shared/contracts';
import { versionStatusSchema, type VersionStatus } from '../shared/version';
import { upgradeStatusSchema, type UpgradeStatus } from '../shared/upgrade';

const labels: Record<string, string> = {
  UPGRADE_PENDING:
    '升级准备或启动核对尚未完成，请在“关于与新版”处理；任务与现场保留。',
  UPGRADE_CHANGED: '任务或网页在准备后发生变化，已保留较新决定，请重新核对。',
  UPGRADE_PAGE_UNSAVED: '网页仍有未保存或未核对的编辑，已保留页面，尚未退出。',
  UPGRADE_VERSION_MISMATCH:
    '实际版本与升级约定不符，请核对可信来源和安装版本。',
  VERSION_LINK_UNAVAILABLE:
    '版本结果已经变化，当前没有经本次确认可用的下载入口。请重新查看或检查。',
  BACKUP_REVIEW_REQUIRED: '恢复资料后先核对实际结果，再选择继续本项任务。',
  BACKUP_BUSY: '备份或恢复仍在进行，请先等候本次结果。停止仍可立即生效。',
  BACKUP_PENDING: '先核对本次操作的可靠回执，暂不另建备份或重复恢复。',
  BACKUP_INVALID: '备份不完整或校验不通过，当前资料已保留，未恢复。',
  BACKUP_INCOMPATIBLE:
    '备份格式或状态版本不兼容，当前资料已保留。请使用兼容版本。',
  BACKUP_CHANGED: '所选备份在检查后发生变化，请重新选择并检查。',
  BACKUP_LOCATION_REQUIRED: '请先选择本机备份位置。',
  BACKUP_SELECTION_REQUIRED: '请先选择并检查要恢复的备份。',
  BACKUP_TOO_LARGE:
    '当前备份超过本版支持的 64 MiB，未生成成功备份，原资料保留。',
  BACKUP_STORAGE_FULL:
    '备份位置空间不足，本次没有生成可用备份。原资料和其它文件保留。',
  BACKUP_FILE_MISSING: '找不到所选备份或保存目录。原资料保留，请重新选择。',
  BACKUP_STORAGE_UNAVAILABLE:
    '无法读写所选本机位置。请检查访问权限和文件类型，原资料保留。',
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
  PARTICIPATION_EXPIRED: '这条问题已失效，请查看当前待办。',
  PARTICIPATION_REQUIRED: '请先回答任务的问题。',
  MODEL_PAGE_UNAVAILABLE: '暂时无法观察这项任务的网页，请先打开网页再询问。',
  MODEL_RECORDS_UNAVAILABLE:
    '请求记录暂时不可用，已阻断新的模型发送。请保留窗口并重新打开 helpr 后核对。',
  MODEL_RESPONSE_REDACTED:
    '服务回复包含受保护信息，已停止接收，原始内容不展示。',

  AGREEMENT_EXPIRED: '这个约定版本已失效，请查看最新复述或单独确认本次内容。',
  SCHEDULE_EXPIRED: '这个计划版本或待处理轮次已失效，请查看最新记录。',
  SCHEDULE_ZONE_REQUIRED: '请明确有效的命名时区，例如 Asia/Shanghai。',
  SCHEDULE_POLICY_REQUIRED:
    '请先约定错过策略及夏令时重复、不存在时刻的处理方式。',
  SCHEDULE_NEEDS_DETAILS:
    '请根据会话中的补问明确时间、时区和错过规则，再复述计划。',
  AGREEMENT_SCOPE_INVALID: '素材或目标不符合约定范围，请修改约定或本次委托。',
  AGREEMENT_PERIOD_REQUIRED: '请明确本次日期或期次；同内容一次的约定无需填写。',
  AGREEMENT_NEEDS_DETAILS:
    '还需要补充发布约定，请按会话中的说明完善后重新复述。',
  AGREEMENT_TASK_BUSY: '请先停止或等待当前任务，再整理发布约定。',
  MATERIAL_WORK_UNSETTLED:
    '这份工作尚未核对完成，请先到原任务核对，不能直接重发。',
  INVALID_REQUEST: '输入内容不符合要求，请检查后重试。',
  RECORD_VERSION_CONFLICT: '这项任务刚有新记录，请核对最新内容后重试。',
  REQUEST_CONTENT_CONFLICT:
    '这次请求与先前保存的内容不同。请先核对原任务；新目标需要另建任务。',
  UNSAVED_CHANGES: '仍有内容等待保存或保存失败。请先回到任务完成保存，再退出。',
  SYSTEM_SUSPENDED:
    '锁屏、休眠或系统条件尚未恢复，已暂停新操作。条件恢复后先核对原任务。',
  PAGE_LOAD_FAILED: '网页暂未打开。任务和地址已保存，请核对地址后重试。',
  PAGE_NOT_AVAILABLE: '网页暂不可用，请检查地址或系统授权后重试。',
};
export const modelErrorLabel = (code: string): string =>
  labels[code] ?? '模型请求未完成，请核对后重新发送。';
export type WorkspaceView = {
  replyDrafts: Record<string, string>;
  upgrade: UpgradeStatus | null;
  version: VersionStatus | null;
  versionNotice: boolean;
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
      upgrade: null,
      version: null,
      versionNotice: false,
      replyDrafts: {},
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
        upgrade:
          event.upgrade &&
          event.upgrade.revision >= (this.view.upgrade?.revision ?? -1)
            ? upgradeStatusSchema.parse(event.upgrade)
            : this.view.upgrade,
        version:
          event.version &&
          event.version.revision >= (this.view.version?.revision ?? -1)
            ? versionStatusSchema.parse(event.version)
            : this.view.version,
        replyDrafts: event.replyDrafts ?? this.view.replyDrafts,
        versionNotice: event.versionNotice ?? this.view.versionNotice,
        state,
        notice: event.notice ?? this.view.notice,
        panel: event.panel ?? this.view.panel,
      });
    });
    void this.perform({ kind: 'snapshot' });
  }
  saveReplyDraft(taskId: string, questionId: string, text: string) {
    this.update({
      ...this.view,
      replyDrafts: { ...this.view.replyDrafts, [questionId]: text },
    });
    void this.bridge
      .request({ kind: 'participation-draft', taskId, questionId, text })
      .catch(() => {
        if (
          this.view.state.tasks.some(
            (t) => t.execution?.question?.id === questionId,
          )
        )
          this.update({
            ...this.view,
            notice: '草稿暂未同步到其他入口，当前输入已保留。',
          });
      });
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
      const upgrade = upgradeStatusSchema.safeParse(result);
      if (
        upgrade.success &&
        upgrade.data.revision >= (this.view.upgrade?.revision ?? -1)
      )
        this.update({ ...this.view, upgrade: upgrade.data });
      const version = versionStatusSchema.safeParse(result);
      if (
        version.success &&
        version.data.revision >= (this.view.version?.revision ?? -1)
      )
        this.update({ ...this.view, version: version.data });
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
