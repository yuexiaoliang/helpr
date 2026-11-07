import { afterEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import { ExecutionService } from '../../app/desktop/execution-service';
import {
  verifyAttachment,
  verifyPublication,
  verifyRecoveredPublication,
} from '../../app/desktop/publication-verifier';
import type {
  Publication,
  PublicationCheck,
} from '../../app/shared/publication';
import { executionSchema, type NextStep } from '../../app/shared/execution';
import type { PageObservation } from '../../app/shared/model';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture({
  recovery = false,
  store,
}: { recovery?: boolean; store?: WorkspaceRecords } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-publication-'));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const original = Buffer.from([0, 1, 2, 255, 73]);
  let bytes: Buffer = original,
    html = '',
    published = false,
    sends = 0,
    reads = 0;
  let hold: Promise<void> | undefined;
  const server = createServer((req, res) => {
    reads++;
    const respond = () => {
      if (req.url === '/file') res.end(bytes);
      else if (req.url === '/result' && published) res.end(html);
      else {
        res.writeHead(404);
        res.end();
      }
    };
    if (hold) void hold.then(respond);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const sourceFile = path.join(folder, 'original.bin');
  await writeFile(sourceFile, original);
  let records = store ?? new WorkspaceRecords(folder, 'app/records/migrations');
  cleanups.push(() => {
    records.close();
    return Promise.resolve();
  });
  const taskId = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: `使用“${sourceFile}”在 ${base}/edit 发布附件到公告`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId,
    url: base + '/edit',
    phase: 'manual',
  });
  const post = (c: Record<string, unknown>) =>
    records.execution({
      taskId,
      ...(['intent', 'reported', 'publication-recovery-result'].includes(
        String(c.kind),
      )
        ? {}
        : { runId: 'prepare' }),
      ...c,
    });
  post({ kind: 'intent', requestId: randomUUID(), intent: 'start' });
  post({ kind: 'claim' });
  await records.material({
    kind: 'select',
    taskId,
    runId: 'prepare',
    selection: {
      scope: sourceFile,
      rule: 'exact',
      name: null,
      extension: null,
      basis: `使用“${sourceFile}”`,
    },
  });
  const execution = () =>
    records.snapshot().tasks.find((t) => t.id === taskId)!.execution!;
  const material = execution().materials![0]!;
  const publication: Publication = {
    content: '本次附件报告',
    destination: '公告',
    attachment: {
      materialId: material.id,
      targetUrl: base + '/edit',
      url: base + '/file',
    },
  };
  const observe = (): PageObservation => ({
    url: base + '/edit',
    title: '编辑附件',
    links: [{ name: '附件已上传', url: base + '/file' }],
    text: `编辑附件\n[file 0] ${base}/edit\n本次附件报告\n公告\n附件已上传\n[link-url] ${base}/file\n${published ? '已发布\n[link-url] ' + base + '/result' : '准备发布' + (recovery ? '\n永久链接\n[link-url] ' + base + '/result' : '')}`,
    fingerprint: published ? 'published' : 'draft',
    generation: 1,
    observedAt: Date.now(),
    truncated: false,
  });
  post({
    kind: 'reserve',
    id: 'upload',
    summary: '上传',
    action: {
      kind: 'upload',
      materialId: material.id,
      target: { fileIndex: 0 },
    },
    source: {
      ...observe(),
      links: [],
      text: '编辑附件\n[file 0] ' + base + '/edit',
    },
    evidence: ['编辑附件'],
    binding: { targetId: 'page', generation: 1 },
  });
  post({ kind: 'dispatch', id: 'upload' });
  post({ kind: 'reported', id: 'upload', returned: true });
  post({
    kind: 'preparation-observed',
    source: observe(),
    facts: [
      {
        kind: 'target',
        url: base + '/edit',
        materialId: null,
        evidence: ['编辑附件'],
      },
      {
        kind: 'upload',
        url: base + '/file',
        materialId: material.id,
        evidence: ['附件已上传'],
      },
    ],
  });
  post({
    kind: 'resolve',
    id: 'upload',
    source: observe(),
    binding: { targetId: 'page', generation: 1 },
    download: {
      url: base + '/file',
      sha256: material.sha256,
      bytes: material.bytes,
      checkedAt: Date.now(),
    },
    evidence: ['附件已上传'],
  });
  const questionId = randomUUID();
  post({
    kind: 'ask',
    type: 'review',
    questionId,
    text: '确认本次发布',
    url: base + '/edit',
    publication,
  });
  html =
    (recovery ? '<link rel="canonical" href="/result">' : '') +
    '<article><h1>本次附件报告</h1><p>公告</p><a href="/file">下载</a></article>';
  const proposal = {
    url: base + '/result',
    targetUrl: base + '/edit',
    attachmentUrl: base + '/file',
    publishedEvidence: ['已发布'],
  };
  const approve = () => {
    records.execution({
      kind: 'participation-decision',
      taskId,
      questionId: execution().question!.id,
      operation: 'approve',
    });
    records.execution({
      kind: 'recover',
      taskId,
      expectedVersion: execution().version,
    });
    post({ kind: 'claim', runId: 'publish' });
  };
  const reserve = (
    download: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    post({
      kind: 'reserve',
      runId: 'publish',
      id: 'submit',
      summary: '发布',
      effect: 'publication',
      publication,
      approvalId: execution().publication!.approvalId,
      action: {
        kind: 'click',
        target: { role: 'button', name: '发布', exact: true },
      },
      source: observe(),
      binding: { targetId: 'page', generation: 1 },
      evidence: ['编辑附件'],
      download,
      ...(recovery
        ? {
            recovery: {
              rule: 'public-attachment-v1',
              url: base + '/result',
              targetUrl: base + '/edit',
              attachmentUrl: base + '/file',
              evidence: ['永久链接'],
            },
          }
        : {}),
      ...overrides,
    });
  const dispatched = async () => {
    approve();
    reserve(
      await verifyAttachment(
        publication,
        material,
        new AbortController().signal,
      ),
    );
    post({ kind: 'dispatch', runId: 'publish', id: 'submit' });
    post({ kind: 'reported', id: 'submit', returned: true });
    published = true;
    return verifyPublication({
      execution: execution(),
      source: observe(),
      proposal,
      actionId: 'submit',
      signal: new AbortController().signal,
    });
  };
  const service = (
    options: {
      beforeRecord?: (c: unknown) => Promise<void>;
      propose?: (normal: NextStep) => NextStep;
    } = {},
  ) => {
    let state = records.snapshot();
    return new ExecutionService({
      records: async (c) => {
        await options.beforeRecord?.(c);
        return records.execution(c);
      },
      material: (c) => records.material(c),
      current: () => state,
      publish: (next) => {
        state = next;
      },
      observe: () =>
        Promise.resolve({
          observation: observe(),
          binding: { targetId: 'page', generation: 1 },
        }),
      propose: (input) => {
        const step: NextStep = published
          ? {
              decision: 'complete',
              summary: '完成',
              evidence: ['已发布'],
              action: null,
              previous: {
                id: input.pending!.id,
                status: 'confirmed',
                evidence: ['已发布'],
              },
              result: proposal,
            }
          : {
              decision: 'act',
              effect: 'publication',
              summary: '发布',
              evidence: ['准备发布'],
              previous: null,
              action: {
                kind: 'click',
                target: { role: 'button', name: '发布', exact: true },
              },
              publication,
              approvalId: input.publication!.approvalId,
              ...(recovery
                ? {
                    recovery: {
                      rule: 'public-attachment-v1' as const,
                      url: base + '/result',
                      targetUrl: base + '/edit',
                      attachmentUrl: base + '/file',
                      evidence: ['永久链接'],
                    },
                  }
                : {}),
            };
        return Promise.resolve(options.propose?.(step) ?? step);
      },
      perform: () => {
        sends++;
        published = true;
        return Promise.resolve();
      },
      revoke: () => {},
      stopModels: () => {},
    });
  };
  return {
    folder,
    get records() {
      return records;
    },
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
    },
    publish: () => {
      published = true;
    },
    taskId,
    post,
    execution,
    material,
    publication,
    observe,
    questionId,
    approve,
    reserve,
    dispatched,
    proposal,
    service,
    original,
    setBytes: (v: Buffer) => {
      bytes = v;
    },
    setHtml: (v: string) => {
      html = v;
    },
    hold: (v: Promise<void>) => {
      hold = v;
    },
    sends: () => sends,
    reads: () => reads,
  };
}

test('公开确认与执行入口发布一次，独立核对字节并原子保存素材处理与流程', async () => {
  const f = await fixture(),
    service = f.service();
  expect(f.execution().learnedWorkflows).toBeUndefined();
  await service.reply({
    kind: 'participation-decision',
    taskId: f.taskId,
    questionId: f.questionId,
    operation: 'approve',
  });
  await service.settled();
  const e = f.execution();
  expect(e.phase).toBe('complete');
  expect(e.actions.at(-1)).toMatchObject({
    returned: true,
    status: 'confirmed',
    effect: 'publication',
  });
  expect(e.materialProcessing).toMatchObject([
    { status: 'complete', materialId: f.material.id },
  ]);
  expect(e.publicationChecks).toMatchObject([
    {
      status: 'verified',
      download: { sha256: f.material.sha256 },
      unobservedWrites: 'unknown',
      screenshot: 'not-required',
    },
  ]);
  expect(e.learnedWorkflows?.[0]).toMatchObject({
    authority: 'none',
    applicability: {
      validated: 'same-inputs-only',
      newInputs: 'requires-validation',
    },
    evidence: { resultId: e.publicationChecks![0]!.id },
  });
  expect(e.learnedWorkflows![0]!.steps.map((s) => s.actionId)).toEqual(
    e.actions.map((a) => a.id),
  );
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: 'continue-complete',
    intent: 'continue',
  });
  await service.settled();
  expect(f.sends()).toBe(1);
  expect(f.reads()).toBe(3);
  await service.stopAll();
});

