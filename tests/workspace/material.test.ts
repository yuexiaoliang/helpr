import { afterEach, expect, test, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaterialFiles, materialDigest } from '../../app/records/material';
import { WorkspaceRecords } from '../../app/records/workspace';
import { materialObservation } from '../../app/desktop/material-observation';
import { ExecutionService } from '../../app/desktop/execution-service';
import type { NextStep, WebAction } from '../../app/shared/execution';
import type { PageObservation } from '../../app/shared/model';
import { modelConfigurationSchema } from '../../app/shared/model';
import { websiteURL } from '../../app/shared/url-policy';

const folders: string[] = [],
  databases: WorkspaceRecords[] = [];
test('真实后台可使用 HTTP 网站，模型密钥端点仍要求 HTTPS 或本机', () => {
  expect(websiteURL('http://example.test:8080/admin')).toBe(
    'http://example.test:8080/admin',
  );
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pass@example.test',
  ])
    expect(() => websiteURL(url)).toThrow();
  expect(() =>
    modelConfigurationSchema.parse({
      protocol: 'chat-completions',
      endpoint: 'http://example.test',
      model: 'fixture',
    }),
  ).toThrow();
  expect(
    modelConfigurationSchema.parse({
      protocol: 'chat-completions',
      endpoint: 'https://example.test',
      model: 'fixture',
    }).endpoint,
  ).toBe('https://example.test');
});
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((r) => r.close());
  await Promise.all(
    folders.splice(0).map((f) => rm(f, { recursive: true, force: true })),
  );
});
async function fixture() {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-material-'));
  folders.push(folder);
  const sources = path.join(folder, 'sources');
  await mkdir(sources);
  const source = path.join(sources, '中文 report.bin');
  await writeFile(source, Buffer.from([1, 4, 9, 0, 255]));
  const selection = {
    scope: source,
    rule: 'exact' as const,
    name: null,
    extension: null,
    basis: `使用“${source}”`,
  };
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  databases.push(records);
  const create = (requestId: string) => {
    requestId = path.basename(folder) + '-' + requestId;
    const taskId = records.execute({
      kind: 'create',
      requestId,
      goal: `${selection.basis} 准备 https://example.com/editor`,
    }).taskId;
    records.execute({
      kind: 'page',
      requestId: requestId + '-page',
      taskId,
      url: 'https://example.com/editor',
      phase: 'manual',
    });
    records.execution({
      kind: 'intent',
      requestId: requestId + '-start',
      taskId,
      intent: 'start',
    });
    return taskId;
  };
  const taskId = create('A'),
    runId = 'run-A';
  const fileStore = new MaterialFiles(folder);
  const observation: PageObservation = {
    url: 'https://example.com/editor',
    title: '编辑',
    text: '[file 0] https://example.com/editor\n编辑',
    fingerprint: 'one',
    generation: 1,
    observedAt: 100,
    truncated: false,
  };
  const reserve = (action: WebAction, id = 'upload') =>
    records.execution({
      kind: 'reserve',
      taskId,
      runId,
      id,
      summary: '上传固定素材',
      action,
      source: observation,
      binding: { targetId: 'owned-page', generation: 1 },
    });
  return {
    folder,
    sources,
    source,
    selection,
    records,
    create,
    taskId,
    runId,
    fileStore,
    observation,
    reserve,
  };
}

test('素材范围只来自用户：相似前缀、缺失、歧义及链接均不能扩大范围', async () => {
  const f = await fixture();
  await expect(
    f.fileStore.select(f.selection, [`${f.source}.secret`], 1),
  ).rejects.toThrow('MATERIAL_SCOPE_REQUIRED');
  await expect(f.fileStore.select(f.selection, [], 1)).rejects.toThrow(
    'MATERIAL_SCOPE_REQUIRED',
  );
  await writeFile(path.join(f.sources, 'another.bin'), 'another');
  const selection = {
    ...f.selection,
    scope: f.sources,
    rule: 'only' as const,
    basis: `使用“${f.sources}”`,
  };
  await expect(
    f.fileStore.select(selection, [selection.basis], 1),
  ).rejects.toThrow('MATERIAL_AMBIGUOUS');
  const missing = {
    ...selection,
    scope: path.join(f.sources, 'absent'),
    basis: `使用“${path.join(f.sources, 'absent')}”`,
  };
  await expect(f.fileStore.select(missing, [missing.basis], 1)).rejects.toThrow(
    'MATERIAL_MISSING',
  );
  const alias = path.join(f.sources, 'alias');
  await symlink(f.source, alias);
  const linked = { ...f.selection, scope: alias, basis: `使用“${alias}”` };
  await expect(f.fileStore.select(linked, [linked.basis], 1)).rejects.toThrow(
    'MATERIAL_ACCESS_DENIED',
  );
});

