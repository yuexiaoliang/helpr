import { ExecutionService } from '../../app/desktop/execution-service';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRecords } from '../../app/records/workspace';
import { type AgreementTerms } from '../../app/shared/agreement';
import { validAgreementCatalog } from '../../app/records/agreement';
import {
  contentRequestText,
  type ContentSource,
} from '../../app/shared/article';
import { pageSourceSchema } from '../../app/shared/model';
import type { Publication } from '../../app/shared/publication';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'helpr-agreement-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.xlsx');
  const bytes = await readFile('tests/workspace/fixtures/excel/report-a.xlsx');
  await writeFile(file, bytes);
  let records = new WorkspaceRecords(dir, 'app/records/migrations');
  cleanup.push(() => {
    records.close();
    return Promise.resolve();
  });
  const owner = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: '以后发布表格文章',
  }).taskId;
  records.execution({
    kind: 'intent',
    taskId: owner,
    requestId: randomUUID(),
    intent: 'stop',
  });
  const get = (id = owner) =>
    records.snapshot().tasks.find((t) => t.id === id)!.execution!;
  const terms: AgreementTerms = {
    selection: { scope: dir, rule: 'only', name: null, extension: '.xlsx' },
    entryUrl: 'https://example.com/edit',
    destination: '公告',
    contentRules: '按原表逐行说明数量，不采用公式缓存',
    changedBytes: 'new-publication',
    period: 'once-per-material',
  };
  const propose = (overrides = {}) => {
    records.execution({
      kind: 'agreement-propose',
      taskId: owner,
      requestId: randomUUID(),
      expectedVersion: get().version,
      text: '以后按这套要求自动发布',
      terms: { ...terms, ...overrides },
    });
    return get().agreements!.at(-1)!;
  };
  let a = propose();
  const accept = () =>
    records.execution({
      kind: 'agreement-accept',
      taskId: owner,
      requestId: randomUUID(),
      versionId: a.versionId,
    });
  const use = (extra = {}) =>
    records.execution({
      kind: 'agreement-use',
      taskId: owner,
      requestId: randomUUID(),
      versionId: a.versionId,
      ...extra,
    }).taskId as string;
  const post = (id: string, c: Record<string, unknown>) =>
    records.execution({
      taskId: id,
      ...(['intent', 'reported'].includes(String(c.kind))
        ? {}
        : { runId: 'run' }),
      ...c,
    });
  const select = async (id: string) => {
    const t = a.terms;
    records.execute({
      kind: 'page',
      requestId: randomUUID(),
      taskId: id,
      url: t.entryUrl,
      phase: 'manual',
    });
    if (!get(id).materials?.length)
      await records.material({
        kind: 'agreement-select',
        taskId: id,
        expectedVersion: get(id).version,
      });
    if (!get(id).duplicateWork) {
      if (get(id).recoveryPending)
        records.execution({
          kind: 'recover',
          taskId: id,
          expectedVersion: get(id).version,
        });
      post(id, { kind: 'claim' });
    }
  };
  const observation = () => ({
    url: a.terms.entryUrl,
    title: '编辑',
    links: [{ name: '附件已上传', url: 'https://example.com/file' }],
    fingerprint: 'fixture',
    generation: 1,
    observedAt: Date.now(),
    truncated: false,
    text: `编辑\n[file 0] ${a.terms.entryUrl}\n甲的数量为 7。\n${a.terms.destination}\n附件已上传\n[link-url] https://example.com/file\n已发布`,
  });
  records.model({
    kind: 'configuration',
    requestId: randomUUID(),
    protocol: 'chat-completions',
    endpoint: 'http://127.0.0.1:9999/v1',
    model: 'fixture',
    hash: 'config',
    expectedVersion: 0,
    ciphertext: 'fake',
  });
  const review = async (id: string, destination = a.terms.destination) => {
    const m = get(id).materials![0]!;
    const { source } = (await records.material({
      kind: 'parse',
      taskId: id,
      runId: 'run',
      materialId: m.id,
    })) as unknown as { source: ContentSource };
    const call = randomUUID();
    const draft = {
      destination: a.terms.destination,
      blocks: [
        {
          kind: 'fact',
          text: '甲的数量为 7。',
          citations: [{ sheet: '数据', address: 'B2', quote: '7' }],
        },
      ],
    };
    records.model({
      kind: 'begin',
      id: call,
      taskId: id,
      text: contentRequestText(source),
      purpose: 'execution',
      usageKind: 'material-content',
    });
    records.model({
      kind: 'dispatch',
      id: call,
      source: pageSourceSchema.strip().parse(observation()),
      reservedTokens: 100,
    });
    records.model({
      kind: 'progress',
      id: call,
      output: JSON.stringify({ article: draft }),
    });
    records.model({
      kind: 'finish',
      id: call,
      phase: 'complete',
      error: null,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
    post(id, {
      kind: 'article-generated',
      sourceId: source.id,
      draft,
      modelCallId: call,
    });
    post(id, {
      kind: 'reserve',
      id: 'upload',
      summary: '上传',
      binding: { targetId: id, generation: 1 },
      source: {
        ...observation(),
        links: [],
        text: `编辑\n[file 0] ${a.terms.entryUrl}`,
      },
      action: { kind: 'upload', materialId: m.id, target: { fileIndex: 0 } },
    });
    post(id, { kind: 'dispatch', id: 'upload' });
    post(id, { kind: 'reported', id: 'upload', returned: true });
    post(id, {
      kind: 'preparation-observed',
      source: observation(),
      facts: [
        {
          kind: 'target',
          url: a.terms.entryUrl,
          materialId: null,
          evidence: ['编辑'],
        },
        {
          kind: 'upload',
          url: 'https://example.com/file',
          materialId: m.id,
          evidence: ['附件已上传'],
        },
      ],
    });
    post(id, {
      kind: 'resolve',
      id: 'upload',
      source: observation(),
      binding: { targetId: id, generation: 1 },
      download: {
        url: 'https://example.com/file',
        sha256: m.sha256,
        bytes: m.bytes,
        checkedAt: Date.now(),
      },
      evidence: ['附件已上传'],
    });
    const article = get(id).articles![0]!;
    const p: Publication = {
      articleId: article.id,
      content: article.content,
      destination,
      attachment: {
        materialId: m.id,
        targetUrl: a.terms.entryUrl,
        url: 'https://example.com/file',
      },
    };
    post(id, {
      kind: 'ask',
      type: 'review',
      questionId: randomUUID(),
      url: a.terms.entryUrl,
      text: '确认',
      publication: p,
    });
    return p;
  };
  const reserve = (id: string, p: Publication) =>
    post(id, {
      kind: 'reserve',
      id: 'submit',
      summary: '发布',
      action: { kind: 'click', target: { role: 'button', name: '发布' } },
      effect: 'publication',
      binding: { targetId: id, generation: 1 },
      source: observation(),
      publication: p,
      approvalId: get(id).publication!.approvalId,
      download: {
        url: p.attachment!.url,
        sha256: get(id).materials![0]!.sha256,
        bytes: bytes.length,
        checkedAt: Date.now() - 100,
      },
      evidence: ['编辑'],
    });
  const complete = (
    id: string,
    status: 'verified' | 'unknown' = 'verified',
  ) => {
    const e = get(id),
      p = e.publication!,
      m = e.materials![0]!;
    return post(id, {
      kind: 'publication-result',
      check: {
        id: randomUUID(),
        actionId: 'submit',
        approvalId: p.approvalId,
        materialId: m.id,
        goalVersion: 1,
        status,
        proposal: {
          url: 'https://example.com/result',
          targetUrl: p.attachment!.targetUrl,
          attachmentUrl: p.attachment!.url,
          publishedEvidence: ['已发布'],
        },
        source: pageSourceSchema.strip().parse(observation()),
        checkedAt: Date.now(),
        download: {
          url: p.attachment!.url,
          sha256: m.sha256,
          bytes: m.bytes,
          checkedAt: Date.now(),
        },
        pageSha256: 'a'.repeat(64),
        checks: {
          target: true,
          published: true,
          content: status === 'verified',
          destination: true,
          attachment: true,
          bytes: true,
        },
        failure: status === 'verified' ? 'none' : 'content',
        coverage: 'public-page-and-attachment',
        extraResults: [],
        anomalies: [],
        unobservedWrites: 'unknown',
        screenshot: 'not-required',
      },
    });
  };
  return {
    dir,
    file,
    owner,
    bytes,
    get,
    accept,
    use,
    select,
    review,
    post,
    reserve,
    complete,
    get records() {
      return records;
    },
    get agreement() {
      return a;
    },
    change: (v: Partial<AgreementTerms>) => {
      a = propose(v);
      return a;
    },
    revoke: () =>
      records.execution({
        kind: 'agreement-revoke',
        taskId: owner,
        requestId: randomUUID(),
        versionId: a.versionId,
      }),
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(dir, 'app/records/migrations');
    },
  };
}