test('附件确认绑定目标和素材；普通完成、旧确认、伪造下载或正文改变均拒绝', async () => {
  const f = await fixture();
  f.approve();
  expect(() =>
    f.post({
      kind: 'finish',
      runId: 'publish',
      phase: 'complete',
      summary: '完成',
      source: f.observe(),
      evidence: ['编辑附件'],
    }),
  ).toThrow('PUBLICATION_RESULT_REQUIRED');
  expect(() => f.reserve(undefined)).toThrow('PUBLICATION_BYTES_UNVERIFIED');
  const download = await verifyAttachment(
    f.publication,
    f.material,
    new AbortController().signal,
  );
  expect(() => f.reserve(download, { approvalId: randomUUID() })).toThrow(
    'PARTICIPATION_REQUIRED',
  );
  expect(() =>
    f.reserve(download, {
      publication: {
        ...f.publication,
        attachment: { ...f.publication.attachment, materialId: randomUUID() },
      },
    }),
  ).toThrow('PUBLICATION_BINDING_MISMATCH');
  expect(() =>
    f.reserve(download, { source: { ...f.observe(), text: '正文被替换' } }),
  ).toThrow('EXECUTION_EVIDENCE_MISSING');
  expect(() => f.reserve({ ...download, sha256: '0'.repeat(64) })).toThrow(
    'PUBLICATION_BYTES_UNVERIFIED',
  );
  expect(f.execution().actions).toHaveLength(1);
});

test('发布前下载不符不点击；核对期间停止使迟到结果失效', async () => {
  const f = await fixture();
  f.setBytes(Buffer.from('different'));
  const service = f.service();
  await service.reply({
    kind: 'participation-decision',
    taskId: f.taskId,
    questionId: f.questionId,
    operation: 'approve',
  });
  await service.settled();
  expect(f.sends()).toBe(0);
  expect(f.execution().phase).toBe('paused');
  await service.stopAll();
  const g = await fixture();
  let release!: () => void;
  g.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const next = g.service();
  await next.reply({
    kind: 'participation-decision',
    taskId: g.taskId,
    questionId: g.questionId,
    operation: 'approve',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await next.intent({
    kind: 'execution-intent',
    taskId: g.taskId,
    requestId: 'stop-during-read',
    intent: 'stop',
  });
  release();
  await next.settled();
  expect(g.sends()).toBe(0);
  expect(g.execution().intent).toBe('stopped');
  await next.stopAll();
});

test('已发布但公开正文错误保持未知，继续也不重发或采用流程', async () => {
  const f = await fixture();
  f.setHtml(
    '<script>本次附件报告 公告</script><input value="本次附件报告"><a href="/file">下载</a>',
  );
  const service = f.service();
  await service.reply({
    kind: 'participation-decision',
    taskId: f.taskId,
    questionId: f.questionId,
    operation: 'approve',
  });
  await service.settled();
  expect(f.execution()).toMatchObject({
    phase: 'unknown',
    publicationChecks: [{ status: 'unknown', failure: 'content' }],
    materialProcessing: [{ status: 'unknown' }],
  });
  expect(f.execution().workflowAdoption).toBeUndefined();
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: 'retry-unknown',
    intent: 'continue',
  });
  await service.settled();
  expect(f.sends()).toBe(1);
  expect(f.execution().phase).toBe('unknown');
  await service.stopAll();
});

