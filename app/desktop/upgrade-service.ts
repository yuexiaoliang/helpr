import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../shared/contracts';
import type { BackupArchive } from '../shared/backup';
import {
  upgradeLedgerSchema,
  upgradeProofSchema,
  upgradeStatusSchema,
  upgradeUICommandSchema,
  type UpgradeProof,
  type UpgradeStatus,
  type UpgradeSite,
} from '../shared/upgrade';

const receipt = upgradeLedgerSchema.extend({
  currentFingerprint: z.string(),
  workspaceRevision: z.number().int(),
});
type Receipt = z.infer<typeof receipt>;
type Versions = {
  revision: number;
  phase: string;
  result: { kind: string; release?: { version: string } } | null;
};
const messages: Record<string, string> = {
  UPGRADE_PAGE_UNSAVED:
    '网页有手动操作尚待核对。请逐项回到网页保存，再确认现场已处理。',
  UPGRADE_CHANGED:
    '准备或核对期间任务、草稿或网页发生变化。已保留较新决定，请重新准备或核对。',
  UPGRADE_VERSION_MISMATCH:
    '实际应用版本与升级约定不符。保留资料，先核对安装来源。',
  UPGRADE_CREDENTIAL_CHANGED:
    '原模型凭据发生变化或缺失，不能将重新配置记作原密钥延续成功。',
  MODEL_CREDENTIAL_UNAVAILABLE:
    '暂不能读取原受保护凭据。保留资料，处理系统授权后可主动重试。',
  UPGRADE_LOGIN_CHANGED:
    '原本未过期的会话资料发生变化或缺失。先核对网站，不能算作原有效登录延续。',
  UPGRADE_LOGIN_EXPIRED:
    '原会话已到期。请在网站重新登录，再主动检查；原停止与待确认条件保留。',
  UPGRADE_CONTROL_UNAVAILABLE:
    '本机输入识别或网页控制未就绪。相关工作保持暂停。',
  UPGRADE_PENDING: '本次升级准备或核对尚未完成，新的自动操作保持暂停。',
  UNSAVED_CHANGES: '仍有任务变化未可靠保存，保留现场，尚不能报告可以退出。',
};