test('待接受复述没有权限；显式接受版本后才可领取且回执重送不创建第二任务', async () => {
  const f = await fixture();
  expect(() => f.use()).toThrow('AGREEMENT_EXPIRED');
  f.accept();
  const command = {
    kind: 'agreement-use',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: f.agreement.versionId,
  };
  const first = f.records.execution(command);
  expect(f.records.execution(command).taskId).toBe(first.taskId);
  expect(f.records.snapshot().tasks).toHaveLength(2);
  expect(() =>
    f.records.execution({ ...command, periodKey: 'different' }),
  ).toThrow('REQUEST_CONTENT_CONFLICT');
});

test('符合约定的有来源新文章自动确认，编辑/改目标不继承；网页流程不授予权限', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  expect(f.get(id).question).toBeUndefined();
  expect(f.get(id).publication!.agreementVersionId).toBe(f.agreement.versionId);
  f.reserve(id, p);
  f.post(id, { kind: 'dispatch', id: 'submit' });
  f.complete(id);
  expect(f.get(id).materialWorks![0]!.status).toBe('complete');
  expect(f.get(id).materialWorks![0]!.resultId).toBe(
    f.get(id).publicationChecks![0]!.id,
  );
  f.post(id, {
    kind: 'intent',
    intent: 'revise',
    requestId: randomUUID(),
    text: '改发到其它栏目',
  });
  expect(f.get(id).agreementBinding).toBeUndefined();
  expect(f.get(id).publication).toBeUndefined();
});