test('最终动作已预留但临近派发收到停止，网页没有提交', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = f.service({
    beforeRecord: async (c) => {
      if (typeof c === 'object' && c && 'kind' in c && c.kind === 'dispatch') {
        reached();
        await wait;
      }
    },
  });
  await service.reply({
    kind: 'participation-decision',
    taskId: f.taskId,
    questionId: f.questionId,
    operation: 'approve',
  });
  await entered;
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    requestId: 'stop-before-dispatch',
    intent: 'stop',
  });
  release();
  await service.settled();
  expect(f.sends()).toBe(0);
  expect(f.execution().actions.at(-1)!.status).toBe('cancelled');
  expect(f.execution().intent).toBe('stopped');
  await service.stopAll();
});

test('观察到额外结果后保留异常记录，继续不再派发', async () => {
  const f = await fixture();
  const service = f.service({
    propose: (normal) => ({
      ...normal,
      decision: 'observe',
      action: null,
      anomalies: ['出现未委托的结果'],
      extraResults: [f.proposal.url],
    }),
  });
  await service.reply({
    kind: 'participation-decision',
    taskId: f.taskId,
    questionId: f.questionId,
    operation: 'approve',
  });
  await service.settled();
  expect(f.execution().observedAnomalies).toMatchObject([
    { anomalies: ['出现未委托的结果'] },
  ]);
  expect(f.sends()).toBe(0);
  expect(f.execution().phase).toBe('unknown');
  await service.stopAll();
});

test('最终点击页面后条件不能替代业务结果；额外结果和错误目标不读取也不完成', async () => {
  const f = await fixture();
  const check = await f.dispatched();
  expect(() =>
    f.post({
      kind: 'resolve',
      runId: 'publish',
      id: 'submit',
      source: f.observe(),
      evidence: ['已发布'],
    }),
  ).toThrow('PUBLICATION_RESULT_REQUIRED');
  const before = f.reads();
  const wrong = await verifyPublication({
    execution: f.execution(),
    source: f.observe(),
    proposal: { ...f.proposal, url: 'https://other.test/result' },
    actionId: 'submit',
    signal: new AbortController().signal,
  });
  expect(wrong.status).toBe('unknown');
  expect(f.reads()).toBe(before);
  const extra: PublicationCheck = {
    ...check,
    id: randomUUID(),
    extraResults: [f.proposal.url + '/duplicate'],
  };
  expect(() =>
    f.post({ kind: 'publication-result', runId: 'publish', check: extra }),
  ).toThrow('EXECUTION_EVIDENCE_MISSING');
  expect(f.execution().result).toBeUndefined();
});

test('结果提交失败不留半份完成，重送同一结果只保存一个流程', async () => {
  const f = await fixture(),
    check = await f.dispatched();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "CREATE TRIGGER reject_result BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT, 'disk-full'); END",
  );
  expect(() =>
    f.post({ kind: 'publication-result', runId: 'publish', check }),
  ).toThrow('disk-full');
  expect(f.execution().materialProcessing![0]!.status).toBe('unknown');
  expect(f.execution().result).toBeUndefined();
  expect(f.execution().workflowAdoption).toBeUndefined();
  db.exec('DROP TRIGGER reject_result');
  db.close();
  f.post({ kind: 'publication-result', runId: 'publish', check });
  f.post({ kind: 'publication-result', runId: 'publish', check });
  expect(() =>
    f.post({
      kind: 'publication-result',
      runId: 'publish',
      check: { ...check, pageSha256: '0'.repeat(64) },
    }),
  ).toThrow('REQUEST_CONTENT_CONFLICT');
  expect(f.execution().learnedWorkflows).toHaveLength(1);
  expect(f.execution().publicationChecks).toHaveLength(1);
});

test('已记录的异常不会因后续提议省略而消失，旧成功检查不能完成任务', async () => {
  const f = await fixture(),
    check = await f.dispatched();
  f.post({
    kind: 'anomaly',
    runId: 'publish',
    source: f.observe(),
    anomalies: ['发现额外副本'],
    extraResults: [f.proposal.url + '/copy'],
  });
  f.post({ kind: 'intent', intent: 'continue', requestId: 'continue-anomaly' });
  f.records.execution({
    kind: 'recover',
    taskId: f.taskId,
    expectedVersion: f.execution().version,
  });
  f.post({ kind: 'claim', runId: 'again' });
  const before = f.reads();
  const fresh = await verifyPublication({
    execution: f.execution(),
    source: f.observe(),
    proposal: f.proposal,
    actionId: 'submit',
    signal: new AbortController().signal,
  });
  expect(fresh).toMatchObject({
    status: 'unknown',
    anomalies: ['发现额外副本'],
  });
  expect(f.reads()).toBe(before);
  expect(() =>
    f.post({ kind: 'publication-result', runId: 'again', check }),
  ).toThrow('EXECUTION_EVIDENCE_MISSING');
  expect(f.execution().result).toBeUndefined();
});

test('新增结果、素材处理、流程摘要和采用引用随备份恢复，篡改引用拒绝冷开', async () => {
  const f = await fixture(),
    check = await f.dispatched();
  f.post({ kind: 'publication-result', runId: 'publish', check });
  const file = path.join(f.folder, 'complete.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: 'backup',
    file,
  });
  const g = await fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: 'restore',
    file,
    checksum: saved.archive.checksum,
  });
  const restored = g.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(restored.publicationChecks).toEqual(f.execution().publicationChecks);
  expect(restored.learnedWorkflows).toEqual(f.execution().learnedWorkflows);
  expect(restored.materialProcessing).toEqual(f.execution().materialProcessing);
  expect(restored.restoreReview).toBe('required');
  const body = await readFile(file, 'utf8');
  expect(body).toContain('same-inputs-only');
  f.records.close();
  const reopened = new WorkspaceRecords(f.folder, 'app/records/migrations');
  expect(reopened.snapshot().tasks[0]!.execution!.workflowAdoption).toEqual(
    restored.workflowAdoption,
  );
  reopened.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "UPDATE task_executions SET body=json_set(body,'$.workflowAdoption.sha256','wrong')",
  );
  db.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});

