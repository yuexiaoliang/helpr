import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { parseExcel } from '../../app/records/excel';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  checkArticleDraft,
  validArticleReferences,
} from '../../app/records/article';
import {
  contentRequestText,
  articleText,
  type ArticleDraft,
  type ContentSource,
} from '../../app/shared/article';
import {
  verifyAttachment,
  verifyPublication,
} from '../../app/desktop/publication-verifier';
import type { Publication } from '../../app/shared/publication';
import { pageSourceSchema, type PageObservation } from '../../app/shared/model';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const bytes = (name: string) =>
  readFile(path.join('tests/workspace/fixtures/excel', name));

test.each(['1900', '1904'])(
  '代表性 XLSX：%s 日期、缺缓存、共享/数组、空白和隐藏值明确区分',
  async (system) => {
    const data = await parseExcel(
      await bytes(`edges-${system}.xlsx`),
      'book.xlsx',
    );
    expect(data.dateSystem).toBe(system);
    const cell = (address: string) =>
      data.sheets[0]!.cells.find((c) => c.address === address)!;
    expect(cell('A1')).toMatchObject({
      raw: 1,
      display: system === '1900' ? '1900-01-01' : '1904-01-02',
    });
    expect(cell('A2').status).toBe(
      system === '1900' ? 'date-invalid' : 'value',
    );
    expect(cell('B1')).toMatchObject({ raw: 0, status: 'value' });
    expect(cell('C1')).toMatchObject({ raw: false, status: 'value' });
    expect(cell('D1').raw).toBe('');
    expect(cell('G1')).toMatchObject({ raw: null, status: 'blank' });
    expect(cell('E1')).toMatchObject({ display: '#DIV/0!', status: 'error' });
    expect(cell('F1')).toMatchObject({ raw: 0.125, display: '12.50%' });
    for (const address of ['B2', 'C2', 'D2', 'E2', 'F2', 'D3', 'E3'])
      expect(cell(address)).toMatchObject({
        raw: null,
        status: 'formula-unverified',
      });
    expect(cell('C3')).toMatchObject({ status: 'merged', master: 'B3' });
    expect(cell('H1').status).toBe('hidden');
    expect(cell('A4').status).toBe('hidden');
    expect(data.recalculated).toBe(false);
  },
);

test.each([
  ['external.xlsx', 'EXCEL_UNSUPPORTED'],
  ['oversize-range.xlsx', 'EXCEL_LIMIT'],
  ['inflated.xlsx', 'EXCEL_LIMIT'],
])('拒绝 %s，不能截断后继续生成', async (name, code) => {
  await expect(parseExcel(await bytes(name), name)).rejects.toThrow(code);
});
test('旧格式、伪装文件与损坏 ZIP 不进入内容生成', async () => {
  await expect(
    parseExcel(await bytes('report-a.xlsx'), 'old.xls'),
  ).rejects.toThrow('EXCEL_UNSUPPORTED');
  await expect(parseExcel(Buffer.from('a,b,c'), 'fake.xlsx')).rejects.toThrow(
    'EXCEL_UNSUPPORTED',
  );
  await expect(
    parseExcel(Buffer.from('PKbroken'), 'broken.xlsx'),
  ).rejects.toThrow('EXCEL_INVALID');
});

const draft = (a = 7, b = 5): ArticleDraft => ({
  destination: '公告',
  blocks: [
    {
      kind: 'fact',
      text: `甲的数量为 ${a}。乙的数量为 ${b}。`,
      citations: [
        { sheet: '数据', address: 'A2', quote: '甲' },
        { sheet: '数据', address: 'B2', quote: String(a) },
        { sheet: '数据', address: 'A3', quote: '乙' },
        { sheet: '数据', address: 'B3', quote: String(b) },
      ],
    },
    { kind: 'suggestion', text: '核对尚未确定的合计后再补充。', citations: [] },
  ],
});