test('同内容改名仍返回已完成 A；不同目标 B 独立领取；明确再发形成新意图', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  f.reserve(id, p);
  f.post(id, { kind: 'dispatch', id: 'submit' });
  f.complete(id);
  await rename(f.file, path.join(f.dir, 'renamed.xlsx'));
  const duplicate = f.use();
  await f.select(duplicate);
  expect(f.get(duplicate).duplicateWork!.taskId).toBe(id);
  expect(f.get(duplicate).actions).toEqual([]);
  const repeat = f.use({ repeatOf: f.get(id).materialWorks![0]!.id });
  await f.select(repeat);
  expect(f.get(repeat).materialWorks![0]!.key).not.toBe(
    f.get(id).materialWorks![0]!.key,
  );
  f.change({ destination: '通知' });
  f.accept();
  const other = f.use();
  await f.select(other);
  expect(f.get(other).duplicateWork).toBeUndefined();
  expect(f.get(other).materialWorks).toHaveLength(1);
});

test.each(['pending', 'stopped', 'unknown'])(
  '同一工作 %s 状态的重复通知不另发，未核对完成不能再发',
  async (state) => {
    const f = await fixture();
    f.accept();
    const id = f.use();
    await f.select(id);
    if (state === 'pending')
      f.post(id, { kind: 'finish', phase: 'paused', summary: '等待确认' });
    if (state === 'stopped')
      f.post(id, { kind: 'intent', intent: 'stop', requestId: randomUUID() });
    if (state === 'unknown') {
      const p = await f.review(id);
      f.reserve(id, p);
      f.post(id, { kind: 'dispatch', id: 'submit' });
      f.complete(id, 'unknown');
    }
    const b = f.use();
    await f.select(b);
    expect(f.get(b).duplicateWork!.taskId).toBe(id);
    expect(() => f.use({ repeatOf: f.get(id).materialWorks![0]!.id })).toThrow(
      'MATERIAL_WORK_UNSETTLED',
    );
  },
);

test('撤销在预留后使旧派发失效，单次确认与已送出的结果分别处理', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  f.reserve(id, p);
  f.revoke();
  expect(f.get(id).actions.at(-1)!.status).toBe('cancelled');
  expect(f.get(id).publication!.approvalId).toBeNull();
  expect(f.get(id).question!.type).toBe('review');
  expect(f.post(id, { kind: 'dispatch', id: 'submit' }).permitted).toBe(false);
  expect(() => f.use()).toThrow('AGREEMENT_EXPIRED');
  expect(() =>
    f.records.execution({
      kind: 'agreement-accept',
      taskId: f.owner,
      requestId: randomUUID(),
      versionId: f.agreement.versionId,
    }),
  ).toThrow('AGREEMENT_EXPIRED');
});

test('已送出后撤销，迟到核对只记录原工作完成，不恢复自动执行', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  f.reserve(id, p);
  f.post(id, { kind: 'dispatch', id: 'submit' });
  f.revoke();
  f.complete(id);
  expect(f.get(id).materialWorks![0]!.status).toBe('complete');
  expect(f.get(id).runId).toBeNull();
  expect(f.get(id).actions).toHaveLength(2);
});

