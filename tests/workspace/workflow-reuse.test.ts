import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  ExecutionService,
  type ProposalInput,
  type WebActionJob,
} from '../../app/desktop/execution-service';
import { type NextStep } from '../../app/shared/execution';
import { pageObservation } from '../../app/desktop/page-observation';
import type { PageObservation } from '../../app/shared/model';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-workflow-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  type Page = {
    file: string;
    bytes: Buffer;
    title: string;
    destination: string;
    uploaded: boolean;
    draft: boolean;
    typed: boolean;
    selected: boolean;
    published: boolean;
    writes: string[];
  };
  const pages = new Map<string, Page>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const p = pages.get(url.searchParams.get('task')!);
    if (!p) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.pathname === '/file' && p.uploaded) res.end(p.bytes);
    else if (url.pathname === '/result' && p.published) {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<link rel="canonical" href="${url.pathname + url.search}"><h1>${p.title}</h1><p>${p.destination}</p><a href="/file${url.search}">附件</a>`,
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('address');
  const base = `http://127.0.0.1:${addr.port}`;
  let records = new WorkspaceRecords(folder, 'app/records/migrations');
  cleanup.push(async () => {
    records.close();
    await Promise.resolve();
  });
  let state = records.snapshot();
  const calls: { taskId: string; kind: string }[] = [];
  let observationFilter = (o: PageObservation) => o;
  let beforeRecord: (command: unknown) => Promise<void> = () =>
    Promise.resolve();
  let choose = (step: NextStep) => step;
  const e = (id: string) => state.tasks.find((t) => t.id === id)!.execution!;
  const page = (id: string) => pages.get(id)!;
  const url = (id: string, name = 'edit') => `${base}/${name}?task=${id}`;
  const observe = (id: string): PageObservation => {
    const p = page(id);
    const link = (name: string, href: string) =>
      `${name}\n[link-url] ${href}\n[observed-link] ${JSON.stringify({ name, url: href })}`;
    return observationFilter({
      url: url(id),
      title: '编辑附件',
      generation: 1,
      observedAt: Date.now(),
      fingerprint: String(p.writes.length),
      truncated: false,
      links: [
        { name: '永久链接', url: url(id, 'result') },
        ...(p.uploaded ? [{ name: '下载附件', url: url(id, 'file') }] : []),
      ],
      text: [
        '编辑附件',
        '[file 0] ' + url(id),
        '固定标签：公告',
        link('永久链接', url(id, 'result')),
        p.uploaded
          ? '附件已上传\n' + link('下载附件', url(id, 'file'))
          : '等待素材',
        p.draft ? '草稿已保存' : '',
        p.typed ? '标题已填写\n' + p.title : '',
        p.selected ? '栏目已填写\n' + p.destination : '',
        p.published ? '已发布' : '尚未发布',
      ].join('\n'),
    });
  };
  const planner = (input: ProposalInput): NextStep => {
    const p = page(input.taskId),
      publication = input.publication;
    calls.push({
      taskId: input.taskId,
      kind: input.workflows?.length ? 'intent-and-inputs' : 'web-planning',
    });
    const material = {
      scope: p.file,
      rule: 'exact' as const,
      name: null,
      extension: null,
      basis: `使用“${p.file}”`,
    };
    const previous = input.pending
      ? {
          id: input.pending.id,
          status: 'confirmed' as const,
          evidence: [
            p.published
              ? '已发布'
              : p.selected
                ? '栏目已填写'
                : p.typed
                  ? '标题已填写'
                  : p.draft
                    ? '草稿已保存'
                    : '附件已上传',
          ],
        }
      : null;
    const step: NextStep = {
      decision: 'act',
      summary: '处理本次附件',
      evidence: ['编辑附件', '固定标签：公告'],
      previous,
      action: null,
    };
    const candidate = input.workflows?.[0];
    if (candidate)
      return choose({
        ...step,
        decision: 'reuse',
        material,
        workflow: {
          taskId: candidate.taskId,
          version: candidate.version,
          sha256: candidate.sha256,
          content: p.title,
          destination: p.destination,
        },
      });
    const m = input.materials?.[0];
    if (!m) return { ...step, decision: 'material', material };
    if (!p.uploaded)
      return {
        ...step,
        effect: 'upload',
        action: { kind: 'upload', materialId: m.id, target: { fileIndex: 0 } },
      };
    step.preparation = [
      {
        kind: 'target',
        url: url(input.taskId),
        materialId: null,
        evidence: ['编辑附件'],
      },
      {
        kind: 'upload',
        url: url(input.taskId, 'file'),
        materialId: m.id,
        evidence: ['附件已上传'],
      },
    ];
    if (!p.draft)
      return {
        ...step,
        effect: 'draft',
        action: {
          kind: 'click',
          target: { role: 'button', name: '保存草稿', exact: true },
        },
      };
    step.preparation.push({
      kind: 'draft',
      url: url(input.taskId),
      materialId: null,
      evidence: ['草稿已保存'],
    });
    const proposed = {
      content: publication?.content ?? p.title,
      destination: p.destination,
      attachment: {
        materialId: m.id,
        targetUrl: url(input.taskId),
        url: url(input.taskId, 'file'),
      },
    };
    if (!publication?.approvalId)
      return { ...step, decision: 'review', publication: proposed };
    if (p.published)
      return {
        ...step,
        decision: 'complete',
        result: {
          url: url(input.taskId, 'result'),
          targetUrl: url(input.taskId),
          attachmentUrl: url(input.taskId, 'file'),
          publishedEvidence: ['已发布'],
        },
      };
    step.publication = proposed;
    step.approvalId = publication.approvalId;
    if (!p.typed)
      return {
        ...step,
        effect: 'interaction',
        action: {
          kind: 'fill',
          value: proposed.content,
          target: { role: 'textbox', name: '发布标题', exact: true },
        },
      };
    if (!p.selected)
      return {
        ...step,
        effect: 'interaction',
        action: {
          kind: 'select',
          value: p.destination,
          target: { role: 'combobox', name: '栏目', exact: true },
        },
      };
    return {
      ...step,
      effect: 'publication',
      action: {
        kind: 'click',
        target: { role: 'button', name: '发布附件', exact: true },
      },
      recovery: {
        rule: 'public-attachment-v1',
        url: url(input.taskId, 'result'),
        targetUrl: url(input.taskId),
        attachmentUrl: url(input.taskId, 'file'),
        evidence: ['永久链接'],
      },
    };
  };
  const perform = async (job: WebActionJob) => {
    expect(job.qualified()).toBe(true);
    const p = page(job.taskId),
      a = job.action;
    p.writes.push(a.kind);
    if (a.kind === 'upload') {
      const result = await records.material({
        kind: 'payload',
        taskId: job.taskId,
        runId: job.runId,
        actionId: job.actionId,
      });
      // 字节读取由产品上传入口的独立检查覆盖，本 fixture 的服务器保存本次输入。
      expect(result).toBeTruthy();
      p.uploaded = true;
    } else if (a.kind === 'fill') {
      p.title = a.value;
      p.typed = true;
    } else if (a.kind === 'select') {
      p.destination = a.value;
      p.selected = true;
    } else if (a.kind === 'click' && !p.draft) p.draft = true;
    else p.published = true;
  };
  const service = () =>
    new ExecutionService({
      records: async (c) => {
        await beforeRecord(c);
        return records.execution(c);
      },
      material: (c) => records.material(c),
      current: () => state,
      publish: (s) => {
        state = s;
      },
      observe: (id) =>
        Promise.resolve({
          observation: observe(id),
          binding: { targetId: id, generation: 1 },
        }),
      propose: (input) => Promise.resolve(planner(input)),
      perform,
      revoke: () => {},
      stopModels: () => {},
    });
  let execution = service();
  const add = async (title: string, destination = '公告') => {
    const file = path.join(folder, title + '.bin');
    const bytes = Buffer.from('new-file-' + title);
    await writeFile(file, bytes);
    const id = records.execute({
      kind: 'create',
      requestId: randomUUID(),
      goal: `使用“${file}”`,
    }).taskId;
    records.execute({
      kind: 'page',
      requestId: randomUUID(),
      taskId: id,
      url: url(id),
      phase: 'manual',
    });
    pages.set(id, {
      file,
      bytes,
      title,
      destination,
      uploaded: false,
      draft: false,
      typed: false,
      selected: false,
      published: false,
      writes: [],
    });
    state = records.snapshot();
    await execution.intent({
      kind: 'execution-intent',
      requestId: randomUUID(),
      taskId: id,
      intent: 'revise',
      text: `使用“${file}”在 ${url(id)} 发布“${title}”到${destination}`,
    });
    await execution.settled();
    return id;
  };
  const approve = async (id: string) => {
    expect(e(id).question?.type, e(id).summary).toBe('review');
    await execution.reply({
      kind: 'participation-decision',
      taskId: id,
      questionId: e(id).question!.id,
      operation: 'approve',
    });
    await execution.settled();
  };
  return {
    folder,
    base,
    e,
    page,
    calls,
    add,
    approve,
    url,
    observe,
    records: () => records,
    service: () => execution,
    filter: (fn: typeof observationFilter) => {
      observationFilter = fn;
    },
    intercept: (fn: typeof beforeRecord) => {
      beforeRecord = fn;
    },
    choose: (fn: typeof choose) => {
      choose = fn;
    },
    cold: async () => {
      await execution.stopAll();
      records.close();
      records = new WorkspaceRecords(folder, 'app/records/migrations');
      state = records.snapshot();
      execution = service();
      execution.refresh();
      await execution.settled();
    },
  };
}

