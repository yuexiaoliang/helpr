import { z } from 'zod';
import {
  recordCommandSchema,
  errorCode,
  snapshotSchema,
  type RecordCommand,
  type WorkspaceSnapshot,
} from '../shared/contracts';

const resultSchema = z.object({ taskId: z.string(), state: snapshotSchema });
/** UI 和网页事件共用保存边界；未提交投影与失败结果不能被退出吞掉。 */
export class WorkspaceSession {
  private pending = 0;
  private readonly failed = new Map<string, RecordCommand>();
  constructor(
    private state: WorkspaceSnapshot,
    private readonly request: (input: unknown) => Promise<unknown>,
    private readonly publish: (state: WorkspaceSnapshot) => void,
  ) {}
  private adopt(state: WorkspaceSnapshot): void {
    if (state.revision >= this.state.revision) {
      this.state = state;
      this.publish(state);
    }
  }
  canExit(): boolean {
    return this.pending === 0 && this.failed.size === 0;
  }
  async save(input: unknown): Promise<z.infer<typeof resultSchema>> {
    const command = recordCommandSchema.parse(input);
    const key =
      command.kind === 'create'
        ? 'create:' + command.requestId
        : command.kind + ':' + command.taskId;
    this.pending++;
    try {
      const result = resultSchema.parse(await this.request(command));
      this.failed.delete(key);
      this.adopt(result.state);
      return result;
    } catch (error) {
      const rejected = [
        'REQUEST_CONTENT_CONFLICT',
        'RECORD_VERSION_CONFLICT',
        'TASK_NOT_FOUND',
        'INVALID_REQUEST',
      ].includes(errorCode(error));
      if (!rejected && (command.kind !== 'create' || !this.failed.has(key)))
        this.failed.set(key, command);
      throw error;
    } finally {
      this.pending--;
    }
  }
  async cancelCreation(requestId: string): Promise<void> {
    const key = 'create:' + requestId,
      command = this.failed.get(key);
    if (!command) return;
    // 只核对回执，不重做创建：取消不能因缺少回执而产生新任务。
    const receipt = z
      .object({ applied: z.boolean(), state: snapshotSchema })
      .parse(await this.request({ kind: 'lookup', command }));
    this.adopt(receipt.state);
    this.failed.delete(key);
  }
}