async function interruptSubmission(
  f: Awaited<ReturnType<typeof fixture>>,
  dispatch = true,
) {
  f.approve();
  f.reserve(
    await verifyAttachment(
      f.publication,
      f.material,
      new AbortController().signal,
    ),
  );
  if (dispatch) {
    f.post({ kind: 'dispatch', runId: 'publish', id: 'submit' });
    f.publish();
  }
}

test('派发前冻结正常页面的精确关联；冷进程无模型、无网页工作者补记已发布结果', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  const old = f.execution().actions.at(-1)!;
  expect(old).toMatchObject({
    returned: false,
    dispatchState: 'possible',
    submission: { recovery: { rule: 'public-attachment-v1' } },
  });
  f.reopen();
  const service = f.service({
    propose: () => {
      throw Error('NO_MODEL_ALLOWED');
    },
  });
  service.refresh();
  await service.settled();
  expect(f.execution()).toMatchObject({
    phase: 'complete',
    materialProcessing: [{ status: 'complete' }],
    publicationChecks: [
      { recovery: 'public-attachment-v1', localMaterial: 'verified' },
    ],
  });
  expect(f.execution().actions.at(-1)!.returned).toBe(false);
  expect(f.sends()).toBe(0);
  expect(f.execution().learnedWorkflows).toHaveLength(1);
  await service.stopAll();
});

test('可信未派发检查点只取消旧预留，用当前观察和原有效确认派发剩余动作一次', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f, false);
  f.reopen();
  expect(f.execution().actions.at(-1)).toMatchObject({
    status: 'cancelled',
    dispatchState: 'not-dispatched',
  });
  expect(
    f.post({ kind: 'dispatch', id: 'submit', runId: 'publish' }).permitted,
  ).toBe(false);
  const service = f.service();
  service.refresh();
  await service.settled();
  expect(f.sends()).toBe(1);
  expect(f.execution().phase).toBe('complete');
  expect(f.execution().materialProcessing).toHaveLength(1);
  expect(f.execution().materialProcessing![0]!.status).toBe('complete');
  expect(
    f
      .execution()
      .actions.filter(
        (a) => a.effect === 'publication' && a.status === 'confirmed',
      ),
  ).toHaveLength(1);
  await service.stopAll();
});

test.each(['content', 'canonical', 'ambiguous', 'bytes', 'missing'] as const)(
  '恢复结果 %s 不符保留未知，明确继续仅再次读取不重发',
  async (failure) => {
    const f = await fixture({ recovery: true });
    // missing 模拟已派发但网站还没有可读结果；不以暂时未找到批准重送。
    f.approve();
    f.reserve(
      await verifyAttachment(
        f.publication,
        f.material,
        new AbortController().signal,
      ),
    );
    f.post({ kind: 'dispatch', runId: 'publish', id: 'submit' });
    if (failure !== 'missing') f.publish();
    if (failure === 'content')
      f.setHtml(
        '<link rel="canonical" href="/result"><h1>同名结果，正文被替换</h1><p>公告</p><a href="/file">附件</a>',
      );
    if (failure === 'canonical')
      f.setHtml(
        '<link rel="canonical" href="/other"><h1>本次附件报告 公告</h1><a href="/file">附件</a>',
      );
    if (failure === 'ambiguous')
      f.setHtml(
        '<link rel="canonical" href="/result"><link rel="canonical" href="/other"><h1>本次附件报告 公告</h1><a href="/file">附件</a>',
      );
    if (failure === 'bytes') f.setBytes(Buffer.from('wrong bytes'));
    f.reopen();
    const service = f.service({
      propose: () => {
        throw Error('NO_MODEL_ALLOWED');
      },
    });
    service.refresh();
    await service.settled();
    expect(f.execution().publicationChecks?.at(-1)?.status).toBe('unknown');
    expect(f.execution().materialProcessing![0]!.status).toBe('unknown');
    await service.intent({
      kind: 'execution-intent',
      taskId: f.taskId,
      intent: 'continue',
      requestId: 'retry-read',
    });
    await service.settled();
    expect(f.execution().publicationChecks).toHaveLength(2);
    expect(f.execution().result).toBeUndefined();
    expect(f.sends()).toBe(0);
    await service.stopAll();
  },
);

test('核对结果保存前新停止优先，迟到证明只进历史；同回执重送不重复应用', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  f.reopen();
  let reached!: () => void, release!: () => void, delayed: unknown;
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const service = f.service({
    beforeRecord: async (c) => {
      if ((c as { kind: string }).kind === 'publication-recovery-result') {
        delayed = c;
        reached();
        await wait;
      }
    },
  });
  service.refresh();
  await entered;
  await service.intent({
    kind: 'execution-intent',
    taskId: f.taskId,
    intent: 'stop',
    requestId: 'stop-new',
  });
  release();
  await service.settled();
  expect(f.execution()).toMatchObject({
    intent: 'stopped',
    phase: 'stopped',
    publicationHistory: [
      { reason: 'changed-intent', check: { status: 'verified' } },
    ],
  });
  expect(f.execution().result).toBeUndefined();
  f.records.execution(delayed);
  expect(f.execution().publicationHistory).toHaveLength(1);
  await service.stopAll();
  f.reopen();
  expect(f.execution().intent).toBe('stopped');
  expect(f.sends()).toBe(0);
});

test('旧工作者结果仅属于历史目标，不能覆盖修改后的当前事实或恢复资格', async () => {
  const f = await fixture();
  const check = await f.dispatched();
  f.post({ kind: 'intent', intent: 'stop', requestId: 'stop' });
  f.post({
    kind: 'intent',
    intent: 'revise',
    requestId: 'revise',
    text: '改为另一篇公告，保持停止',
  });
  f.post({ kind: 'publication-result', runId: 'publish', check });
  expect(f.execution()).toMatchObject({
    intent: 'stopped',
    goalVersion: 2,
    publicationHistory: [{ reason: 'stale-worker', check: { goalVersion: 1 } }],
  });
  expect(f.execution().result).toBeUndefined();
  expect(f.execution().materialProcessing![0]!.status).toBe('unknown');
  f.reopen();
  expect(f.execution().publicationHistory).toHaveLength(1);
});

