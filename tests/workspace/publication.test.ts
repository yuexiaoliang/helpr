import { afterEach, expect, test } from 'vitest';
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
} from '../../app/desktop/publication-verifier';
import type {
  Publication,
  PublicationCheck,
} from '../../app/shared/publication';
import type { NextStep } from '../../app/shared/execution';
import type { PageObservation } from '../../app/shared/model';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
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
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
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
      ...(['intent', 'reported'].includes(String(c.kind))
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
    text: `编辑附件\n[file 0] ${base}/edit\n本次附件报告\n公告\n附件已上传\n[link-url] ${base}/file\n${published ? '已发布\n[link-url] ' + base + '/result' : '准备发布'}`,
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
    source: { ...observe(), text: '编辑附件\n[file 0] ' + base + '/edit' },
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
    records,
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