test('同名不同字节是新版本；先确认策略与期次约束不会被文件变化覆盖', async () => {
  const f = await fixture();
  f.change({ changedBytes: 'ask', period: 'per-period' });
  f.accept();
  expect(() => f.use()).toThrow('AGREEMENT_PERIOD_REQUIRED');
  const a = f.use({ periodKey: '日报-01' });
  await f.select(a);
  f.post(a, { kind: 'finish', phase: 'paused', summary: '等待' });
  const next = f.use({ periodKey: '日报-02' });
  await f.select(next);
  f.post(next, { kind: 'finish', phase: 'paused', summary: '等待' });
  expect(f.get(next).materialWorks![0]!.key).not.toBe(
    f.get(a).materialWorks![0]!.key,
  );
  await writeFile(
    f.file,
    await readFile('tests/workspace/fixtures/excel/report-b.xlsx'),
  );
  const changed = f.use({ periodKey: '日报-01' });
  await f.select(changed);
  expect(f.get(changed).materialWorks![0]!.requiresReview).toBe(true);
  expect(f.get(changed).publication).toBeUndefined();
});

test('备份、恢复、冷开保留版本、撤销与最小完成事实，拒绝破坏跨任务归属', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  f.reserve(id, p);
  f.post(id, { kind: 'dispatch', id: 'submit' });
  f.complete(id);
  f.revoke();
  const before = structuredClone(f.get(id).materialWorks);
  f.reopen();
  expect(f.get(id).materialWorks).toEqual(before);
  const archive = path.join(f.dir, 'archive.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file: archive,
  });
  const target = await fixture();
  await target.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive,
    checksum: saved.archive.checksum,
  });
  expect(target.get(id).materialWorks).toEqual(before);
  const rows = target.records
    .snapshot()
    .tasks.map((t) => ({ taskId: t.id, execution: t.execution }));
  expect(validAgreementCatalog(rows)).toBe(true);
  rows.find(
    (r) => r.taskId === id,
  )!.execution!.materialWorks![0]!.binding.ownerTaskId = randomUUID();
  expect(validAgreementCatalog(rows)).toBe(false);
});

test('并发固定相同素材只有一个工作归属，旧版本取材回执不越过停止', async () => {
  const f = await fixture();
  f.accept();
  const a = f.use(),
    b = f.use();
  await Promise.all(
    [a, b].map((taskId) =>
      f.records.material({
        kind: 'agreement-select',
        taskId,
        expectedVersion: f.get(taskId).version,
      }),
    ),
  );
  const works = [f.get(a), f.get(b)];
  expect(works.filter((e) => e.materialWorks?.length)).toHaveLength(1);
  expect(works.filter((e) => e.duplicateWork)).toHaveLength(1);
  const c = f.use();
  const version = f.get(c).version;
  f.post(c, { kind: 'intent', intent: 'stop', requestId: randomUUID() });
  await expect(
    f.records.material({
      kind: 'agreement-select',
      taskId: c,
      expectedVersion: version,
    }),
  ).rejects.toThrow('EXECUTION_STOPPED');
  expect(f.get(c).materials).toBeUndefined();
});

test('明确再发使用已保存的固定版本，源文件后来替换不改变这份意图', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  const p = await f.review(id);
  f.reserve(id, p);
  f.post(id, { kind: 'dispatch', id: 'submit' });
  f.complete(id);
  await writeFile(f.file, 'source replaced');
  const repeat = f.use({ repeatOf: f.get(id).materialWorks![0]!.id });
  expect(f.get(repeat).materials![0]!.sha256).toBe(
    f.get(id).materials![0]!.sha256,
  );
  expect(
    await f.records.material({
      kind: 'verify',
      taskId: repeat,
      materialId: f.get(repeat).materials![0]!.id,
      goalVersion: 1,
    }),
  ).toMatchObject({ valid: true });
});

test('撤销先同步阻断所有关联任务，再等待可靠保存；期间新停止不被迟到回执解除', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await f.select(id);
  await f.review(id);
  let state = f.records.snapshot();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoked: string[] = [];
  const service = new ExecutionService({
    records: async (c) => {
      if ((c as { kind: string }).kind === 'agreement-revoke') await gate;
      return f.records.execution(c);
    },
    current: () => state,
    publish: (next) => {
      state = next;
    },
    observe: () => Promise.reject(Error('NO_WEB_ACTION_EXPECTED')),
    propose: () => Promise.reject(Error('NO_MODEL_EXPECTED')),
    perform: () => Promise.reject(Error('NO_WEB_ACTION_EXPECTED')),
    revoke: (taskId) => {
      revoked.push(taskId);
    },
    stopModels: () => {},
  });
  const pending = service.agreement({
    kind: 'agreement-revoke',
    taskId: f.owner,
    requestId: randomUUID(),
    versionId: f.agreement.versionId,
  });
  expect(revoked).toContain(id);
  expect(f.get().agreements![0]!.revokedAt).toBeNull();
  expect(service.canExit()).toBe(false);
  await service.intent({
    kind: 'execution-intent',
    intent: 'stop',
    taskId: id,
    requestId: randomUUID(),
  });
  release();
  await pending;
  expect(f.get(id).intent).toBe('stopped');
  expect(
    service.decorate(state).tasks.find((t) => t.id === id)!.executionControl!
      .blocked,
  ).toBe(true);
  expect(f.get(id).publication!.approvalId).toBeNull();
});