test('已经提交但确认丢失的恢复重送返回既有事实，停止与旧回执不恢复派发资格', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  f.reopen();
  const version = f.execution().version;
  const check = await verifyRecoveredPublication(
    f.execution(),
    f.execution().actions.at(-1)!,
    new AbortController().signal,
  );
  check.localMaterial = 'verified';
  const command = {
    kind: 'publication-recovery-result',
    expectedVersion: version,
    check,
  };
  f.post(command); // 提交后假设调用方丢失回执。
  f.post({ kind: 'intent', intent: 'stop', requestId: 'stop-after-commit' });
  expect(f.post(command).created).toBe(false);
  expect(f.execution()).toMatchObject({
    intent: 'stopped',
    phase: 'stopped',
    materialProcessing: [{ status: 'complete' }],
  });
  expect(f.execution().learnedWorkflows).toHaveLength(1);
  expect(
    f.post({ kind: 'dispatch', runId: 'publish', id: 'submit' }).permitted,
  ).toBe(false);
});

test('本机固定素材损坏与已发生的网站效果同时保留，不释放素材或重新发送', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  await rm(path.join(f.folder, 'materials', f.material.sha256));
  await writeFile(
    path.join(f.folder, 'materials', f.material.sha256),
    'damaged',
  );
  f.reopen();
  const service = f.service();
  service.refresh();
  await service.settled();
  expect(f.execution().publicationChecks).toMatchObject([
    {
      status: 'unknown',
      failure: 'material',
      localMaterial: 'unavailable',
      checks: { published: true, bytes: true },
    },
  ]);
  expect(f.execution().materialProcessing![0]!.status).toBe('unknown');
  expect(f.execution().result).toBeUndefined();
  expect(f.sends()).toBe(0);
  await service.stopAll();
});

test('缺少稳定关联的规则拒绝保存；未知版本或损坏引用拒绝冷开且保留原记录', async () => {
  const f = await fixture({ recovery: true });
  f.approve();
  const download = await verifyAttachment(
    f.publication,
    f.material,
    new AbortController().signal,
  );
  expect(() =>
    f.reserve(download, {
      recovery: {
        rule: 'public-attachment-v1',
        url: f.proposal.url + '-guessed',
        targetUrl: f.proposal.targetUrl,
        attachmentUrl: f.proposal.attachmentUrl,
        evidence: ['永久链接'],
      },
    }),
  ).toThrow('EXECUTION_EVIDENCE_MISSING');
  f.reserve(download);
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "UPDATE task_executions SET body=json_set(body,'$.actions[1].submission.recovery.rule','future-rule')",
  );
  db.close();
  const before = await readFile(path.join(f.folder, 'workspace.sqlite'));
  expect(() => f.reopen()).toThrow('DATA_CORRUPT');
  expect(await readFile(path.join(f.folder, 'workspace.sqlite'))).toEqual(
    before,
  );
});

test('两项已派发任务冷启动分别只读恢复，无模型、无写入，原确认各自保留', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  const g = await fixture({ recovery: true, store: f.records });
  await interruptSubmission(g);
  const approvals = f.records
    .snapshot()
    .tasks.map((t) => t.execution!.publication!.approvalId);
  f.reopen();
  expect(
    f.records.snapshot().tasks.every((t) => t.execution!.recoveryPending),
  ).toBe(true);
  const service = f.service({
    propose: () => {
      throw Error('NO_MODEL_ALLOWED');
    },
  });
  service.refresh();
  await service.settled();
  const executions = f.records.snapshot().tasks.map((t) => t.execution!);
  expect(executions.map((e) => e.phase)).toEqual(['complete', 'complete']);
  expect(executions.map((e) => e.publication!.approvalId)).toEqual(approvals);
  expect(executions.map((e) => e.publicationChecks![0]!.proposal.url)).toEqual([
    f.proposal.url,
    g.proposal.url,
  ]);
  expect(f.sends() + g.sends()).toBe(0);
  await service.stopAll();
});

test('结果读取超时只保存网络未知，不隐式重试或重新派发', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  let release!: () => void;
  f.hold(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const before = f.reads();
  f.reopen();
  const service = f.service();
  service.refresh();
  try {
    await service.settled();
    expect(f.execution().publicationChecks).toMatchObject([
      { status: 'unknown', failure: 'network' },
    ]);
    expect(f.reads() - before).toBe(1);
    expect(f.sends()).toBe(0);
  } finally {
    release();
    await service.stopAll();
  }
}, 15000);

test('冻结恢复规则及迟到历史进入备份，旧资料恢复仍暂停，篡改关联拒绝读取', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  const check = await verifyRecoveredPublication(
    f.execution(),
    f.execution().actions.at(-1)!,
    new AbortController().signal,
  );
  check.localMaterial = 'verified';
  f.post({ kind: 'intent', intent: 'stop', requestId: 'stop-before-history' });
  f.post({
    kind: 'publication-recovery-result',
    expectedVersion: f.execution().version - 1,
    check,
  });
  const file = path.join(f.folder, 'recovery.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: 'backup-recovery',
    file,
  });
  const g = await fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: 'restore-recovery',
    file,
    checksum: saved.archive.checksum,
  });
  const restored = g.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(restored.actions.at(-1)!.submission).toEqual(
    f.execution().actions.at(-1)!.submission,
  );
  expect(restored.publicationHistory).toEqual(f.execution().publicationHistory);
  expect(restored).toMatchObject({
    intent: 'stopped',
    restoreReview: 'required',
  });
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "UPDATE task_executions SET body=json_set(body,'$.actions[1].submission.recovery.targetFactId','00000000-0000-4000-8000-000000000000')",
  );
  db.close();
  expect(() => f.reopen()).toThrow('DATA_CORRUPT');
});

test('格式12迁移保留原库，不为旧提交凭空制造恢复规则', async () => {
  const f = await fixture();
  await interruptSubmission(f);
  const before = f.execution().actions;
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=12');
  db.close();
  f.reopen();
  expect(f.execution().actions.at(-1)!.submission?.recovery).toBeUndefined();
  const { readdir } = await import('node:fs/promises');
  const copy = (await readdir(f.folder)).find((name) =>
    name.startsWith('workspace-before-publication-recovery-14-'),
  )!;
  const backup = new Database(path.join(f.folder, copy), { readonly: true });
  expect(
    backup.prepare('SELECT schema_version FROM workspace').pluck().get(),
  ).toBe(12);
  expect(
    executionSchema.parse(
      JSON.parse(
        backup
          .prepare('SELECT body FROM task_executions')
          .pluck()
          .get() as string,
      ),
    ).actions,
  ).toEqual(before);
  backup.close();
});

