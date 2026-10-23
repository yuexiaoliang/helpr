import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import type { NextStep } from '../../app/shared/execution';
import { BackupService } from '../../app/desktop/backup-service';
import { randomUUID } from 'node:crypto';

const folders: string[] = [];
const opened: WorkspaceRecords[] = [];
function records() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-backup-'));
  folders.push(folder);
  const value = new WorkspaceRecords(folder, 'app/records/migrations');
  opened.push(value);
  return { folder, value };
}
afterEach(() => {
  opened.splice(0).forEach((r) => r.close());
  folders.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

test('记录拥有者创建一致业务备份，排除模型凭据与网站会话，重送返回原备份', async () => {
  const { folder, value: r } = records();
  const task = r.execute({
    kind: 'create',
    requestId: 'task',
    goal: '保存任务 https://example.com/A',
  });
  r.model({
    kind: 'configuration',
    requestId: 'settings',
    hash: 'private-hash',
    protocol: 'chat-completions',
    endpoint: 'https://model.example.com',
    model: 'example',
    expectedVersion: 0,
    ciphertext: 'PRIVATE-CREDENTIAL-MUST-NOT-EXPORT',
  });
  const file = path.join(folder, 'selected.helpr-backup');
  const first = await r.backup({
    kind: 'create',
    requestId: 'backup-one',
    file,
  });
  const bytes = readFileSync(file, 'utf8');
  expect(bytes).not.toContain('PRIVATE-CREDENTIAL');
  expect(bytes).not.toContain('ciphertext');
  expect(JSON.parse(bytes)).toMatchObject({
    format: 'helpr-backup',
    version: 1,
    dataVersion: 6,
    stateModel: 1,
  });
  r.execute({
    kind: 'message',
    taskId: task.taskId,
    requestId: 'later',
    text: '备份后的新消息',
  });
  const second = await r.backup({
    kind: 'create',
    requestId: 'backup-one',
    file,
  });
  expect(second.archive).toEqual(first.archive);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(bytes).not.toContain('备份后的新消息');
});

test('恢复旧备份先保留当前资料，较新的停止和目标保持，所有恢复任务等待选择，重送不重复导入', async () => {
  const { folder, value: r } = records();
  const a = r.execute({
    kind: 'create',
    requestId: 'A',
    goal: '原目标 https://example.com/A',
  }).taskId;
  r.execution({
    kind: 'intent',
    requestId: 'start-a',
    taskId: a,
    intent: 'start',
  });
  const file = path.join(folder, 'old.helpr-backup');
  const { archive } = await r.backup({
    kind: 'create',
    requestId: 'old',
    file,
  });
  r.execution({
    kind: 'intent',
    requestId: 'stop-a',
    taskId: a,
    intent: 'stop',
  });
  r.execution({
    kind: 'intent',
    requestId: 'revise-a',
    taskId: a,
    intent: 'revise',
    text: '较新的目标',
  });
  const restored = await r.backup({
    kind: 'restore',
    requestId: 'restore-old',
    file,
    checksum: archive.checksum,
  });
  expect(restored.state.tasks[0]).toMatchObject({
    goal: '较新的目标',
    execution: {
      intent: 'stopped',
      intentId: 'revise-a',
      phase: 'stopped',
      restoreReview: 'required',
    },
  });
  expect(readFileSync(restored.safety!.file, 'utf8')).toContain('较新的目标');
  expect(
    r.execution({ kind: 'claim', taskId: a, runId: 'obsolete' }),
  ).toMatchObject({ claimed: false });
  expect(() =>
    r.execution({
      kind: 'intent',
      taskId: a,
      requestId: 'too-soon',
      intent: 'continue',
    }),
  ).toThrow('BACKUP_REVIEW_REQUIRED');
  const again = await r.backup({
    kind: 'restore',
    requestId: 'restore-old',
    file,
    checksum: archive.checksum,
  });
  expect(again.state.revision).toBe(restored.state.revision);
  const fresh = records().value;
  const imported = await fresh.backup({
    kind: 'restore',
    requestId: 'fresh',
    file,
    checksum: archive.checksum,
  });
  expect(imported.state.modelSettings).toBeNull();
  expect(imported.state.tasks[0]?.execution).toMatchObject({
    intent: 'automatic',
    phase: 'paused',
    restoreReview: 'required',
    runId: null,
  });
});

test('新环境恢复保留模型历史与未知用量预算，原请求不会被当作新请求重发', async () => {
  const { folder, value: r } = records();
  const a = r.execute({
    kind: 'create',
    requestId: 'task',
    goal: '已有会话',
  }).taskId;
  const configure = (owner: WorkspaceRecords) =>
    owner.model({
      kind: 'configuration',
      requestId: 'settings',
      hash: 'settings',
      protocol: 'chat-completions',
      endpoint: 'https://model.example.com',
      model: 'example',
      expectedVersion: 0,
      ciphertext: 'protected-private-key',
    });
  configure(r);
  const begin = { kind: 'begin', id: 'old-call', taskId: a, text: '已有问题' };
  r.model(begin);
  const source = {
    url: 'https://example.com/A',
    title: 'A',
    fingerprint: 'one',
    generation: 1,
    observedAt: 1,
    truncated: false,
  };
  r.model({ kind: 'dispatch', id: 'old-call', source, reservedTokens: 200000 });
  r.model({ kind: 'progress', id: 'old-call', output: '已有回复' });
  r.model({
    kind: 'finish',
    id: 'old-call',
    phase: 'cancelled',
    error: 'MODEL_CANCELLED',
    usage: null,
  });
  const file = path.join(folder, 'history.helpr-backup');
  const { archive } = await r.backup({
    kind: 'create',
    requestId: 'history',
    file,
  });
  const fresh = records().value;
  await fresh.backup({
    kind: 'restore',
    requestId: 'import',
    file,
    checksum: archive.checksum,
  });
  expect(fresh.snapshot().tasks[0]?.messages.at(-1)).toMatchObject({
    text: '已有回复',
    call: {
      id: 'old-call',
      dispatched: true,
      reservedTokens: 200000,
      totalTokens: null,
    },
  });
  expect(fresh.model(begin)).toMatchObject({ created: false });
  configure(fresh);
  fresh.model({ kind: 'begin', id: 'new-call', taskId: a, text: '新的问题' });
  expect(() =>
    fresh.model({
      kind: 'dispatch',
      id: 'new-call',
      source,
      reservedTokens: 1,
    }),
  ).toThrow('MODEL_LIMIT');
  expect(readFileSync(file, 'utf8')).not.toContain('protected-private-key');
});

test('恢复后只读核对不派发动作；较新的停止使迟到核对失效，结果已完成不再继续', async () => {
  const { folder, value: r } = records();
  const a = r.execute({
    kind: 'create',
    requestId: 'A',
    goal: '核对 https://example.com/A',
  }).taskId;
  r.execute({
    kind: 'page',
    requestId: 'page',
    taskId: a,
    url: 'https://example.com/A',
    phase: 'manual',
  });
  r.execution({
    kind: 'intent',
    requestId: 'start',
    taskId: a,
    intent: 'start',
  });
  const file = path.join(folder, 'before.helpr-backup');
  const { archive } = await r.backup({
    kind: 'create',
    requestId: 'before',
    file,
  });
  await r.backup({
    kind: 'restore',
    requestId: 'restore',
    file,
    checksum: archive.checksum,
  });
  let state = r.snapshot(),
    actions = 0;
  let resolveProposal: ((step: NextStep) => void) | undefined;
  const proposal = new Promise<NextStep>((resolve) => {
    resolveProposal = resolve;
  });
  let proposed: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    proposed = resolve;
  });
  const service = new ExecutionService({
    records: (command) => Promise.resolve(r.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () =>
      Promise.resolve({
        observation: {
          url: 'https://example.com/A',
          title: 'A',
          text: '备注已完成',
          fingerprint: 'done',
          generation: 1,
          observedAt: 1,
          truncated: false,
        },
        binding: { targetId: 'A', generation: 1 },
      }),
    propose: () => {
      proposed!();
      return proposal;
    },
    perform: () => {
      actions++;
      return Promise.resolve();
    },
    revoke: () => {},
    stopModels: () => {},
  });
  const checking = service.reviewRestored(a);
  await started;
  await service.intent({
    kind: 'execution-intent',
    requestId: 'new-stop',
    taskId: a,
    intent: 'stop',
  });
  resolveProposal!({
    decision: 'complete',
    summary: '已完成',
    evidence: ['备注已完成'],
    previous: null,
    action: null,
  });
  await checking.catch(() => {});
  expect(state.tasks[0]?.execution).toMatchObject({
    intentId: 'new-stop',
    phase: 'stopped',
    restoreReview: 'required',
  });
  await service.reviewRestored(a);
  expect(state.tasks[0]?.execution).toMatchObject({
    intent: 'stopped',
    restoreReview: 'complete',
  });
  await service.intent({
    kind: 'execution-intent',
    requestId: 'again',
    taskId: a,
    intent: 'continue',
  });
  expect(actions).toBe(0);
});

test('应用公开备份入口把丢失回执保留为待核对，跨界面重试仍核对原文件', async () => {
  const { folder, value: r } = records();
  r.execute({ kind: 'create', requestId: 'A', goal: '当前任务' });
  let state = r.snapshot(),
    loseReceipt = true;
  const service = new BackupService({
    choose: () => Promise.resolve(folder),
    records: async (command) => {
      const result = await r.backup(command);
      if (loseReceipt) {
        loseReceipt = false;
        throw Error('REQUEST_TIMEOUT');
      }
      return result;
    },
    current: () => state,
    publish: (next) => {
      state = next;
    },
    hold: () => Promise.resolve(),
    release: () => Promise.resolve(),
    ready: () => true,
  });
  await service.handle({ kind: 'backup-location' });
  const requestId = randomUUID();
  expect(
    await service.handle({ kind: 'backup-create', requestId }),
  ).toMatchObject({ phase: 'uncertain', requestId });
  expect(service.canExit()).toBe(false);
  await expect(
    service.handle({ kind: 'backup-create', requestId: randomUUID() }),
  ).rejects.toThrow('BACKUP_PENDING');
  const saved = await service.handle({ kind: 'backup-create', requestId });
  expect(saved).toMatchObject({
    phase: 'complete',
    archive: { id: requestId },
  });
  expect(service.canExit()).toBe(true);
});

test('备份损坏、旧状态不兼容与当前资料副本保存失败均不覆盖当前任务', async () => {
  const { folder, value: r } = records();
  const a = r.execute({
    kind: 'create',
    requestId: 'A',
    goal: '保留当前资料',
  }).taskId;
  const file = path.join(folder, 'good.helpr-backup');
  const { archive } = await r.backup({
    kind: 'create',
    requestId: 'good',
    file,
  });
  r.execute({
    kind: 'draft',
    taskId: a,
    requestId: 'new-draft',
    text: '备份后新草稿',
  });
  const before = r.snapshot();
  const original = readFileSync(file, 'utf8');
  const broken = path.join(folder, 'broken.helpr-backup');
  writeFileSync(broken, original.replace('保留当前资料', '破坏内容清单'));
  await expect(
    r.backup({
      kind: 'restore',
      requestId: 'bad',
      file: broken,
      checksum: archive.checksum,
    }),
  ).rejects.toThrow('BACKUP_INVALID');
  writeFileSync(broken, original.replace('"stateModel":1', '"stateModel":999'));
  await expect(
    r.backup({
      kind: 'restore',
      requestId: 'unsupported',
      file: broken,
      checksum: archive.checksum,
    }),
  ).rejects.toThrow('BACKUP_INCOMPATIBLE');
  writeFileSync(path.join(folder, 'backups'), '占用保留副本目录');
  await expect(
    r.backup({
      kind: 'restore',
      requestId: 'cannot-save',
      file,
      checksum: archive.checksum,
    }),
  ).rejects.toThrow();
  expect(r.snapshot()).toEqual(before);
  const occupied = path.join(folder, 'occupied.helpr-backup');
  mkdirSync(occupied);
  await expect(
    r.backup({ kind: 'create', requestId: 'cannot-write', file: occupied }),
  ).rejects.toThrow();
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('原生已撤权而通知尚未保存时，旧只读核对不能形成可继续状态', async () => {
  const { value: r } = records();
  const taskId = r.execute({
    kind: 'create',
    requestId: 'A',
    goal: '当前目标 https://example.com/A',
  }).taskId;
  r.execution({ kind: 'intent', requestId: 'start', taskId, intent: 'start' });
  r.execution({ kind: 'backup-pause', taskId });
  let state = r.snapshot(),
    epoch = 1,
    blocked = true;
  const service = new ExecutionService({
    records: (command) => Promise.resolve(r.execution(command)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () =>
      Promise.resolve({
        observation: {
          url: 'https://example.com/A',
          title: 'A',
          text: '已完成',
          fingerprint: 'A',
          generation: 1,
          observedAt: 1,
          truncated: false,
        },
        binding: { targetId: 'A', generation: 1 },
      }),
    propose: () => {
      blocked = true;
      epoch++;
      return Promise.resolve({
        decision: 'complete',
        summary: '已完成',
        evidence: ['已完成'],
        previous: null,
        action: null,
      });
    },
    perform: () => Promise.reject(Error('NO_WRITE_ALLOWED')),
    revoke: () => {},
    stopModels: () => {},
    input: {
      prepare: () => Promise.resolve(epoch),
      allow: (_task, expected) => {
        if (expected !== epoch) return false;
        blocked = false;
        return true;
      },
      block: () => {
        blocked = true;
        epoch++;
      },
      epoch: () => epoch,
      valid: (_task, expected) => !blocked && expected === epoch,
      permit: (_task, expected, send) => {
        if (blocked || expected !== epoch) throw Error('EXECUTION_STOPPED');
        return send();
      },
    },
  });
  await expect(service.reviewRestored(taskId)).rejects.toThrow(
    'EXECUTION_STOPPED',
  );
  expect(state.tasks[0]?.execution?.restoreReview).toBe('required');
});