/** 应用运行公开入口。所有等待均保留屏障，界面投影不授予执行资格。 */
export class UpgradeService {
  private ledger: Receipt | null = null;
  private dirtyTasks: string[] = [];
  private pages: UpgradeSite[] = [];
  private pending: Promise<UpgradeStatus> | null = null;
  private localError = '';
  private projectionRevision = 0;
  constructor(
    private readonly ports: {
      version: string;
      records: (command: unknown) => Promise<unknown>;
      current: () => WorkspaceSnapshot;
      versions: () => Versions;
      hold: () => Promise<void>;
      release: () => Promise<void>;
      ready: () => boolean;
      capture: () => Promise<UpgradeProof>;
      pages: () => Promise<UpgradeSite[]>;
      acknowledge: (
        taskId: string,
        generation: number,
        epoch: number,
      ) => Promise<void>;
      choose: () => Promise<string | null>;
      backup: (requestId: string, file: string) => Promise<BackupArchive>;
      closePages: (proof: UpgradeProof) => Promise<void>;
      quit: () => Promise<void>;
      publish: (status: UpgradeStatus) => void;
    },
  ) {}
  private async record(command: unknown) {
    const next = receipt.parse(await this.ports.records(command));
    if (
      !this.ledger ||
      next.revision > this.ledger.revision ||
      (next.revision === this.ledger.revision &&
        next.workspaceRevision >= this.ledger.workspaceRevision)
    )
      this.ledger = next;
    return this.ledger;
  }
  private status(): UpgradeStatus {
    if (!this.ledger) throw Error('UPGRADE_PENDING');
    const error = this.localError || this.ledger.error;
    return upgradeStatusSchema.strip().parse({
      ...this.ledger,
      recordRevision: this.ledger.revision,
      revision: ++this.projectionRevision,
      error,
      phase:
        error && this.ledger.phase === 'idle' ? 'blocked' : this.ledger.phase,
      dirtyTasks: this.dirtyTasks,
      pages: this.pages,
      working: !!this.pending,
      message: error
        ? (messages[error] ?? '升级检查未完成，原资料保留，相关工作保持暂停。')
        : this.ledger.phase === 'ready'
          ? '记录与升级前业务备份已核对，可以退出供你手动安装。'
          : this.ledger.phase === 'complete'
            ? '基础检查完成。原自动任务先核对网站实际结果，停止、接管和待确认条件保留。' +
              (this.ledger.continuity === 'unrecorded'
                ? ' 本次没有升级前会话依据，不宣称原有效登录延续通过。'
                : this.ledger.continuity === 'renewed'
                  ? ' 原会话到期后已更新，不记作原会话延续。'
                  : '')
            : '升级准备和检查期间，新的自动操作暂停；原任务与现场保留。',
    });
  }
  private publish() {
    if (this.ledger) this.ports.publish(this.status());
  }
  async initialize() {
    await this.record({ kind: 'boot', version: this.ports.version });
    if (['idle', 'complete'].includes(this.ledger!.phase))
      await this.ports.release();
    else await this.ports.hold();
    this.publish();
    return this.status();
  }
  held() {
    return (
      !!this.localError ||
      !this.ledger ||
      !['idle', 'complete'].includes(this.ledger.phase)
    );
  }
  private async capture() {
    const proof = upgradeProofSchema.parse(await this.ports.capture());
    this.pages = proof.pages;
    this.dirtyTasks = proof.pages.filter((p) => p.dirty).map((p) => p.taskId);
    return proof;
  }
  async handle(input: unknown): Promise<UpgradeStatus> {
    const c = upgradeUICommandSchema.parse(input);
    if (c.kind === 'upgrade-status') {
      await this.record({ kind: 'status' });
      if (!this.pending) {
        this.pages = await this.ports.pages();
        this.dirtyTasks = this.pages
          .filter((p) => p.dirty)
          .map((p) => p.taskId);
      }
      return this.status();
    }
    if (this.pending) throw Error('UPGRADE_PENDING');
    if (c.kind === 'upgrade-prepare') {
      const v = this.ports.versions();
      if (
        v.revision !== c.versionRevision ||
        v.phase !== 'done' ||
        v.result?.kind !== 'available' ||
        !v.result.release
      )
        throw Error('UPGRADE_VERSION_MISMATCH');
    }
    if (c.kind === 'upgrade-page-saved') {
      await this.ports.acknowledge(c.taskId, c.generation, c.epoch);
      this.pages = await this.ports.pages();
      this.dirtyTasks = this.pages.filter((p) => p.dirty).map((p) => p.taskId);
      this.publish();
      return this.status();
    }
    const work = async () => {
      try {
        this.localError = '';
        if (c.kind === 'upgrade-exit') await this.exit(c.revision);
        else if (c.kind === 'upgrade-prepare')
          await this.prepare(c.requestId, c.versionRevision);
        else if (c.kind === 'upgrade-cancel') {
          await this.record({ kind: 'review' });
          await this.check(true);
        } else await this.check(false);
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
            ? error.message
            : 'UPGRADE_PENDING';
        this.localError = code;
        try {
          await this.record({ kind: 'block', error: code });
        } catch {
          /* 屏障与本机错误保持，不冒充可靠保存。 */
        }
      }
      return this.status();
    };
    this.pending = Promise.resolve().then(work);
    this.publish();
    try {
      await this.pending;
    } finally {
      this.pending = null;
      this.publish();
    }
    return this.status();
  }
  private async exit(revision: number) {
    const s = await this.record({ kind: 'status' });
    if (
      s.phase !== 'ready' ||
      revision !== s.revision ||
      s.currentFingerprint !== s.fingerprint ||
      !s.proof ||
      !this.ports.ready()
    )
      throw Error('UPGRADE_CHANGED');
    const current = await this.capture();
    if (
      !current.nativeReady ||
      JSON.stringify(current.pages) !== JSON.stringify(s.proof.pages)
    )
      throw Error('UPGRADE_CHANGED');
    await this.ports.closePages(s.proof);
    const final = await this.record({ kind: 'status' });
    if (
      final.revision !== s.revision ||
      final.currentFingerprint !== s.fingerprint
    )
      throw Error('UPGRADE_CHANGED');
    await this.ports.quit();
  }
  private async prepare(requestId: string, revision: number) {
    await this.ports.hold();
    const version = this.ports.versions();
    if (
      version.revision !== revision ||
      version.phase !== 'done' ||
      version.result?.kind !== 'available' ||
      !version.result.release
    )
      throw Error('UPGRADE_VERSION_MISMATCH');
    const ledger = await this.record({
      kind: 'prepare',
      requestId,
      target: version.result.release.version,
    });
    if (ledger.phase === 'ready') {
      const proof = await this.capture();
      if (
        ledger.fingerprint !== ledger.currentFingerprint ||
        JSON.stringify(proof) !== JSON.stringify(ledger.proof)
      )
        throw Error('UPGRADE_CHANGED');
      return;
    }
    if (!this.ports.ready()) throw Error('UNSAVED_CHANGES');
    const proof = await this.capture();
    if (!proof.nativeReady) throw Error('UPGRADE_CONTROL_UNAVAILABLE');
    if (this.dirtyTasks.length) throw Error('UPGRADE_PAGE_UNSAVED');
    const directory = await this.ports.choose();
    if (!directory) throw Error('UPGRADE_PENDING');
    const before = await this.record({ kind: 'status' });
    const backupId = requestId + '-' + before.currentFingerprint.slice(0, 16);
    const backup = await this.ports.backup(
      backupId,
      path.join(
        directory,
        'helpr-before-upgrade-' + backupId + '.helpr-backup',
      ),
    );
    const again = await this.capture();
    if (JSON.stringify(again) !== JSON.stringify(proof) || !this.ports.ready())
      throw Error('UPGRADE_CHANGED');
    await this.record({
      kind: 'ready',
      requestId: ledger.requestId,
      fingerprint: before.currentFingerprint,
      backup,
      proof,
    });
  }
  private async check(cancel: boolean) {
    await this.ports.hold();
    const before = await this.record({ kind: 'status' });
    if (
      !before.reopening ||
      (before.phase !== 'checking' && before.phase !== 'blocked')
    )
      throw Error('UPGRADE_PENDING');
    if (
      !cancel &&
      before.target &&
      ![before.target, before.fromVersion].includes(this.ports.version)
    )
      throw Error('UPGRADE_VERSION_MISMATCH');
    const proof = await this.capture();
    if (!proof.nativeReady) throw Error('UPGRADE_CONTROL_UNAVAILABLE');
    let continuity: 'retained' | 'renewed' | 'unrecorded' = before.proof
      ? 'retained'
      : 'unrecorded';
    if (before.proof) {
      if (proof.credential !== before.proof.credential)
        throw Error('UPGRADE_CREDENTIAL_CHANGED');
      if (proof.profile !== before.proof.profile)
        throw Error('UPGRADE_LOGIN_CHANGED');
      const now = Date.now() / 1000;
      for (const old of before.proof.cookies) {
        const found = proof.cookies.find((x) => x.id === old.id);
        if (old.expires !== null && old.expires <= now) {
          if (
            before.error !== 'UPGRADE_LOGIN_EXPIRED' ||
            !found ||
            (found.expires !== null && found.expires <= now)
          )
            throw Error('UPGRADE_LOGIN_EXPIRED');
          continuity = 'renewed';
        } else if (!found || old.value !== found.value)
          throw Error('UPGRADE_LOGIN_CHANGED');
      }
    }
    if (!this.ports.ready()) throw Error('UNSAVED_CHANGES');
    if (JSON.stringify(await this.capture()) !== JSON.stringify(proof))
      throw Error('UPGRADE_CHANGED');
    const current = await this.record({ kind: 'status' });
    if (
      current.currentFingerprint !== before.currentFingerprint ||
      current.revision !== before.revision
    )
      throw Error('UPGRADE_CHANGED');
    if (before.phase !== 'checking') await this.record({ kind: 'review' });
    const checked = this.ledger!;
    await this.record({
      kind: 'finish',
      revision: checked.revision,
      fingerprint: checked.currentFingerprint,
      continuity,
    });
    this.localError = '';
    await this.ports.release();
  }
}