test('按约定创建的新任务先准备原生资格再调用模型，不停留在 checking', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  f.records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId: id,
    url: 'https://example.com/new-target',
    phase: 'manual',
  });
  let state = f.records.snapshot(),
    allowed = false,
    proposals = 0;
  const sequence: string[] = [];
  const service = new ExecutionService({
    records: (c) => Promise.resolve(f.records.execution(c)),
    material: (c) => f.records.material(c),
    current: () => state,
    publish: (next) => {
      state = next;
    },
    input: {
      prepare: () => {
        sequence.push('prepare');
        return Promise.resolve(7);
      },
      block: () => {
        allowed = false;
      },
      allow: (_taskId, epoch) => {
        sequence.push('allow');
        allowed = epoch === 7;
        return allowed;
      },
      epoch: () => 7,
      valid: () => allowed,
      permit: (_taskId, _epoch, send) => {
        if (!allowed) throw Error('INPUT_CHANGED');
        return send();
      },
    },
    observe: () =>
      Promise.resolve({
        observation: {
          url: 'https://example.com/new-target',
          title: '编辑',
          text: '编辑',
          fingerprint: 'fixture',
          generation: 1,
          observedAt: Date.now(),
          truncated: false,
        },
        binding: { targetId: id, generation: 1 },
      }),
    propose: () => {
      expect(allowed).toBe(true);
      proposals++;
      return Promise.resolve({
        decision: 'ask',
        summary: '补充说明',
        action: null,
        previous: null,
        evidence: ['编辑'],
      });
    },
    perform: () => Promise.reject(Error('NO_WRITE_EXPECTED')),
    revoke: () => {},
    stopModels: () => {},
  });
  service.refresh();
  await service.settled();
  expect(sequence).toEqual(['prepare', 'allow']);
  expect(proposals).toBe(1);
  expect(f.get(id).phase).toBe('paused');
  expect(f.get(id).question!.text).toBe('补充说明');
});

test('缺素材后补充回复可重新取材，新增要求仍需单次内容确认', async () => {
  const f = await fixture();
  f.accept();
  const id = f.use();
  await rm(f.file);
  await f.records.material({
    kind: 'agreement-select',
    taskId: id,
    expectedVersion: f.get(id).version,
  });
  const question = f.get(id).question!;
  expect(question).toBeDefined();
  await writeFile(f.file, f.bytes);
  f.records.execution({
    kind: 'participation-reply',
    taskId: id,
    questionId: question.id,
    text: '素材已经补齐，这一篇请先让我确认。',
  });
  await f.select(id);
  expect(f.get(id).materialWorks).toHaveLength(1);
  await f.review(id);
  expect(f.get(id).question?.type).toBe('review');
  expect(f.get(id).publication?.agreementVersionId).toBeUndefined();
});

test('同站不同入口的同名栏目分别归属，不能用域名全局去重', async () => {
  const f = await fixture();
  f.accept();
  const first = f.use();
  await f.select(first);
  f.change({ entryUrl: 'https://example.com/second-site/new' });
  f.accept();
  const second = f.use();
  await f.select(second);
  expect(f.get(second).duplicateWork).toBeUndefined();
  expect(f.get(first).materialWorks![0]!.key).not.toBe(
    f.get(second).materialWorks![0]!.key,
  );
});

test('另发或再发的约定不能自动覆盖已知发布过的同一远程记录', async () => {
  const f = await fixture();
  f.accept();
  const first = f.use();
  await f.select(first);
  const p = await f.review(first);
  f.reserve(first, p);
  f.post(first, { kind: 'dispatch', id: 'submit' });
  f.complete(first);
  const repeat = f.use({ repeatOf: f.get(first).materialWorks![0]!.id });
  await f.select(repeat);
  await f.review(repeat);
  expect(f.get(repeat).publication!.approvalId).toBeNull();
  expect(f.get(repeat).question!.type).toBe('review');
});