test('固定字节后来源同名替换不改变上传内容；损坏的副本拒绝读取', async () => {
  const f = await fixture();
  const original = await readFile(f.source);
  const version = await f.fileStore.select(f.selection, [f.selection.basis], 1);
  await writeFile(f.source, 'later source');
  expect(await f.fileStore.read(version)).toEqual(original);
  const changed = await f.fileStore.select(f.selection, [f.selection.basis], 1);
  expect(changed.sha256).not.toBe(version.sha256);
  const saved = path.join(f.folder, 'materials', version.sha256);
  await chmod(saved, 0o600);
  await writeFile(saved, Buffer.alloc(original.length, 7));
  await expect(f.fileStore.read(version)).rejects.toThrow('MATERIAL_CORRUPT');
});

test('未约定最新规则时不任取文件，修改时间并列时请求澄清', async () => {
  const f = await fixture();
  const second = path.join(f.sources, 'second.bin');
  await writeFile(second, 'second');
  await utimes(f.source, 100, 100);
  await utimes(second, 100, 100);
  const selection = {
    ...f.selection,
    scope: f.sources,
    rule: 'latest' as const,
    basis: `使用“${f.sources}”`,
  };
  await expect(
    f.fileStore.select(selection, [selection.basis], 1),
  ).rejects.toThrow('MATERIAL_SCOPE_REQUIRED');
  selection.basis += '里最新的一份';
  await expect(
    f.fileStore.select(selection, [selection.basis], 1),
  ).rejects.toThrow('MATERIAL_AMBIGUOUS');
  await utimes(second, 200, 200);
  const version = await f.fileStore.select(selection, [selection.basis], 1);
  expect(version.source).toBe(second);
});

test('素材保存失败没有记录引用；缺失素材通过执行公开入口在所属任务提问', async () => {
  const f = await fixture();
  f.records.execution({ kind: 'claim', taskId: f.taskId, runId: f.runId });
  vi.spyOn(MaterialFiles.prototype, 'put').mockRejectedValueOnce(
    Object.assign(Error('full'), { code: 'ENOSPC' }),
  );
  await expect(
    f.records.material({
      kind: 'select',
      taskId: f.taskId,
      runId: f.runId,
      selection: f.selection,
    }),
  ).rejects.toThrow('full');
  expect(f.records.snapshot().tasks[0]!.execution!.materials).toBeUndefined();
  f.records.execution({
    kind: 'finish',
    taskId: f.taskId,
    runId: f.runId,
    phase: 'paused',
    summary: '等待素材',
  });
  await rm(f.source);
  let state = f.records.snapshot();
  const sent = vi.fn(() => Promise.resolve());
  const service = new ExecutionService({
    records: (c) => Promise.resolve(f.records.execution(c)),
    material: (c) => f.records.material(c),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () =>
      Promise.resolve({
        observation: f.observation,
        binding: { targetId: 'page', generation: 1 },
      }),
    propose: () =>
      Promise.resolve({
        decision: 'material',
        material: f.selection,
        evidence: ['编辑'],
        summary: '取材',
        previous: null,
        action: null,
      }),
    perform: sent,
    revoke: () => {},
    stopModels: () => {},
  });
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: 'continue-missing',
    intent: 'continue',
  });
  await service.settled();
  expect(state.tasks[0]!.execution!.question!.text).toContain('没有找到');
  expect(state.tasks[0]!.execution!.materials).toBeUndefined();
  expect(sent).not.toHaveBeenCalled();
  await service.stopAll();
});