test('通过公共执行入口学习、换素材标题栏目并固定版本；网页重放不调用规划模型', async () => {
  const f = await setup();
  const a = await f.add('第一份');
  await f.approve(a);
  expect(f.e(a).phase, f.e(a).summary).toBe('complete');
  const workflow = f.e(a).learnedWorkflows![0]!;
  expect(workflow.replay).toBeDefined();
  const b = await f.add('第二份', '通知');
  expect(f.page(b).published).toBe(false);
  expect(f.e(b).publication!.approvalId).toBeNull();
  expect(f.e(b).workflowUses![0]!.workflow).toEqual(workflow);
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.calls.filter((c) => c.taskId === b)).toEqual([
    { taskId: b, kind: 'intent-and-inputs' },
  ]);
  expect(f.e(b).publication!.approvalId).not.toBe(
    f.e(a).publication!.approvalId,
  );
  expect(f.e(b).materials![0]!.sha256).not.toBe(f.e(a).materials![0]!.sha256);
  expect(f.e(b).learnedWorkflows![0]!.parentVersion).toBe(workflow.version);
  expect(f.page(b).title).toBe('第二份');
  expect(f.page(b).destination).toBe('通知');
  expect(f.page(b).writes).toEqual([
    'upload',
    'click',
    'fill',
    'select',
    'click',
  ]);
  expect(f.e(b).materialProcessing!.map((p) => p.status)).toEqual(['complete']);
  expect(f.e(a).phase).toBe('complete');
});