test('未派发检查点的固定素材已经缺失时，冷开不得继续发布', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f, false);
  await rm(path.join(f.folder, 'materials', f.material.sha256));
  f.reopen();
  const service = f.service();
  service.refresh();
  await service.settled();
  expect(f.sends()).toBe(0);
  expect(f.execution().phase).toBe('paused');
  expect(f.execution().summary).toContain('固定素材');
  expect(f.execution().materialProcessing![0]!.status).toBe('pending');
  await service.stopAll();
});

test('两项只读恢复占用自动推进容量，第三项保持排队', async () => {
  const f = await fixture({ recovery: true });
  await interruptSubmission(f);
  const g = await fixture({ recovery: true, store: f.records });
  await interruptSubmission(g);
  const third = f.records.execute({
    kind: 'create',
    requestId: 'third',
    goal: '核对 https://third.test/',
  }).taskId;
  f.records.execute({
    kind: 'page',
    requestId: 'third-page',
    taskId: third,
    url: 'https://third.test/',
    phase: 'manual',
  });
  f.records.execution({
    kind: 'intent',
    requestId: 'third-start',
    taskId: third,
    intent: 'start',
  });
  f.reopen();
  let releaseF!: () => void, releaseG!: () => void;
  f.hold(
    new Promise<void>((r) => {
      releaseF = r;
    }),
  );
  g.hold(
    new Promise<void>((r) => {
      releaseG = r;
    }),
  );
  const beforeF = f.reads(),
    beforeG = g.reads();
  const claims: string[] = [];
  const service = f.service({
    beforeRecord: async (c) => {
      const command = c as { kind: string; taskId: string };
      if (command.kind === 'claim') claims.push(command.taskId);
      return Promise.resolve();
    },
  });
  service.refresh();
  try {
    await vi.waitFor(() => {
      expect(f.reads()).toBeGreaterThan(beforeF);
      expect(g.reads()).toBeGreaterThan(beforeG);
    });
    expect(claims).not.toContain(third);
    expect(
      f.records.snapshot().tasks.find((t) => t.id === third)!.execution!.phase,
    ).toBe('queued');
  } finally {
    await service.intent({
      kind: 'execution-intent',
      taskId: third,
      requestId: 'stop-third',
      intent: 'stop',
    });
    releaseF();
    releaseG();
    await service.settled();
    await service.stopAll();
  }
});

async function dynamicResultFixture(management = false) {
  const f = await fixture();
  await f.dispatched();
  f.setHtml(
    '<link rel="canonical" href="/result"><article>本次附件报告 公告 <a href="/file">下载</a></article>',
  );
  const observation: PageObservation = {
    ...f.observe(),
    url: f.proposal.url,
    generation: 3,
    fingerprint: 'dynamic-result',
    observedAt: Date.now(),
    links: [
      { name: '编辑原条目', url: f.proposal.targetUrl },
      { name: '下载', url: f.proposal.attachmentUrl },
    ],
    text: '本次附件报告 公告 已发布',
  };
  if (management) {
    observation.url = f.proposal.targetUrl + '/management';
    observation.links!.push({ name: '本次附件报告', url: f.proposal.url });
    f.setHtml(
      '<link rel="canonical" href="/result"><article>本次附件报告 公告 <a href="/file">下载</a><a href="/edit">编辑</a></article>',
    );
  }
  const event = {
    taskId: f.taskId,
    runId: 'publish',
    actionId: 'submit',
    navigation: {
      id: randomUUID(),
      association: 'during-action' as const,
      targetId: 'page',
      sourceGeneration: 1,
      generation: 2,
      url: f.proposal.targetUrl + '/submit',
      mainFrame: true,
      sameDocument: false,
      inputEpoch: 8,
      observedAt: observation.observedAt,
    },
  };
  const arrive = () =>
    f.records.execute({
      kind: 'page',
      requestId: randomUUID(),
      taskId: f.taskId,
      url: observation.url,
      phase: 'manual',
    });
  const freeze = (source = observation, targetId = 'page') =>
    f.records.execution({
      kind: 'publication-result-entry',
      taskId: f.taskId,
      expectedVersion: f.execution().version,
      actionId: 'submit',
      source,
      binding: { targetId, generation: source.generation },
    });
  const pause = () => {
    f.records.execution({
      kind: 'suspend',
      taskId: f.taskId,
      requestId: randomUUID(),
      reason: 'page-change',
    });
    arrive();
    f.records.execution({ kind: 'action-navigation', ...event });
  };
  const service = (
    options: {
      beforeRecord?: (command: Record<string, unknown>) => Promise<void> | void;
      observe?: () => Promise<PageObservation>;
    } = {},
  ) => {
    let state = f.records.snapshot(),
      epoch = 12;
    const allow = vi.fn(() => {
      throw Error('NO_INPUT_ALLOW');
    });
    const prepare = vi.fn(() => {
      throw Error('NO_INPUT_PREPARE');
    });
    const propose = vi.fn(() => {
      throw Error('NO_MODEL');
    });
    const perform = vi.fn(() => {
      throw Error('NO_REDISPATCH');
    });
    const instance = new ExecutionService({
      records: async (command) => {
        await options.beforeRecord?.(command as Record<string, unknown>);
        return f.records.execution(command);
      },
      current: () => state,
      publish: (next) => {
        state = next;
      },
      observe: async () => ({
        observation: (await options.observe?.()) ?? observation,
        binding: { targetId: 'page', generation: 3 },
      }),
      material: (c) => f.records.material(c),
      propose,
      perform,
      revoke: () => {},
      stopModels: () => {},
      input: {
        epoch: () => epoch,
        block: () => {
          epoch++;
        },
        allow,
        prepare,
        valid: () => false,
        permit: () => {
          throw Error('NO_INPUT');
        },
      },
    });
    return {
      instance,
      allow,
      prepare,
      propose,
      perform,
      nativeChange: () => {
        epoch++;
      },
    };
  };
  return {
    ...f,
    observation,
    event,
    arrive,
    freeze,
    pause,
    dynamicService: service,
  };
}

