// 只核对留存证据，不连接测试网站、不读取登录态、不启动新执行。
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { directory, load, hash } from './common.mjs';

const root = path.join(directory, 'artifacts/2026-10-11T09-46-51-576Z');
const json = file => load(path.join(root, file));
const lines = async file => {
  try { return (await readFile(path.join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const absent = async file => { await assert.rejects(access(path.join(root, file)), { code: 'ENOENT' }); };
const check = async (name, fn) => { await fn(); console.log('通过：' + name); };
const study = await json('study.json');

await check('预算、原失败与额度变更保留', async () => {
  assert.equal(Object.keys(study.cases).length, 10);
  assert.equal(study.limits.preparations, 10);
  assert.equal(study.amendments[0].from, 6); assert.equal(study.amendments[0].to, 10);
  assert.equal(study.reservations.filter(r => r.kind === 'upload').length, 6);
  assert.equal(study.reservations.filter(r => r.kind === 'publication').length, 2);
  assert.equal(study.reservations.filter(r => r.historicalBackfill).length, 2);
  assert.equal(study.limits.modelCalls, 0);
  assert.equal(study.versions.length - 1, study.limits.revisions);
  for (const name of ['A', 'B', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4']) {
    const run = await json(`${name}/interrupted/supervisor.json`);
    assert.equal(run.exit.code, 1); assert.ok(run.failure);
  }
  assert.equal((await json('study-before-upload-backfill.json')).limits.preparations, 6);
});

await check('每版协议与共享依赖均有匹配源快照', async () => {
  for (const [index, version] of study.versions.entries()) {
    assert.equal(hash(version.sourceHashes), version.fingerprint);
    for (const [file, expected] of Object.entries(version.sourceHashes)) {
      assert.equal(hash(await readFile(path.join(root, 'source', String(index + 1), file.replace(/^\.\.\//, 'shared/')))), expected);
    }
  }
  for (const [file, expected] of Object.entries(study.versions.at(-1).sourceHashes)) {
    assert.equal(hash(await readFile(path.join(directory, file))), expected);
  }
});

const a = await json('A5/task.json'), b = await json('B5/task.json');
await check('同名任务的执行、正文、素材与稳定目标均独立', async () => {
  assert.equal(a.inputs.post_title.value, b.inputs.post_title.value);
  assert.notEqual(a.executionId, b.executionId);
  assert.notEqual(a.inputs.post_content.value, b.inputs.post_content.value);
  assert.notEqual(a.inputs.attachment_excel.sha256, b.inputs.attachment_excel.sha256);
  for (const [name, task] of [['A5', a], ['B5', b]]) {
    assert.equal(hash(await readFile(path.join(root, name, task.params.fileName))), task.inputs.attachment_excel.sha256);
  }
  const ar = await json('A5/record.json'), br = await json('B5/record.json');
  assert.notEqual(ar.record.editorUrl, br.record.editorUrl);
  const ae = await lines('A5/interrupted/events.jsonl'), be = await lines('B5/interrupted/events.jsonl');
  assert.ok(Math.max(Date.parse(ae[0].at), Date.parse(be[0].at)) < Math.min(
    Date.parse(ae.find(x => x.type === 'kill-request').at), Date.parse(be.find(x => x.type === 'kill-request').at)));
});

async function verdict(caseName, label, decision, reason) {
  const s = await json(`${caseName}/${label}/supervisor.json`);
  const r = await json(`${caseName}/${label}/result.json`);
  const task = await json(`${caseName}/task.json`);
  assert.equal(s.exit.code, 0); assert.equal(r.decision, decision);
  assert.equal(r.taskId, task.id); assert.equal(r.executionId, task.executionId);
  if (reason) assert.equal(r.reason, reason);
  if (decision === 'completed' || r.observedEffect === 'completed') {
    assert.equal(r.evidence.length, 4); assert.ok(r.evidence.every(x => x.ok));
    assert.equal(hash(await readFile(path.join(root, caseName, label, 'runtime-download.bin'))), task.inputs.attachment_excel.sha256);
  }
  return r;
}

await check('收到提交但丢失回执后重新观察完成，不再发布', async () => {
  const killed = await json('A5/interrupted/supervisor.json');
  assert.equal(killed.exit.signal, 'SIGKILL'); assert.equal(killed.checkpoint, 'response-lost');
  assert.equal(killed.forwardedPublications, 1);
  const proxy = await lines('A5/interrupted/proxy/events.jsonl');
  assert.ok(proxy.some(e => e.type === 'response-withheld' && e.status === 200));
  const result = await verdict('A5', 'recovered', 'completed');
  assert.equal(result.previousPhase, 'dispatching'); assert.notEqual(result.pid, killed.pid);
});

await check('草稿重启后只提交原记录，未重新上传', async () => {
  const killed = await json('B5/interrupted/supervisor.json');
  assert.equal(killed.exit.signal, 'SIGKILL'); assert.equal(killed.checkpoint, 'prepared');
  assert.equal(killed.forwardedPublications, 0);
  const ready = await verdict('B5', 'before-dispatch', 'ready-to-continue');
  assert.equal(ready.automaticAction, 'resume-final-step-only');
  const resumed = await json('B5/continued/supervisor.json');
  assert.equal(resumed.exit.signal, 'SIGKILL'); assert.equal(resumed.checkpoint, 'observed');
  assert.equal(resumed.forwardedPublications, 1); assert.equal(resumed.forwardedUploads, 0);
  assert.notEqual(resumed.pid, killed.pid);
  await verdict('B5', 'after-observed', 'completed');
});

await check('误配结果和临时不可用都停在无法确定，故障解除可再观察', async () => {
  const foreign = await verdict('B5', 'foreign-result', 'uncertain', 'result-not-confirmed');
  assert.ok(foreign.detail.evidence.some(x => x.condition.covers === 'post_title' && x.ok));
  assert.ok(foreign.detail.evidence.some(x => x.condition.covers === 'post_content' && !x.ok));
  await verdict('A5', 'hidden-result', 'uncertain', 'result-not-confirmed');
  await verdict('A5', 'visible-again', 'completed');
});

await check('已核对结果、完成判断尚未保存时再次终止仍可重新判定', async () => {
  const s = await json('A5/verified-crash/supervisor.json');
  assert.equal(s.exit.signal, 'SIGKILL'); assert.equal(s.checkpoint, 'result-verified');
  const observed = await json('A5/verified-crash/verified-before-checkpoint.json');
  assert.ok(observed.evidence.every(x => x.ok));
  await absent('A5/verified-crash/result.json');
  await verdict('A5', 'after-verified-crash', 'completed');
});

await check('派发标记与实际发送之间的空隙不被当成可重试', async () => {
  const s = await json('A4/dispatch-gap/supervisor.json');
  assert.equal(s.exit.signal, 'SIGKILL'); assert.equal(s.checkpoint, 'dispatch-gap');
  assert.equal(s.forwardedUploads, 0); assert.equal(s.forwardedPublications, 0);
  const r = await verdict('A4', 'after-dispatch-gap', 'uncertain', 'dispatch-may-have-happened');
  assert.equal(r.previousPhase, 'dispatching'); assert.equal(r.automaticAction, 'none');
});

await check('停止、待确认与人工接管跨重启保持，网页完成也不解除意图', async () => {
  for (const intent of ['stopped', 'awaiting-confirmation', 'human-control']) {
    for (const name of ['A5', 'B5']) {
      const r = await verdict(name, intent, 'held');
      assert.equal(r.intent, intent); assert.equal(r.automaticAction, 'none');
      assert.equal(r.observedEffect, name === 'A5' ? 'completed' : 'draft-ready');
    }
  }
});

await check('所有恢复阶段均未向网站转发写请求', async () => {
  let count = 0;
  for (const name of Object.keys(study.cases)) {
    for (const entry of await readdir(path.join(root, name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = `${name}/${entry.name}/supervisor.json`;
      let s; try { s = await json(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (s.mode !== 'recover') continue;
      count++;
      assert.equal(s.forwardedPublications, 0); assert.equal(s.forwardedUploads, 0);
      assert.ok(!(await lines(`${name}/${entry.name}/proxy/events.jsonl`)).some(e => e.type === 'forward'));
    }
  }
  assert.equal(count, 15);
});

await check('最终网页列表仅有两份对应发布，原失败草稿仍为草稿', async () => {
  const audit = (await json('posts-audit.json')).data.result;
  assert.ok(Date.parse(audit.at) < study.deadline);
  assert.equal(audit.rows.length, 4);
  const results = audit.rows.flatMap(row => row.links.filter(link => link.name.startsWith('View “')).map(link => link.url));
  const expected = [(await json('A5/recovered/result.json')).resultUrl, (await json('B5/after-observed/result.json')).resultUrl];
  assert.deepEqual(results.sort(), expected.sort());
  assert.equal(audit.rows.filter(row => row.text.includes('— Draft')).length, 2);
});