test('冷开从数据库读取版本，以新输入重放；备份保留每项绑定并暂停恢复', async () => {
  const f = await setup();
  const a = await f.add('旧资料');
  await f.approve(a);
  const original = f.e(a).learnedWorkflows![0];
  await f.cold();
  const b = await f.add('冷开新资料', '通知');
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.e(b).workflowUses![0]!.workflow).toEqual(original);
  const { archive } = await f.records().backup({
    kind: 'create',
    requestId: randomUUID(),
    file: path.join(f.folder, 'backup.helpr-backup'),
  });
  expect(archive).toBeTruthy();
  const restoredFolder = await mkdtemp(
    path.join(tmpdir(), 'helpr-workflow-restore-'),
  );
  cleanup.push(() => rm(restoredFolder, { recursive: true, force: true }));
  const restored = new WorkspaceRecords(
    restoredFolder,
    'app/records/migrations',
  );
  cleanup.push(async () => {
    restored.close();
    await Promise.resolve();
  });
  await restored.backup({
    kind: 'restore',
    requestId: randomUUID(),
    file: archive.file,
    checksum: archive.checksum,
  });
  const restoredExecution = restored
    .snapshot()
    .tasks.find((t) => t.id === b)!.execution!;
  expect(restoredExecution.workflowUses).toEqual(f.e(b).workflowUses);
  expect(restoredExecution.restoreReview).toBe('required');
  expect(restoredExecution.phase).toBe('paused');
  await f.cold();
  expect(f.e(b).phase).toBe('complete');
  expect(f.calls.filter((c) => c.taskId === b)).toHaveLength(1);
});

