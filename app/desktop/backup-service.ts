import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { snapshotSchema, type WorkspaceSnapshot } from '../shared/contracts';
import {
  backupArchiveSchema,
  backupUICommandSchema,
  type BackupStatus,
} from '../shared/backup';

const receipt = z.strictObject({
  archive: backupArchiveSchema,
  safety: backupArchiveSchema.optional(),
  state: snapshotSchema,
});
/** UI 不传任意路径；只有宿主文件选择器选过的路径进入记录进程。 */
export class BackupService {
  private view: BackupStatus = {
    location: '',
    selection: null,
    phase: 'idle',
    operation: null,
    requestId: null,
    message: '',
  };
  private selectedFile = '';
  private held = false;
  private choosing = false;
  constructor(
    private readonly ports: {
      choose: (kind: 'directory' | 'file') => Promise<string | null>;
      records: (command: unknown) => Promise<unknown>;
      current: () => WorkspaceSnapshot;
      publish: (state: WorkspaceSnapshot) => void;
      hold: () => Promise<void>;
      release: (state: WorkspaceSnapshot) => Promise<void>;
      ready: () => boolean;
    },
  ) {}
  status(): BackupStatus {
    return structuredClone(this.view);
  }
  canExit() {
    return (
      !this.choosing && !['working', 'uncertain'].includes(this.view.phase)
    );
  }
  async handle(input: unknown): Promise<BackupStatus> {
    const command = backupUICommandSchema.parse(input);
    if (command.kind === 'backup-status') return this.status();
    if (command.kind === 'backup-review') throw Error('INVALID_REQUEST');
    if (this.view.phase === 'working' || this.choosing)
      throw Error('BACKUP_BUSY');
    if (command.kind === 'backup-location' || command.kind === 'backup-open') {
      if (this.view.phase === 'uncertain') throw Error('BACKUP_PENDING');
      this.choosing = true;
      let file: string | null;
      try {
        file = await this.ports.choose(
          command.kind === 'backup-location' ? 'directory' : 'file',
        );
      } finally {
        this.choosing = false;
      }
      if (!file) return this.status();
      if (command.kind === 'backup-location') this.view.location = file;
      else {
        this.view.selection = null;
        const inspected = receipt.parse(
          await this.ports.records({ kind: 'inspect', file }),
        );
        this.selectedFile = file;
        this.view.selection = {
          token: randomUUID(),
          archive: inspected.archive,
        };
        this.view.message =
          '备份检查通过。恢复前会暂停自动工作并保留当前资料，网站不会回退。';
      }
      return this.status();
    }
    if (!this.ports.ready()) throw Error('UNSAVED_CHANGES');
    const operation = command.kind === 'backup-create' ? 'create' : 'restore';
    if (
      this.view.phase === 'uncertain' &&
      (this.view.operation !== operation ||
        this.view.requestId !== command.requestId)
    )
      throw Error('BACKUP_PENDING');
    if (operation === 'create' && !this.view.location)
      throw Error('BACKUP_LOCATION_REQUIRED');
    if (
      command.kind === 'backup-restore' &&
      this.view.selection?.token !== command.selection
    )
      throw Error('BACKUP_SELECTION_REQUIRED');
    this.view = {
      ...this.view,
      phase: 'working',
      operation,
      requestId: command.requestId,
      message:
        operation === 'create'
          ? '正在保存备份并核验完整性。停止仍可立即生效。'
          : '正在保留当前资料并恢复，自动工作保持暂停。',
    };
    try {
      if (operation === 'restore' && !this.held) {
        this.held = true;
        await this.ports.hold();
      }
      const result = receipt.parse(
        await this.ports.records(
          operation === 'create'
            ? {
                kind: 'create',
                requestId: command.requestId,
                file: path.join(
                  this.view.location,
                  'helpr-' + command.requestId + '.helpr-backup',
                ),
              }
            : {
                kind: 'restore',
                requestId: command.requestId,
                file: this.selectedFile,
                checksum: this.view.selection!.archive.checksum,
              },
        ),
      );
      this.ports.publish(result.state);
      if (this.held) {
        await this.ports.release(result.state);
        this.held = false;
      }
      this.view = {
        ...this.view,
        phase: operation === 'create' ? 'complete' : 'restored',
        archive: result.archive,
        ...(result.safety ? { safety: result.safety } : {}),
        message:
          operation === 'create'
            ? '本机备份已完成并通过完整性检查。'
            : '资料已恢复，当前资料副本已保留。先逐项核对实际结果，再选择继续。',
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const uncertain = [
        'REQUEST_TIMEOUT',
        'PROCESS_DISCONNECTED',
        'RECORDS_UNAVAILABLE',
        'BACKUP_RECEIPT_UNKNOWN',
      ].includes(code);
      this.view.phase = uncertain ? 'uncertain' : 'error';
      this.view.message = uncertain
        ? '尚未收到可靠回执。先核对原操作，不另建备份或重复恢复；自动工作保持当前状态。'
        : '未完成本次操作。原资料与已有备份保留，请核对保存位置、空间和备份兼容性。';
      if (!uncertain && this.held) {
        await this.ports.release(this.ports.current());
        this.held = false;
      }
      if (!uncertain) throw error;
    }
    return this.status();
  }
}