test('上传依据绑定任务、目标版本与一次派发，来源和动作参数不能替换', async () => {
  const f = await fixture();
  f.records.execution({ kind: 'claim', taskId: f.taskId, runId: f.runId });
  await f.records.material({
    kind: 'select',
    taskId: f.taskId,
    runId: f.runId,
    selection: f.selection,
  });
  const version = f.records.snapshot().tasks[0]!.execution!.materials![0]!;
  const b = f.create('B');
  f.records.execute({
    kind: 'page',
    requestId: 'b-other',
    taskId: b,
    url: 'https://example.com/other',
    phase: 'manual',
  });
  f.records.execution({ kind: 'claim', taskId: b, runId: 'run-B' });
  expect(() =>
    f.records.execution({
      kind: 'reserve',
      taskId: b,
      runId: 'run-B',
      id: 'stolen',
      summary: '上传',
      action: {
        kind: 'upload',
        target: { fileIndex: 0 },
        materialId: version.id,
      },
      source: { ...f.observation, url: 'https://example.com/other' },
      binding: { targetId: 'page-B', generation: 1 },
    }),
  ).toThrow('MATERIAL_NOT_AUTHORIZED');
  f.reserve({
    kind: 'upload',
    target: { fileIndex: 0 },
    materialId: version.id,
  });
  await expect(
    f.records.material({
      kind: 'payload',
      taskId: f.taskId,
      runId: f.runId,
      actionId: 'upload',
    }),
  ).rejects.toThrow('MATERIAL_NOT_AUTHORIZED');
  f.records.execution({
    kind: 'dispatch',
    taskId: f.taskId,
    runId: f.runId,
    id: 'upload',
  });
  await writeFile(f.source, 'substituted');
  const payload = await f.records.material({
    kind: 'payload',
    taskId: f.taskId,
    runId: f.runId,
    actionId: 'upload',
  });
  expect(
    typeof payload.base64 === 'string' &&
      materialDigest(Buffer.from(payload.base64, 'base64')),
  ).toBe(version.sha256);
  f.records.execution({
    kind: 'reported',
    taskId: f.taskId,
    id: 'upload',
    returned: true,
  });
  expect(() =>
    f.reserve(
      { kind: 'upload', target: { fileIndex: 0 }, materialId: version.id },
      'duplicate',
    ),
  ).toThrow('MATERIAL_ALREADY_UPLOADED');
  f.records.execution({
    kind: 'intent',
    taskId: f.taskId,
    requestId: 'stop',
    intent: 'stop',
  });
  await expect(
    f.records.material({
      kind: 'payload',
      taskId: f.taskId,
      runId: f.runId,
      actionId: 'upload',
    }),
  ).rejects.toThrow('EXECUTION_STOPPED');
});

test('固定文件写入期间停止，迟到完成不能提交当前输入或派发', async () => {
  const f = await fixture();
  f.records.execution({ kind: 'claim', taskId: f.taskId, runId: f.runId });
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = MaterialFiles.prototype.put.bind(f.fileStore);
  vi.spyOn(MaterialFiles.prototype, 'put').mockImplementation(async function (
    this: MaterialFiles,
    bytes,
    sha,
  ) {
    reached();
    await wait;
    return put(bytes, sha);
  });
  const selected = f.records.material({
    kind: 'select',
    taskId: f.taskId,
    runId: f.runId,
    selection: f.selection,
  });
  const rejected = expect(selected).rejects.toThrow('EXECUTION_STOPPED');
  await entered;
  f.records.execution({
    kind: 'intent',
    taskId: f.taskId,
    requestId: 'stop',
    intent: 'stop',
  });
  release();
  await rejected;
  expect(f.records.snapshot().tasks[0]!.execution).toMatchObject({
    intent: 'stopped',
    actions: [],
  });
  expect(f.records.snapshot().tasks[0]!.execution!.materials).toBeUndefined();
});

