import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'parse5';
import XLSX from 'xlsx';
import { p1Cases } from './release-p1-fixture.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const effects = ['p1-created', 'p1-upload', 'p1-linked', 'p1-published'];
const fixtureWrites = (website, item) =>
  website.receipts.filter(
    (r) => (!item || r.item === item) && effects.includes(r.kind),
  );
const snapshot = (client) => client.request({ kind: 'snapshot' });

function makeSample(data, base, item) {
  const destination = { R: '简报', C: '通知', D: '公告' }[item] ?? '通知';
  const workbook = XLSX.utils.book_new();
  const numbers = [item.charCodeAt(0) + 3, item.charCodeAt(0) * 3];
  const rows = [
    ['完成件数', numbers[0]],
    ['合计金额', numbers[1]],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '日报');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const file = path.join(data, '验证素材-' + item + '.xlsx');
  fs.writeFileSync(file, bytes);
  const entry =
    base + (item === 'D' ? '/p1/content' : '/p1/posts') + '?item=' + item;
  const excel = ['A', 'W'].includes(item);
  const values = excel
    ? rows.map(([label, value]) => label + '：' + value + '。')
    : [
        '发布样本 ' + item,
        '固定素材 ' + item + ' 的第一行\n核对第二行 ' + item,
      ];
  const goal = `使用“${file}”在 ${entry} ${excel ? '读取表格成文并发布' : '发布“' + values.join('\n\n') + '”'}到“${destination}”`;
  return {
    entry,
    file,
    goal,
    destination,
    values,
    rows,
    sha256: digest(bytes),
  };
}

function readPublicHtml(html, base) {
  const result = { titles: [], paragraphs: [], links: [], canonical: [] };
  const text = (node) =>
    node.nodeName === '#text'
      ? node.value
      : (node.childNodes ?? []).map(text).join('');
  const visit = (node) => {
    const attrs = Object.fromEntries(
      (node.attrs ?? []).map((a) => [a.name, a.value]),
    );
    if (node.tagName === 'h1') result.titles.push(text(node));
    if (node.tagName === 'p') result.paragraphs.push(text(node));
    if (node.tagName === 'a') result.links.push(new URL(attrs.href, base).href);
    if (node.tagName === 'link' && attrs.rel === 'canonical')
      result.canonical.push(new URL(attrs.href, base).href);
    node.childNodes?.forEach(visit);
  };
  visit(parse(html));
  return result;
}

async function independentResult(website, sample, item, execution) {
  const [created, upload, ...remaining] = fixtureWrites(website, item);
  const published = remaining.at(-1);
  assert.deepEqual(
    fixtureWrites(website, item).map((r) => r.kind),
    [
      'p1-created',
      'p1-upload',
      ...(item === 'D' ? [] : ['p1-linked']),
      'p1-published',
    ],
  );
  const target = website.base + created.editor,
    attachment = website.base + upload.file;
  const result = website.base + published.result;
  const signal = AbortSignal.timeout(6000);
  const [page, download] = await Promise.all([
    fetch(result, { signal }),
    fetch(attachment, { signal }),
  ]);
  assert.equal(page.status, 200);
  assert.equal(download.status, 200);
  const parsed = readPublicHtml(await page.text(), result);
  assert.deepEqual(parsed, {
    titles: [sample.values[0]],
    paragraphs: [sample.values[1], sample.destination],
    links: [attachment, target],
    canonical: [result],
  });
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(bytes, fs.readFileSync(sample.file));
  assert.equal(published.editor, created.editor);
  assert.equal(published.file, upload.file);
  assert.equal(upload.sha256, sample.sha256);
  assert.equal(execution.publicationChecks.length, 1);
  assert.equal(execution.publicationChecks[0].status, 'verified');
  assert.equal(execution.publicationChecks[0].download.sha256, sample.sha256);
  assert.deepEqual(execution.publicationChecks[0].proposal, {
    ...execution.publicationChecks[0].proposal,
    url: result,
    targetUrl: target,
    attachmentUrl: attachment,
  });
  assert.equal(execution.materialProcessing[0].status, 'complete');
  return {
    target,
    attachment,
    result,
    parsed,
    bytes: bytes.length,
    sha256: digest(bytes),
  };
}

