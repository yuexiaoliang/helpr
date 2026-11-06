import { afterEach, expect } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  ExecutionService,
  type ProposalInput,
  type WebActionJob,
} from '../../app/desktop/execution-service';
import { type NextStep } from '../../app/shared/execution';
import type { PageObservation } from '../../app/shared/model';

export const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

export async function setup(withSession = false) {
  const folder = await mkdtemp(path.join(tmpdir(), 'helpr-workflow-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  type Page = {
    labels: { draft: string; title: string; publish: string };
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
  const hostSession = {
    id: 'fixture',
    epoch: randomUUID() + ':0',
    origin: base,
  };
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
      controls: [
        {
          role: 'button',
          name: p.labels.draft,
          frameUrl: url(id),
          disabled: false,
        },
        {
          role: 'button',
          name: p.labels.publish,
          frameUrl: url(id),
          disabled: false,
        },
        {
          role: 'textbox',
          name: p.labels.title,
          frameUrl: url(id),
          disabled: false,
        },
        { role: 'combobox', name: '栏目', frameUrl: url(id), disabled: false },
      ],
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
          target: { role: 'button', name: p.labels.draft, exact: true },
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
          target: { role: 'textbox', name: p.labels.title, exact: true },
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
        target: { role: 'button', name: p.labels.publish, exact: true },
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
  let alterPlan: (step: NextStep, input: ProposalInput) => NextStep = (step) =>
    step;
  let beforePerform: (job: WebActionJob) => Promise<void> = async () => {
    await Promise.resolve();
  };
  const perform = async (job: WebActionJob) => {
    await beforePerform(job);
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
      ...(withSession ? { session: () => Promise.resolve(hostSession) } : {}),
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
          ...(withSession ? { session: hostSession } : {}),
          observation: observe(id),
          binding: { targetId: id, generation: 1 },
        }),
      propose: (input) => Promise.resolve(alterPlan(planner(input), input)),
      perform,
      revoke: () => {},
      stopModels: () => {},
    });
  let execution = service();
  const add = async (
    title: string,
    destination = '公告',
    labels = { draft: '保存草稿', title: '发布标题', publish: '发布附件' },
  ) => {
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
      labels,
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
    snapshot: () => state,
    sessionChanged: (id: string) => {
      hostSession.epoch = hostSession.epoch.replace(/:\d+$/, ':1');
      return execution.sessionChanged(hostSession, [id]);
    },
    service: () => execution,
    filter: (fn: typeof observationFilter) => {
      observationFilter = fn;
    },
    intercept: (fn: typeof beforeRecord) => {
      beforeRecord = fn;
    },
    plan: (fn: typeof alterPlan) => {
      alterPlan = fn;
    },
    act: (fn: typeof beforePerform) => {
      beforePerform = fn;
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