test('重复链接导致未知并不重传，不使用历史地址或任意第一项', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    links: [...(o.links ?? []), { name: '下载附件', url: f.base + '/other' }],
    text:
      o.text +
      '\n[observed-link] ' +
      JSON.stringify({ name: '下载附件', url: f.base + '/other' }),
  }));
  const b = await f.add('有歧义');
  expect(f.e(b).phase).toBe('paused');
  expect(f.page(b).writes).toEqual(['upload']);
  await f.service().intent({
    kind: 'execution-intent',
    taskId: b,
    requestId: randomUUID(),
    intent: 'continue',
  });
  await f.service().settled();
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).materialProcessing ?? []).toHaveLength(0);
});

test('本次参数必须来自本次委托，候选摘要不符不能绑定', async () => {
  const f = await setup();
  const a = await f.add('基准');
  await f.approve(a);
  f.choose((s) => ({
    ...s,
    workflow: { ...s.workflow!, content: '旧值冒充新值' },
  }));
  const b = await f.add('新委托');
  expect(f.page(b).writes).toHaveLength(0);
  expect(f.e(b).phase).toBe('paused');
  f.choose((s) => ({
    ...s,
    workflow: { ...s.workflow!, sha256: '0'.repeat(64) },
  }));
  const c = await f.add('错误摘要');
  expect(f.page(c).writes).toHaveLength(0);
  expect(f.e(c).workflowUses).toBeUndefined();
});

test('近派发停止阻断重放，另一任务保持自己的素材和确认', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  let stopped = false;
  f.intercept(async (raw) => {
    const c = raw as { kind: string; taskId: string; workflowStep?: unknown };
    if (c.kind === 'reserve' && c.workflowStep && !stopped) {
      stopped = true;
      await f.service().intent({
        kind: 'execution-intent',
        taskId: c.taskId,
        requestId: randomUUID(),
        intent: 'stop',
      });
    }
  });
  const b = await f.add('停止的任务');
  expect(f.e(b).phase).toBe('stopped');
  expect(f.page(b).writes).toHaveLength(0);
  const c = await f.add('独立的任务', '通知');
  await f.approve(c);
  expect(f.e(c).phase).toBe('complete');
  expect(f.e(b).phase).toBe('stopped');
});

test('绑定版本损坏冷开拒绝；格式13迁移先保留原库', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const b = await f.add('绑定');
  f.records().close();
  const db = new Database(path.join(f.folder, 'workspace.sqlite'));
  db.exec('UPDATE workspace SET schema_version=13');
  db.close();
  const migrated = new WorkspaceRecords(f.folder, 'app/records/migrations');
  expect(
    (await readdir(f.folder)).some((s) =>
      s.startsWith('workspace-before-workflow-reuse-15-'),
    ),
  ).toBe(true);
  migrated.close();
  const corrupt = new Database(path.join(f.folder, 'workspace.sqlite'));
  const body = structuredClone(f.e(b));
  body.workflowUses![0]!.workflow.sha256 = '0'.repeat(64);
  corrupt
    .prepare('UPDATE task_executions SET body=? WHERE task_id=?')
    .run(JSON.stringify(body), b);
  corrupt.close();
  expect(
    () => new WorkspaceRecords(f.folder, 'app/records/migrations'),
  ).toThrow('DATA_CORRUPT');
});