async function fixture(name = 'report-a.xlsx', base = 'https://example.com') {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-article-'));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, name);
  await writeFile(file, await bytes(name));
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanups.push(() => {
    records.close();
    return Promise.resolve();
  });
  const taskId = records.execute({
    kind: 'create',
    requestId: randomUUID(),
    goal: `读取“${file}”成文，发布到 ${base}/edit 的公告栏目，包含原始附件。`,
  }).taskId;
  records.execute({
    kind: 'page',
    requestId: randomUUID(),
    taskId,
    url: base + '/edit',
    phase: 'manual',
  });
  const post = (c: Record<string, unknown>) =>
    records.execution({ taskId, runId: 'prepare', ...c });
  records.execution({
    kind: 'intent',
    taskId,
    requestId: randomUUID(),
    intent: 'start',
  });
  post({ kind: 'claim' });
  await records.material({
    kind: 'select',
    taskId,
    runId: 'prepare',
    selection: {
      scope: file,
      rule: 'exact',
      name: null,
      extension: null,
      basis: `读取“${file}”`,
    },
  });
  const execution = () =>
    records.snapshot().tasks.find((t) => t.id === taskId)!.execution!;
  const material = execution().materials![0]!;
  const parsed = (await records.material({
    kind: 'parse',
    taskId,
    runId: 'prepare',
    materialId: material.id,
  })) as { source: ContentSource };
  const source = parsed.source;
  const observation = (): PageObservation => ({
    url: base + '/edit',
    title: '编辑',
    fingerprint: 'page',
    generation: 1,
    observedAt: Date.now(),
    truncated: false,
    text: `编辑\n[file 0] ${base}/edit\n${execution().publication?.content ?? articleText(draft())}\n公告\n附件已上传\n[link-url] ${base}/file\n已发布\n[link-url] ${base}/result`,
  });
  records.model({
    kind: 'configuration',
    protocol: 'chat-completions',
    endpoint: 'http://127.0.0.1:9999/v1',
    model: 'fixture',
    requestId: randomUUID(),
    hash: 'configuration',
    expectedVersion: 0,
    ciphertext: 'fake',
  });
  const generate = (value: ArticleDraft) => {
    const callId = randomUUID();
    records.model({
      kind: 'begin',
      id: callId,
      taskId,
      text: contentRequestText(source),
      purpose: 'execution',
      usageKind: 'material-content',
    });
    records.model({
      kind: 'dispatch',
      id: callId,
      source: pageSourceSchema.strip().parse(observation()),
      reservedTokens: 1000,
    });
    records.model({
      kind: 'progress',
      id: callId,
      output: JSON.stringify({ article: value }),
    });
    records.model({
      kind: 'finish',
      id: callId,
      phase: 'complete',
      error: null,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
    post({
      kind: 'article-generated',
      sourceId: source.id,
      draft: value,
      modelCallId: callId,
    });
  };
  const review = () => {
    const article = execution().articles!.at(-1)!;
    post({
      kind: 'reserve',
      id: 'upload',
      summary: '上传附件',
      source: { ...observation(), text: '编辑\n[file 0] ' + base + '/edit' },
      binding: { targetId: 'page', generation: 1 },
      action: {
        kind: 'upload',
        materialId: material.id,
        target: { fileIndex: 0 },
      },
    });
    post({ kind: 'dispatch', id: 'upload' });
    records.execution({
      kind: 'reported',
      taskId,
      id: 'upload',
      returned: true,
    });
    post({
      kind: 'preparation-observed',
      source: observation(),
      facts: [
        {
          kind: 'target',
          url: base + '/edit',
          materialId: null,
          evidence: ['编辑'],
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
      source: observation(),
      evidence: ['附件已上传'],
    });
    const publication: Publication = {
      articleId: article.id,
      content: article.content,
      destination: article.destination,
      attachment: {
        materialId: material.id,
        targetUrl: base + '/edit',
        url: base + '/file',
      },
    };
    post({
      kind: 'ask',
      type: 'review',
      questionId: randomUUID(),
      text: '请确认',
      url: base + '/edit',
      publication,
    });
    return publication;
  };
  const decide = (operation: 'approve' | 'edit', extra = {}) =>
    records.execution({
      kind: 'participation-decision',
      taskId,
      questionId: execution().question!.id,
      operation,
      ...extra,
    });
  return {
    folder,
    file,
    get records() {
      return records;
    },
    taskId,
    execution,
    source,
    material,
    post,
    generate,
    review,
    decide,
    observation,
    reopen: () => {
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
    },
  };
}

test.each([
  ['report-a.xlsx', 7, 5],
  ['report-b.xlsx', 11, 2],
] as const)(
  '读取固定素材 %s 并保存要求、解析版本和实际事实',
  async (name, a, b) => {
    const f = await fixture(name);
    await writeFile(
      f.file,
      await bytes(name === 'report-a.xlsx' ? 'report-b.xlsx' : 'report-a.xlsx'),
    );
    f.generate(draft(a, b));
    expect(f.execution().articles![0]!.content).toContain(`甲的数量为 ${a}`);
    expect(f.source.sheets[0]!.cells.find((c) => c.address === 'B2')!.raw).toBe(
      a,
    );
    expect(f.source.requirements.goal).toContain(f.file);
    expect(f.source.materialSha256).toBe(f.material.sha256);
    expect(f.execution().publication?.approvalId).toBeUndefined();
    expect(validArticleReferences(f.execution())).toBe(true);
  },
);

test('数字、引用、公式缓存不匹配时保留失败而不产生文章或确认', async () => {
  const f = await fixture();
  const altered = draft();
  altered.blocks[0]!.text = '甲的数量为 999。';
  expect(() => f.generate(altered)).toThrow('ARTICLE_FACT_INVALID');
  const cached = draft();
  cached.blocks[0]!.citations = [
    { sheet: '数据', address: 'B4', quote: '999' },
  ];
  expect(() => checkArticleDraft(f.source, cached)).toThrow(
    'ARTICLE_FACT_INVALID',
  );
  const missing = draft();
  missing.blocks[0]!.citations = [];
  expect(() => checkArticleDraft(f.source, missing)).toThrow(
    'ARTICLE_FACT_INVALID',
  );
  expect(f.execution().articles).toBeUndefined();
  expect(f.execution().materialProcessing).toBeUndefined();
});

test('改稿、跨任务、迟到确认与回执丢失；冷开保留有效确认和来源', async () => {
  const f = await fixture();
  f.generate(draft());
  f.review();
  const old = f.execution().question!.id;
  const other = await fixture('report-b.xlsx');
  other.generate(draft(11, 2));
  other.review();
  expect(() =>
    other.records.execution({
      kind: 'participation-decision',
      taskId: other.taskId,
      questionId: old,
      operation: 'approve',
    }),
  ).toThrow('PARTICIPATION_EXPIRED');
  f.decide('edit', { content: '经本人编辑：甲为七，乙为五，待核对合计。' });
  expect(f.execution().articles).toHaveLength(2);
  expect(f.execution().articles![1]!.blocks).toEqual([]);
  expect(() =>
    f.records.execution({
      kind: 'participation-decision',
      taskId: f.taskId,
      questionId: old,
      operation: 'approve',
    }),
  ).toThrow('REQUEST_CONTENT_CONFLICT');
  const questionId = f.execution().question!.id;
  f.decide('approve');
  expect(
    f.records.execution({
      kind: 'participation-decision',
      taskId: f.taskId,
      questionId,
      operation: 'approve',
    }).created,
  ).toBe(false);
  expect(other.execution().publication!.approvalId).toBeNull();
  const before = structuredClone(f.execution());
  f.reopen();
  expect(f.execution().publication).toEqual(before.publication);
  expect(f.execution().articles).toEqual(before.articles);
  expect(f.execution().contentSources).toEqual(before.contentSources);
  expect(validArticleReferences(f.execution())).toBe(true);
});

test('修改目标及新停止使旧预览失效，不能授予其它目标', async () => {
  const f = await fixture();
  f.generate(draft());
  f.review();
  const questionId = f.execution().question!.id;
  f.records.execution({
    kind: 'intent',
    taskId: f.taskId,
    requestId: randomUUID(),
    intent: 'revise',
    text: '改为发布到另一个栏目',
  });
  expect(f.execution().publication).toBeUndefined();
  expect(() =>
    f.records.execution({
      kind: 'participation-decision',
      taskId: f.taskId,
      questionId,
      operation: 'approve',
    }),
  ).toThrow('PARTICIPATION_EXPIRED');
  const g = await fixture();
  g.generate(draft());
  g.review();
  g.records.execution({
    kind: 'intent',
    taskId: g.taskId,
    requestId: randomUUID(),
    intent: 'stop',
  });
  expect(() => g.decide('approve')).toThrow();
});

test('备份恢复保留源表字节、解析、文章父版和未确认状态；损坏引用不能过冷开校验', async () => {
  const f = await fixture();
  f.generate(draft());
  f.review();
  f.decide('edit', { content: articleText(draft()) + '\n补充说明。' });
  const archive = path.join(f.folder, 'article.helpr-backup');
  const saved = await f.records.backup({
    kind: 'create',
    requestId: randomUUID(),
    file: archive,
  });
  const target = await fixture('report-b.xlsx');
  await target.records.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive,
    checksum: saved.archive.checksum,
  });
  const restored = target.records
    .snapshot()
    .tasks.find((t) => t.id === f.taskId)!.execution!;
  expect(restored.contentSources).toEqual(f.execution().contentSources);
  expect(restored.articles).toEqual(f.execution().articles);
  expect(restored.publication!.approvalId).toBeNull();
  const broken = structuredClone(restored);
  broken.articles![1]!.parentId = randomUUID();
  expect(validArticleReferences(broken)).toBe(false);
});

test('实际公开正文、目标和附件字节分别核对；确认内容被替换不得派发', async () => {
  let html = '';
  const original = await bytes('report-a.xlsx');
  const server = createServer((req, res) =>
    res.end(req.url === '/file' ? original : html),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_PORT');
  const base = `http://127.0.0.1:${address.port}`;
  const f = await fixture('report-a.xlsx', base);
  f.generate(draft());
  const publication = f.review();
  f.decide('approve');
  f.records.execution({
    kind: 'recover',
    taskId: f.taskId,
    expectedVersion: f.execution().version,
  });
  f.post({ kind: 'claim', runId: 'publish' });
  const download = await verifyAttachment(
    publication,
    f.material,
    new AbortController().signal,
  );
  const reserve = {
    kind: 'reserve',
    runId: 'publish',
    id: 'submit',
    summary: '发布',
    action: { kind: 'click', target: { role: 'button', name: '发布' } },
    effect: 'publication',
    binding: { targetId: 'page', generation: 1 },
    source: f.observation(),
    evidence: ['编辑'],
    download,
    publication,
    approvalId: f.execution().publication!.approvalId,
  };
  expect(() =>
    f.post({
      ...reserve,
      publication: { ...publication, content: '替换的文章' },
    }),
  ).toThrow('ARTICLE_BINDING_MISMATCH');
  f.post(reserve);
  f.post({ kind: 'dispatch', runId: 'publish', id: 'submit' });
  const input = {
    execution: f.execution(),
    actionId: 'submit',
    source: f.observation(),
    proposal: {
      url: base + '/result',
      targetUrl: base + '/edit',
      attachmentUrl: base + '/file',
      publishedEvidence: ['已发布'],
    },
    signal: new AbortController().signal,
  };
  html = `<article>公告 错误正文 <a href="/file">下载</a></article>`;
  expect((await verifyPublication(input)).status).toBe('unknown');
  html = `<article>公告 ${publication.content}<a href="/file">下载</a></article>`;
  const check = await verifyPublication(input);
  expect(check.status).toBe('verified');
  f.post({ kind: 'publication-result', runId: 'publish', check });
  expect(f.execution().materialProcessing![0]!.status).toBe('complete');
  expect(f.execution().phase).toBe('complete');
});
