import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function measureCompletedWorkspace({ active, cases, evidence, out, waitFor, check }) {
  const report = evidence.performance;
  const snapshot = () => active.request({ kind: 'snapshot' });
  const before = await snapshot();
  assert.equal(before.tasks.length, 2);
  const targets = cases.map((sample) => {
    const task = before.tasks.find((item) => item.id === sample.taskId);
    assert.equal(task.execution.phase, 'complete');
    assert.equal(task.url, sample.independent.result);
    return { label: sample.values[0], url: task.url, id: task.id };
  });
  const modelCalls = () => evidence.fixture.filter((row) => row.kind === 'p1-model');
  const effects = () => evidence.fixture.filter((row) =>
    ['p1-created', 'p1-upload', 'p1-linked', 'p1-published'].includes(row.kind));
  const initialModels = modelCalls().length;
  const initialEffects = effects().length;
  report.preparation = { modelCalls: initialModels, siteEffects: initialEffects };
  report.coldReadyMs = evidence.samples.at(-1).ms;
  report.phase = 'settled';
  const nativeTargets = path.join(out, 'native-targets.json');
  fs.writeFileSync(nativeTargets, JSON.stringify({
    app: evidence.app, start: evidence.samples.at(-1).number, targets, active: before.active,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log(`两项完成态可采集原生界面 ${nativeTargets}`);

  const settled = () => report.rss.filter((sample) => sample.phase === 'settled');
  const first = await waitFor(() => settled()[0], 6000);
  const last = await waitFor(() => settled().find((sample) => sample.at >= first.at + 300000), 310000);
  const window = settled().filter((sample) => sample.at <= last.at);
  const tail = window.filter((sample) => sample.at >= last.at - 180000);
  const peakMiB = Math.max(...report.rss.map((sample) => sample.rssKiB)) / 1024;
  const tailMiB = tail.map((sample) => sample.rssKiB / 1024);
  report.settled = {
    from: first.at, to: last.at, spanMs: last.at - first.at, samples: window.length,
    maxSampleGapMs: Math.max(...window.slice(1).map((sample, index) => sample.at - window[index].at)),
    tailFrom: last.at - 180000, tailSamples: tail.length,
    tailRangeMiB: Math.max(...tailMiB) - Math.min(...tailMiB), peakMiB,
    modelCalls: modelCalls().length - initialModels,
    siteEffects: effects().length - initialEffects,
  };
  const after = await snapshot();
  check('完整完成态区间内两项执行保持，未调用模型或产生网页写入', () => {
    assert.equal(after.tasks.length, before.tasks.length);
    for (const task of before.tasks)
      assert.deepEqual(after.tasks.find((item) => item.id === task.id).execution, task.execution);
    assert.equal(report.settled.modelCalls, 0);
    assert.equal(report.settled.siteEffects, 0);
  });
  check('冷启动及 OS RSS 达到 06 的测量门槛', () => {
    assert(report.coldReadyMs <= 5000, 'COLD_READY_LIMIT');
    assert(report.settled.maxSampleGapMs < 4500, 'RSS_SAMPLE_GAP');
    assert(report.settled.peakMiB <= 2048, 'RSS_PEAK_LIMIT');
    assert(report.settled.tailRangeMiB <= 256, 'RSS_TAIL_RANGE_LIMIT');
  });
}