test('动态结果入口在发布前未知，暂停后冻结并只读完成，不恢复原生输入或模型', async () => {
  const f = await dynamicResultFixture();
  expect(f.execution().actions.at(-1)!.submission!.recovery).toBeUndefined();
  const s = f.dynamicService();
  f.arrive();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.execution()).toMatchObject({
    phase: 'complete',
    result: { source: { url: f.proposal.url } },
  });
  const a = f.execution().actions.at(-1)!;
  expect(a.navigation!.association).toBe('during-action');
  expect(a.discoveredRecovery!.recovery.url).toBe(f.proposal.url);
  expect(a.navigationResolution).toBeUndefined();
  for (const spy of [s.allow, s.prepare, s.propose, s.perform])
    expect(spy).not.toHaveBeenCalled();
  await s.instance.stopAll();
});

test('动态检查点保存后冷开仅GET核对，旧发布不重发；24迁移留备份', async () => {
  const f = await dynamicResultFixture();
  f.pause();
  f.freeze();
  const before = f.execution().actions.at(-1)!.discoveredRecovery;
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.prepare('UPDATE workspace SET schema_version=24').run();
  db.close();
  f.reopen();
  const { readdir } = await import('node:fs/promises');
  expect(
    (await readdir(f.folder)).some((n) =>
      n.startsWith('workspace-before-dynamic-result-23-'),
    ),
  ).toBe(true);
  const s = f.dynamicService();
  s.instance.refresh();
  await s.instance.settled();
  expect(f.execution().phase).toBe('complete');
  expect(f.execution().actions.at(-1)!.discoveredRecovery).toEqual(before);
  expect(f.sends()).toBe(0);
  expect(s.perform).not.toHaveBeenCalled();
  await s.instance.stopAll();
});

test('动态入口缺原目标、重名目标、附件、确认内容、完整观察或同target证据均拒绝', async () => {
  const f = await dynamicResultFixture();
  f.pause();
  for (const source of [
    { ...f.observation, links: [] },
    {
      ...f.observation,
      links: [...f.observation.links!, f.observation.links![0]!],
    },
    { ...f.observation, links: [f.observation.links![0]!] },
    { ...f.observation, text: '别人的内容 公告' },
    { ...f.observation, truncated: true },
    { ...f.observation, generation: 1 },
  ]) {
    expect(() => f.freeze(source)).toThrow();
    expect(f.execution().actions.at(-1)!.discoveredRecovery).toBeUndefined();
  }
  expect(() => f.freeze(f.observation, 'other-target')).toThrow();
  expect(f.execution().phase).toBe('paused');
});

test('动态入口只是候选：公开页缺唯一canonical、内容或字节不符都不能完成', async () => {
  for (const failure of [
    'canonical',
    'duplicate-canonical',
    'content',
    'bytes',
  ]) {
    const f = await dynamicResultFixture();
    f.pause();
    f.freeze();
    if (failure === 'canonical')
      f.setHtml(
        '<article>本次附件报告 公告 <a href="/file">下载</a></article>',
      );
    if (failure === 'duplicate-canonical')
      f.setHtml(
        '<link rel="canonical" href="/result"><link rel="canonical" href="/result"><article>本次附件报告 公告 <a href="/file">下载</a></article>',
      );
    if (failure === 'content')
      f.setHtml('<link rel="canonical" href="/result"><p>别人的文章</p>');
    if (failure === 'bytes') f.setBytes(Buffer.from('different'));
    const s = f.dynamicService();
    s.instance.refresh();
    await s.instance.settled();
    expect(f.execution().publicationChecks).toMatchObject([
      { status: 'unknown' },
    ]);
    expect(f.execution().phase).toBe('paused');
    expect(f.execution().result).toBeUndefined();
    const reads = f.reads();
    s.instance.refresh();
    await s.instance.settled();
    expect(f.reads()).toBe(reads);
    await s.instance.stopAll();
  }
});

test('动态结果保存前的新停止拒绝入口；核对结果保存竞争只留历史，不完成或派发', async () => {
  const f = await dynamicResultFixture();
  f.pause();
  f.post({ kind: 'intent', intent: 'stop', requestId: randomUUID() });
  expect(f.freeze().created).toBe(false);
  const g = await dynamicResultFixture();
  g.pause();
  g.freeze();
  const s = g.dynamicService({
    beforeRecord: (c) => {
      if (c.kind === 'publication-recovery-result')
        g.post({ kind: 'intent', intent: 'stop', requestId: randomUUID() });
    },
  });
  s.instance.refresh();
  await s.instance.settled();
  expect(g.execution()).toMatchObject({
    intent: 'stopped',
    phase: 'stopped',
    publicationHistory: [{ check: { status: 'verified' } }],
  });
  expect(g.execution().result).toBeUndefined();
  expect(s.allow).not.toHaveBeenCalled();
  await s.instance.stopAll();
});

test('动态入口保存失败不发GET或输入；观察期间的原生变化放弃新候选', async () => {
  const f = await dynamicResultFixture();
  f.arrive();
  const s = f.dynamicService({
    beforeRecord: (c) => {
      if (c.kind === 'publication-result-entry')
        return Promise.reject(Error('DISK_FULL'));
      return Promise.resolve();
    },
  });
  const reads = f.reads();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.execution().actions.at(-1)!.discoveredRecovery).toBeUndefined();
  expect(f.reads()).toBe(reads);
  await s.instance.stopAll();
  const g = await dynamicResultFixture();
  g.arrive();
  const t = g.dynamicService({
    observe: () => {
      t.nativeChange();
      return Promise.resolve(g.observation);
    },
  });
  await t.instance.recordNavigation(g.event);
  await t.instance.suspend(g.taskId, 'page-change', randomUUID());
  await t.instance.settled();
  expect(g.execution().actions.at(-1)!.discoveredRecovery).toBeUndefined();
  expect(t.allow).not.toHaveBeenCalled();
  await t.instance.stopAll();
});