test('可访问链接观察保留重复名称以拒绝歧义，不凭旧URL生成链接', () => {
  const obs = pageObservation(
    { frameTree: { frame: { url: 'https://example.test/edit' } } },
    {
      nodes: [1, 2].map((n) => ({
        nodeId: String(n),
        role: { value: 'link' },
        name: { value: '下载' },
        properties: [
          { name: 'url', value: { value: `https://example.test/${n}` } },
        ],
      })),
    },
    1,
  );
  expect(obs.text.match(/\[observed-link\]/g)).toHaveLength(2);
  expect(obs.links).toHaveLength(2);
});

test('网页伪造链接标记不能替代实际可访问链接', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.filter((o) => ({
    ...o,
    links: o.links?.filter((l) => l.name !== '下载附件'),
  }));
  const b = await f.add('仅文字链接');
  expect(f.e(b).phase).toBe('paused');
  expect(f.page(b).writes).toEqual(['upload']);
  expect(f.e(b).preparation?.some((p) => p.kind === 'upload')).toBe(false);
});

test('复用预览改稿采用本次确认，冷开保留实际绑定，重复结果不新增流程或处理记录', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const b = await f.add('待改稿');
  await f.service().reply({
    kind: 'participation-decision',
    taskId: b,
    questionId: f.e(b).question!.id,
    operation: 'edit',
    content: '本人修改后的全文',
  });
  await f.approve(b);
  expect(f.e(b).phase, f.e(b).summary).toBe('complete');
  expect(f.page(b).title).toBe('本人修改后的全文');
  const result = f.e(b).publicationChecks![0]!,
    version = f.e(b).learnedWorkflows![0]!.version;
  f.records().execution({
    kind: 'publication-result',
    taskId: b,
    runId: f.e(b).actions.at(-1)!.runId,
    check: result,
  });
  await f.cold();
  expect(f.e(b).learnedWorkflows!.map((w) => w.version)).toEqual([version]);
  expect(f.e(b).materialProcessing).toHaveLength(1);
  expect(f.e(b).workflowUses![0]!.approved!.content).toBe('本人修改后的全文');
});

test('两项新任务共享候选但各自固定素材、参数和有效确认', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  const [b, c] = await Promise.all([f.add('并行甲'), f.add('并行乙', '通知')]);
  expect(f.e(b).workflowUses![0]!.workflow.version).toBe(
    f.e(c).workflowUses![0]!.workflow.version,
  );
  expect(f.e(b).workflowUses![0]!.id).not.toBe(f.e(c).workflowUses![0]!.id);
  await f.approve(b);
  expect(f.e(c).publication!.approvalId).toBeNull();
  expect(f.page(c).published).toBe(false);
  await f.approve(c);
  expect(f.e(b).phase).toBe('complete');
  expect(f.e(c).phase).toBe('complete');
  expect(f.page(b).title).toBe('并行甲');
  expect(f.page(c).title).toBe('并行乙');
});

test('保存绑定失败保持阻断；模型同时报告异常时不开始复用', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.choose((s) => ({ ...s, anomalies: ['观察到多余目标'] }));
  const b = await f.add('异常');
  expect(f.e(b).phase).toBe('unknown');
  expect(f.e(b).workflowUses).toBeUndefined();
  expect(f.page(b).writes).toHaveLength(0);
  f.choose((s) => s);
  f.intercept((raw) =>
    (raw as { kind: string }).kind === 'workflow-bind'
      ? Promise.reject(Error('record-down'))
      : Promise.resolve(),
  );
  const c = await f.add('记录失败');
  expect(f.e(c).workflowUses).toBeUndefined();
  expect(f.page(c).writes).toHaveLength(0);
});

test('重放预留回执重送只保存一个动作，不重复执行', async () => {
  const f = await setup();
  const a = await f.add('学习');
  await f.approve(a);
  f.intercept(async (raw) => {
    const c = raw as { kind: string; workflowStep?: unknown };
    if (c.kind === 'reserve' && c.workflowStep) f.records().execution(raw);
    await Promise.resolve();
  });
  const b = await f.add('丢失回执');
  expect(f.page(b).writes).toHaveLength(0);
  expect(f.e(b).actions).toHaveLength(1);
  expect(f.e(b).actions[0]!.dispatchState).toBe('not-dispatched');
});