export async function verifyReleaseP1({
  client,
  website,
  data,
  evidence,
  command,
  waitFor,
  check,
  launch,
  remainingOwned,
  mode,
}) {
  const report = (evidence.releaseP1 = {
    mode,
    cases: [],
    realModelCalls: 0,
    remoteWrites: 0,
    confirmations: 'scripted-public-entry',
  });
  let active = client;
  const configure = async () => {
    const state = await snapshot(active);
    await active.request(
      command('model-save', {
        protocol: 'chat-completions',
        expectedVersion: state.modelSettings?.version ?? 0,
        endpoint: website.base + '/v1',
        model: 'fixture',
        apiKey: 'local-fixture-not-a-secret',
      }),
    );
  };
  const get = async (id) =>
    (await snapshot(active)).tasks.find((t) => t.id === id);
  const history = (id) => get(id).then((task) => task.execution);
  const ready = async (id) => {
    let previous;
    return waitFor(async () => {
      if ((await get(id))?.phase !== 'manual') return false;
      try {
        const dom = await active.request({
          kind: 'observe',
          taskId: id,
          method: 'DOMSnapshot.captureSnapshot',
        });
        const current = digest(JSON.stringify(dom.strings));
        const stable = previous === current;
        previous = current;
        return stable;
      } catch (error) {
        if (
          [
            'PAGE_NOT_AVAILABLE',
            'OBSERVATION_NOT_AUTHORIZED',
            'STALE_OBSERVATION',
          ].includes(error.message)
        )
          return false;
        throw error;
      }
    }, 15000);
  };
  const reopen = async (reason, samples) => {
    const writes = fixtureWrites(website).length;
    const planning = website.receipts.filter(
      (r) => r.kind === 'p1-model',
    ).length;
    await active.quit();
    assert.deepEqual(remainingOwned(), []);
    active = await launch();
    for (const sample of samples) {
      await ready(sample.taskId);
      const restored = await history(sample.taskId);
      check(sample.item + ' ' + reason + '保留任务事实和意图', () => {
        for (const key of [
          'intent',
          'phase',
          'actions',
          'preparation',
          'publicationChecks',
          'workflowUses',
          'workflowDecisions',
        ])
          assert.deepEqual(restored[key], sample.final[key]);
      });
    }
    assert.equal(fixtureWrites(website).length, writes);
    assert.equal(
      website.receipts.filter((r) => r.kind === 'p1-model').length,
      planning,
    );
  };
  const stateUntil = (sample, predicate, timeout = 40000) =>
    waitFor(async () => {
      const execution = await history(sample.taskId);
      sample.last = execution && {
        phase: execution.phase,
        pauseReason: execution.pauseReason,
        summary: execution.summary,
        url: (await get(sample.taskId)).url,
        actions: execution.actions,
      };
      if (!execution) return false;
      if (predicate(execution)) return execution;
      if (
        execution.phase === 'failed' ||
        (execution.phase === 'paused' &&
          !execution.pauseReason &&
          !execution.question)
      )
        throw Error('P1_EXECUTION_PAUSED: ' + execution.summary);
      return false;
    }, timeout);
  const schedule = async (sample) => {
    const { taskId: owner } = await active.request(
      command('create', {
        goal: '在 ' + sample.entry + ' 整理定时发布要求',
      }),
    );
    await ready(owner);
    await active.request(
      command('execution-intent', { taskId: owner, intent: 'stop' }),
    );
    const text = `从“${data}”取唯一 xlsx，在 ${sample.entry} 的“${sample.destination}”栏目，按“逐行引用表格事实”自动发布，新内容另发，同内容一次`;
    await active.request(
      command('agreement-prepare', {
        taskId: owner,
        expectedVersion: (await history(owner)).version,
        text,
      }),
    );
    const versionId = (await history(owner)).agreements.at(-1).versionId;
    await active.request(
      command('agreement-accept', { taskId: owner, versionId }),
    );
    const missed = mode === 'automation-missed';
    const startAt = new Date(Date.now() + (missed ? 10000 : 7000)).toISOString();
    const timing = missed
      ? '只执行一次，错过先问我，容许延迟0秒'
      : '每隔60秒，错过补最近一次';
    await active.request(
      command('message', {
        taskId: owner,
        text: `定时计划：从 ${startAt} 起，${timing}，时区 Asia/Shanghai，夏令时重复或不存在先问我。`,
      }),
    );
    await active.request(
      command('message', { taskId: owner, text: '接受定时计划' }),
    );
    if (missed) return { owner, versionId, startAt };
    const child = await waitFor(
      async () => (await history(owner)).schedule.rounds[0]?.links[0]?.taskId,
      20000,
    );
    return { owner, versionId, child };
  };
  await configure();
  for (const item of p1Cases[mode]) {
    if (item === 'C') {
      await reopen('完整退出并重开后', report.cases);
      await configure();
    }
    const sample = { item, ...makeSample(data, website.base, item) };
    report.cases.push(sample);
    if (item === 'W') {
      const plan = await schedule(sample);
      if (mode === 'automation-missed') {
        sample.taskId = plan.owner;
        const accepted = (await history(plan.owner)).schedule;
        assert.equal(accepted.rounds.length, 0);
        assert.equal(accepted.versions.at(-1).terms.missed, 'ask');
        await active.quit();
        assert.deepEqual(remainingOwned(), []);
        assert(Date.now() < Date.parse(plan.startAt));
        await waitFor(() => Date.now() >= Date.parse(plan.startAt) + 1100, 15000);
        assert.equal(fixtureWrites(website).length, 0);
        active = await launch();
        const pending = await waitFor(async () => {
          const round = (await history(plan.owner)).schedule.rounds[0];
          return round?.status === 'waiting' && round;
        }, 15000);
        const before = await snapshot(active);
        check('应用退出期间错过一次计划，冷开只生成待决轮次', () => {
          assert.equal(pending.occurrence.dueAt, Date.parse(plan.startAt));
          assert.deepEqual(pending.links, []);
          assert.equal(before.tasks.length, 1);
          assert.equal(fixtureWrites(website).length, 0);
        });
        await active.request(command('schedule-decide', {
          taskId: plan.owner,
          roundId: pending.id,
          decision: 'skip',
        }));
        sample.final = await history(plan.owner);
        report.schedule = { accepted, pending, final: sample.final.schedule };
        check('明确跳过后同一轮次结案，未产生新任务或写入', () => {
          assert.equal(report.schedule.final.rounds.length, 1);
          assert.equal(report.schedule.final.rounds[0].id, pending.id);
          assert.equal(report.schedule.final.rounds[0].status, 'skipped');
          assert.equal(fixtureWrites(website).length, 0);
        });
        continue;
      }
      sample.taskId = plan.child;
      sample.final = await stateUntil(sample, (e) => e.phase === 'complete');
      sample.independent = await independentResult(
        website,
        sample,
        item,
        sample.final,
      );
      check('定时后台任务沿跨页链路按发布约定完成并保留当前查看页', () => {
        assert.equal(
          sample.final.publication.agreementVersionId,
          plan.versionId,
        );
        assert.equal(sample.final.materialWorks[0].status, 'complete');
        assert.equal(sample.final.question, undefined);
        assert.equal(
          sample.final.article?.content ?? sample.final.articles[0].content,
          sample.values.join('\n\n'),
        );
      });
      assert.equal((await snapshot(active)).active, plan.owner);
      await active.request(
        command('message', { taskId: plan.owner, text: '取消定时计划' }),
      );
      report.schedule = (await history(plan.owner)).schedule;
      continue;
    }
    sample.taskId = (
      await active.request(command('create', { goal: sample.goal }))
    ).taskId;
    await ready(sample.taskId);
    await active.request(
      command('execution-intent', { taskId: sample.taskId, intent: 'start' }),
    );
    if (item === 'I') {
      await stateUntil(
        sample,
        (e) =>
          e.pauseReason === 'page-change' &&
          e.actions.at(-1)?.navigation &&
          e.actions.at(-1).effect === 'draft',
      );
      await new Promise((resolve) => setTimeout(resolve, 6500));
      sample.final = await history(sample.taskId);
      check('错配新草稿身份保持未知且不续做', () => {
        assert.equal(sample.final.phase, 'paused');
        assert.equal(sample.final.actions.at(-1).status, 'unknown');
        assert.equal(sample.final.actions.at(-1).discoveredTarget, undefined);
        assert.deepEqual(
          fixtureWrites(website, item).map((r) => r.kind),
          ['p1-created'],
        );
      });
      continue;
    }
    if (item === 'S') {
      await waitFor(
        () => fixtureWrites(website, item).some((r) => r.kind === 'p1-upload'),
        35000,
      );
      await active.request(
        command('execution-intent', { taskId: sample.taskId, intent: 'stop' }),
      );
      await stateUntil(sample, (e) => e.intent === 'stopped');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      sample.final = await history(sample.taskId);
      check('发送附件后停止保留原动作且不关联或发布', () => {
        assert.equal(sample.final.intent, 'stopped');
        assert.deepEqual(
          fixtureWrites(website, item).map((r) => r.kind),
          ['p1-created', 'p1-upload'],
        );
        assert.equal(sample.final.actions.at(-1).action.kind, 'upload');
      });
      continue;
    }
    const review = await stateUntil(
      sample,
      (e) => e.question?.type === 'review',
    );
    sample.review = {
      publication: review.publication,
      actions: review.actions,
      question: review.question,
      workflowUses: review.workflowUses,
      workflowRepairs: review.workflowRepairs,
    };
    check(item + ' 按任务预览全部字段、栏目和固定附件', () => {
      assert.equal(review.publication.content, sample.values.join('\n\n'));
      assert.equal(review.publication.destination, sample.destination);
      assert.equal(review.publication.approvalId, null);
      assert.equal(review.materials[0].sha256, sample.sha256);
      assert(
        !review.actions.some(
          (a) => a.action.kind === 'fill' || a.effect === 'publication',
        ),
      );
      assert(
        !fixtureWrites(website, item).some((r) => r.kind === 'p1-published'),
      );
      const create = review.actions.find((a) => a.discoveredTarget);
      assert.equal(create.targetCreation.rule, 'redirected-blank-editor-v1');
      assert.equal(
        create.formNavigationResolution.proof.chain.requests[1].redirectStatus,
        303,
      );
      assert.equal(
        create.discoveredTarget.source.url,
        review.publication.attachment.targetUrl,
      );
      assert.equal(
        !!review.actions.find((a) => a.uploadCheck).uploadCheck
          .departureActionId,
        item !== 'D',
      );
      if (item === 'A') {
        assert.equal(review.contentSources[0].materialSha256, sample.sha256);
        assert.deepEqual(
          review.articles[0].blocks.map((b) => b.citations.map((c) => c.quote)),
          sample.rows.map((r) => r.map(String)),
        );
      }
    });
    if (item === 'N') {
      const id = new URL(review.publication.attachment.targetUrl).pathname
        .split('/')
        .at(-2);
      const response = await fetch(website.base + '/p1/arm?draft=' + id, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      await waitFor(() =>
        website.receipts.some(
          (r) => r.kind === 'p1-replaced' && r.item === item,
        ),
      );
    }
    const approval = {
      kind: 'participation-decision',
      taskId: sample.taskId,
      questionId: review.question.id,
      operation: 'approve',
    };
    try {
      await active.request(approval);
    } catch (error) {
      if (item !== 'N') throw error;
      sample.approvalError = error.message;
    }
    if (item === 'N') {
      sample.final = await stateUntil(
        sample,
        (e) => sample.approvalError || ['paused', 'unknown'].includes(e.phase),
      );
      check('预览后的节点替换未取得填写或发布资格', () => {
        assert(
          !sample.final.actions.some(
            (a) => a.action.kind === 'fill' || a.effect === 'publication',
          ),
        );
        assert(
          !fixtureWrites(website, item).some((r) => r.kind === 'p1-published'),
        );
      });
      continue;
    }
    if (item === 'U') {
      sample.final = await stateUntil(sample, (e) =>
        e.publicationChecks?.some((c) => c.status !== 'verified'),
      );
      check('公开正文错配保持待核对且没有第二次提交', () => {
        assert.notEqual(sample.final.phase, 'complete');
        assert.equal(
          fixtureWrites(website, item).filter((r) => r.kind === 'p1-published')
            .length,
          1,
        );
        assert.equal(sample.final.publicationChecks[0].checks.content, false);
      });
      await active.request(command('execution-intent', { taskId: sample.taskId, intent: 'stop' }));
      const stopped = await stateUntil(sample, e => e.intent === 'stopped');
      await active.request(command('execution-intent', { taskId: sample.taskId, intent: 'continue' }));
      sample.final = await stateUntil(
        sample,
        e => e.version > stopped.version && ['paused', 'unknown'].includes(e.phase),
      );
      check('未知结果明确停止后继续，先核对现场并且不重发', () => {
        assert.equal(sample.final.actions.filter(a => a.effect === 'publication').length, 1);
        assert.equal(fixtureWrites(website, item).filter(r => r.kind === 'p1-published').length, 1);
        assert(!sample.final.publicationChecks.some(c => c.status === 'verified'));
      });
      continue;
    }
    sample.final = await stateUntil(sample, (e) => e.phase === 'complete');
    sample.independent = await independentResult(
      website,
      sample,
      item,
      sample.final,
    );
    check(item + ' 完整业务链及实际执行学成流程', () => {
      const e = sample.final;
      assert.equal(e.workflowDecisions.at(-1).status, 'adopted');
      assert.equal(
        e.learnedWorkflows.at(-1).replay.target,
        'observed-entry-route',
      );
      if (['R', 'C', 'P'].includes(item)) {
        const prior = report.cases.at(-2).final.learnedWorkflows.at(-1);
        assert.equal(e.workflowUses[0].workflow.version, prior.version);
        assert.equal(e.learnedWorkflows.at(-1).parentVersion, prior.version);
        assert(
          e.actions.every(
            (a) => a.workflowStep?.useId === e.workflowUses[0].id,
          ),
        );
        if (item !== 'P')
          assert.deepEqual(
            website.receipts
              .filter((r) => r.kind === 'p1-model' && r.item === item)
              .map((r) => r.decision),
            ['reuse'],
          );
      } else assert.equal(e.workflowUses?.length ?? 0, 0);
      if (item === 'P') assert.equal(e.workflowRepairs.length, 1);
    });
  }
  await reopen('最终冷开', report.cases);
  await active.quit();
  assert.deepEqual(remainingOwned(), []);
  const db = new DatabaseSync(path.join(data, 'workspace.sqlite'), {
    readOnly: true,
  });
  try {
    const rows = db.prepare('SELECT task_id, body FROM task_executions').all();
    report.database = {
      quickCheck: db.prepare('PRAGMA quick_check').get().quick_check,
      tasks: rows.length,
    };
    check('退出后独立核对 SQLite 和每项任务的动作归属', () => {
      assert.equal(report.database.quickCheck, 'ok');
      for (const sample of report.cases) {
        const durable = JSON.parse(
          rows.find((row) => row.task_id === sample.taskId).body,
        );
        assert.deepEqual(durable.actions, sample.final.actions);
      }
    });
  } finally {
    db.close();
  }
}