test('固定素材与目标事实进入备份，恢复不依赖源路径且保留停止及未知效果', async () => {
  const f = await fixture();
  f.records.execution({ kind: 'claim', taskId: f.taskId, runId: f.runId });
  await f.records.material({
    kind: 'select',
    taskId: f.taskId,
    runId: f.runId,
    selection: f.selection,
  });
  const version = f.records.snapshot().tasks[0]!.execution!.materials![0]!;
  f.reserve({
    kind: 'upload',
    target: { fileIndex: 0 },
    materialId: version.id,
  });
  f.records.execution({
    kind: 'dispatch',
    taskId: f.taskId,
    runId: f.runId,
    id: 'upload',
  });
  f.records.execution({
    kind: 'preparation-observed',
    taskId: f.taskId,
    runId: f.runId,
    source: f.observation,
    facts: [
      {
        kind: 'target',
        url: f.observation.url,
        materialId: null,
        evidence: ['编辑'],
      },
    ],
  });
  f.records.execution({
    kind: 'intent',
    taskId: f.taskId,
    intent: 'stop',
    requestId: 'stop',
  });
  const file = path.join(f.folder, 'material.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: 'backup',
    file,
  });
  await rm(f.sources, { recursive: true });
  const next = await fixture();
  await next.records.backup({
    kind: 'restore',
    requestId: 'restore',
    file,
    checksum: saved.archive.checksum,
  });
  const execution = next.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(execution).toMatchObject({
    intent: 'stopped',
    restoreReview: 'required',
    actions: [{ status: 'unknown' }],
    preparation: [{ kind: 'target', verification: 'page-observed' }],
  });
  expect(materialDigest(await next.fileStore.read(version))).toBe(
    version.sha256,
  );
  const corrupt = JSON.parse(await readFile(file, 'utf8')) as {
    payload: { materials: { base64: string }[] };
  };
  corrupt.payload.materials[0]!.base64 =
    Buffer.from('wrong').toString('base64');
  await writeFile(file, JSON.stringify(corrupt));
  await expect(next.records.backup({ kind: 'inspect', file })).rejects.toThrow(
    'BACKUP_INVALID',
  );
});

test('公开执行入口完成选择和一次上传；未知效果继续时不重传', async () => {
  const f = await fixture();
  let state = f.records.snapshot(),
    sent = 0,
    unknown = false;
  let page = f.observation;
  const next = (
    decision: NextStep['decision'],
    extra: Partial<NextStep> = {},
  ): NextStep => ({
    decision,
    summary: '准备素材',
    evidence: ['编辑'],
    previous: null,
    action: null,
    ...extra,
  });
  const service = new ExecutionService({
    records: (c) => Promise.resolve(f.records.execution(c)),
    material: (c) => f.records.material(c),
    current: () => state,
    publish: (value) => {
      state = value;
    },
    observe: () =>
      Promise.resolve({
        observation: page,
        binding: { targetId: 'owned-page', generation: 1 },
      }),
    propose: (input) => {
      if (!input.materials?.length)
        return Promise.resolve(next('material', { material: f.selection }));
      if (input.pending)
        return Promise.resolve(
          next('wait', {
            previous: {
              id: input.pending.id,
              status: 'unknown',
              evidence: ['编辑'],
            },
          }),
        );
      return Promise.resolve(
        next('act', {
          action: {
            kind: 'upload',
            materialId: input.materials[0]!.id,
            target: { fileIndex: 0 },
          },
        }),
      );
    },
    perform: async (job) => {
      await f.records.material({
        kind: 'payload',
        taskId: job.taskId,
        runId: job.runId,
        actionId: job.actionId,
      });
      sent++;
      unknown = true;
      page = { ...page, fingerprint: 'after' };
    },
    revoke: () => {},
    stopModels: () => {},
  });
  await service.recordsRestored(state);
  await service.settled();
  expect(unknown).toBe(true);
  expect(state.tasks[0]!.execution!.phase).toBe('unknown');
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: 'continue',
    intent: 'continue',
  });
  await service.settled();
  expect(sent).toBe(1);
  expect(state.tasks[0]!.execution!.phase).toBe('unknown');
  await service.stopAll();
});

test('素材网页观察只提取文件控件和实际链接，不带密码或隐藏值', () => {
  const text = materialObservation({
    strings: [
      'https://example.com/editor',
      'INPUT',
      'type',
      'file',
      'password',
      'value',
      'SECRET',
      'A',
      'href',
      '/download/1',
    ],
    documents: [
      {
        documentURL: 0,
        nodes: {
          nodeName: [1, 1, 7],
          attributes: [
            [2, 3],
            [2, 4, 5, 6],
            [8, 9],
          ],
        },
      },
    ],
  });
  expect(text).toContain('[file 0] https://example.com/editor');
  expect(text).toContain('[link-url] https://example.com/download/1');
  expect(text).not.toContain('SECRET');
});