test('动态检查点进入真实备份导入；损坏目标引用拒绝冷开', async () => {
  const f = await dynamicResultFixture();
  f.pause();
  f.freeze();
  const file = path.join(f.folder, 'dynamic.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file,
  });
  const g = await fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  const restored = g.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(restored.restoreReview).toBe('required');
  expect(restored.actions.at(-1)!.discoveredRecovery).toEqual(
    f.execution().actions.at(-1)!.discoveredRecovery,
  );
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec(
    "UPDATE task_executions SET body=json_set(body,'$.actions[1].discoveredRecovery.recovery.targetFactId','00000000-0000-4000-8000-000000000000')",
  );
  db.close();
  expect(() => f.reopen()).toThrow('DATA_CORRUPT');
});

test('管理页从冻结确认内容唯一匹配结果链接，只读GET后完成；无输入或模型', async () => {
  const f = await dynamicResultFixture(true);
  const s = f.dynamicService();
  f.arrive();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.execution().phase).toBe('complete');
  expect(f.execution().actions.at(-1)).toMatchObject({
    status: 'confirmed',
    navigation: { association: 'during-action' },
    discoveredRecovery: {
      entry: { rule: 'confirmed-content-link-v1', name: '本次附件报告' },
      source: { url: f.observation.url },
      recovery: { url: f.proposal.url },
    },
  });
  expect(f.execution().result!.source.url).toBe(f.proposal.url);
  for (const spy of [s.allow, s.prepare, s.propose, s.perform])
    expect(spy).not.toHaveBeenCalled();
  await s.instance.stopAll();
});

test('管理页同名不同地址、重复URL、异站、片段、错误原目标和截断均拒绝保存', async () => {
  const f = await dynamicResultFixture(true);
  f.pause();
  const links = f.observation.links!;
  for (const source of [
    {
      ...f.observation,
      links: [
        ...links,
        { name: '本次附件报告', url: f.proposal.url + '-other' },
      ],
    },
    {
      ...f.observation,
      links: [...links, { name: '其它名称', url: f.proposal.url }],
    },
    {
      ...f.observation,
      links: [
        ...links.slice(0, 2),
        { name: '本次附件报告', url: 'https://other.invalid/result' },
      ],
    },
    {
      ...f.observation,
      links: [
        ...links.slice(0, 2),
        { name: '本次附件报告', url: f.proposal.url + '#fragment' },
      ],
    },
    { ...f.observation, links: links.slice(1) },
    { ...f.observation, truncated: true },
    { ...f.observation, text: '本次附件报告 已发布' },
  ]) {
    expect(() => f.freeze(source)).toThrow();
    expect(f.execution().actions.at(-1)!.discoveredRecovery).toBeUndefined();
  }
});

test('管理页链接保存后不因同名内容误认结果：公开页缺原编辑目标或重复目标保持未知', async () => {
  for (const targetLinks of [
    '',
    '<a href="/wrong">编辑</a>',
    '<a href="/edit">编辑</a><a href="/edit">重复</a>',
  ]) {
    const f = await dynamicResultFixture(true);
    f.pause();
    f.freeze();
    f.setHtml(
      '<link rel="canonical" href="/result"><article>本次附件报告 公告 <a href="/file">下载</a>' +
        targetLinks +
        '</article>',
    );
    const s = f.dynamicService();
    s.instance.refresh();
    await s.instance.settled();
    expect(f.execution().phase).toBe('paused');
    expect(f.execution().publicationChecks).toMatchObject([
      { status: 'unknown', checks: { target: false } },
    ]);
    expect(f.execution().actions.at(-1)!.status).toBe('unknown');
    await s.instance.stopAll();
  }
});

test('管理页检查点冷开只读核对且26迁移备份，不重发；真实备份导入保持待核对', async () => {
  const f = await dynamicResultFixture(true);
  f.pause();
  f.freeze();
  const before = f.execution().actions.at(-1)!.discoveredRecovery;
  const file = path.join(f.folder, 'management.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file,
  });
  const g = await fixture();
  await g.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file,
    checksum: saved.archive.checksum,
  });
  const restored = g.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(restored.restoreReview).toBe('required');
  expect(restored.actions.at(-1)!.discoveredRecovery).toEqual(before);
  f.records.close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=26');
  db.close();
  f.reopen();
  const { readdir } = await import('node:fs/promises');
  expect(
    (await readdir(f.folder)).some((n) =>
      n.startsWith('workspace-before-management-result-23-'),
    ),
  ).toBe(true);
  const s = f.dynamicService();
  s.instance.refresh();
  await s.instance.settled();
  expect(f.execution().phase).toBe('complete');
  expect(f.sends()).toBe(0);
  expect(f.execution().actions.at(-1)!.discoveredRecovery).toEqual(before);
  await s.instance.stopAll();
});

test('管理页损坏链接名称或结果地址不能在冷开伪装可信检查点', async () => {
  for (const field of ['entry.name', 'recovery.url']) {
    const f = await dynamicResultFixture(true);
    f.pause();
    f.freeze();
    f.records.close();
    const db = new Database(path.join(f.folder, 'workspace.sqlite'));
    db.prepare('UPDATE task_executions SET body=json_set(body,?,?)').run(
      '$.actions[1].discoveredRecovery.' + field,
      field === 'entry.name' ? '别人的标题' : f.proposal.url + '-other',
    );
    db.close();
    expect(() => f.reopen()).toThrow('DATA_CORRUPT');
  }
});

test('管理页保存失败不读取候选；保存期间停止不能完成旧任务', async () => {
  const f = await dynamicResultFixture(true);
  f.arrive();
  const s = f.dynamicService({
    beforeRecord: (c) => {
      if (c.kind === 'publication-result-entry') throw Error('DISK_FULL');
    },
  });
  const reads = f.reads();
  await s.instance.recordNavigation(f.event);
  await s.instance.suspend(f.taskId, 'page-change', randomUUID());
  await s.instance.settled();
  expect(f.reads()).toBe(reads);
  expect(f.execution().actions.at(-1)!.discoveredRecovery).toBeUndefined();
  await s.instance.stopAll();
  const g = await dynamicResultFixture(true);
  g.pause();
  g.freeze();
  const t = g.dynamicService({
    beforeRecord: (c) => {
      if (c.kind === 'publication-recovery-result')
        g.post({ kind: 'intent', intent: 'stop', requestId: randomUUID() });
    },
  });
  t.instance.refresh();
  await t.instance.settled();
  expect(g.execution()).toMatchObject({
    intent: 'stopped',
    phase: 'stopped',
    publicationHistory: [{ check: { status: 'verified' } }],
  });
  expect(g.execution().result).toBeUndefined();
  await t.instance.stopAll();
});