test('恢复素材草稿只核对准备事实，模型不能把草稿标成最终完成', async () => {
  const f = await fixture();
  const post = (value: Record<string, unknown>) =>
    f.records.execution({ taskId: f.taskId, runId: f.runId, ...value });
  post({ kind: 'claim' });
  await f.records.material({
    kind: 'select',
    taskId: f.taskId,
    runId: f.runId,
    selection: f.selection,
  });
  const material = f.records.snapshot().tasks[0]!.execution!.materials![0]!;
  f.reserve({
    kind: 'upload',
    materialId: material.id,
    target: { fileIndex: 0 },
  });
  post({ kind: 'dispatch', id: 'upload' });
  const source = {
    ...f.observation,
    text: '编辑\n[link-url] https://example.com/files/new\n草稿已保存',
  };
  post({
    kind: 'preparation-observed',
    source,
    facts: [
      { kind: 'target', url: source.url, materialId: null, evidence: ['编辑'] },
      {
        kind: 'upload',
        url: 'https://example.com/files/new',
        materialId: material.id,
        evidence: ['编辑'],
      },
      {
        kind: 'draft',
        url: source.url,
        materialId: null,
        evidence: ['草稿已保存'],
      },
    ],
  });
  post({ kind: 'resolve', id: 'upload', source, evidence: ['编辑'] });
  post({
    kind: 'finish',
    phase: 'paused',
    prepared: true,
    summary: '素材上传和草稿准备已完成',
    source,
    evidence: ['草稿已保存'],
  });
  expect(
    f.records.snapshot().tasks[0]!.execution!.prepared?.source.observedAt,
  ).toBe(source.observedAt);
  const file = path.join(f.folder, 'prepared.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: 'prepared',
    file,
  });
  const other = await fixture();
  await other.records.backup({
    kind: 'restore',
    requestId: 'restore-prepared',
    file,
    checksum: saved.archive.checksum,
  });
  const execution = () =>
    other.records.snapshot().tasks.find((t) => t.id === f.taskId)!.execution!;
  const review = (decision: string) =>
    other.records.execution({
      kind: 'backup-review-result',
      taskId: f.taskId,
      expectedVersion: execution().version,
      source,
      step: {
        decision,
        summary: '核对草稿',
        evidence: ['草稿已保存'],
        action: null,
        previous: null,
      },
    });
  review('complete');
  expect(execution().restoreReview).toBe('unknown');
  expect(execution().result).toBeUndefined();
  review('prepared');
  expect(execution().restoreReview).toBe('ready');
  expect(execution().phase).toBe('paused');
  expect(execution().result).toBeUndefined();
});

test('冷重开后页面未就绪时继续失败，仍可可靠退出且不派发', async () => {
  const f = await fixture();
  f.records.execution({ kind: 'claim', taskId: f.taskId, runId: f.runId });
  f.records.execution({
    kind: 'finish',
    taskId: f.taskId,
    runId: f.runId,
    phase: 'paused',
    summary: '草稿准备完成',
  });
  let state = f.records.snapshot();
  const sent = vi.fn(() => Promise.resolve());
  const service = new ExecutionService({
    records: (c) => Promise.resolve(f.records.execution(c)),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () => Promise.reject(Error('UNEXPECTED_OBSERVE')),
    propose: () => Promise.reject(Error('UNEXPECTED_MODEL')),
    perform: sent,
    revoke: () => {},
    stopModels: () => {},
    input: {
      prepare: () => Promise.reject(Error('CONTROL_DISCONNECTED')),
      block: () => {},
      allow: () => false,
      epoch: () => 0,
      valid: () => false,
      permit: (_taskId, _epoch, send) => send(),
    },
  });
  await expect(
    service.intent({
      kind: 'execution-intent',
      taskId: f.taskId,
      requestId: 'continue-before-page-ready',
      intent: 'continue',
    }),
  ).rejects.toThrow('CONTROL_DISCONNECTED');
  expect(service.canExit()).toBe(true);
  expect(state.tasks[0]!.execution!.phase).toBe('paused');
  expect(sent).not.toHaveBeenCalled();
  await service.stopAll();
});
