import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export async function verifyWorkflow({ client, website, data, evidence, command, waitFor, check, launch, remainingOwned, crossSite = false, ambiguousSelection = false, historyCleanup = false, separateFields = false }) {
  const cases = [
    { item: 'A', title: '第一次附件日报', destination: '公告', bytes: Buffer.from([0, 1, 2, 128, 255]) },
    { item: 'B', title: '换输入后的新日报', destination: '通知', bytes: Buffer.from([1, 7, 9, 128, 12, 255]) },
    { item: 'C', title: '冷开后的第三份日报', destination: '公告', bytes: Buffer.from([255, 24, 99, 0, 8]) },
  ];
  if (separateFields) for (const sample of cases) sample.title += '\n\n这段正文属于' + sample.item;
  if (crossSite) {
    for (const [index, sample] of cases.entries()) sample.bytes = fs.readFileSync(path.join('tests/workspace/fixtures/excel', ['report-a.xlsx','report-b.xlsx','edges-1904.xlsx'][index]));
    const negative = {item:ambiguousSelection?'E':'D',title:'错误选择核对',destination:'通知',bytes:cases[1].bytes,negative:true};
    if(ambiguousSelection)cases.splice(0,cases.length,negative);
    else cases.push(negative);
  }
  evidence.workflow = { cases: [], cold: null, separateFields, crossSite, ambiguousSelection, confirmations:'scripted-public-entry', realModelCalls: 0, remoteWrites: 0 };
  const configure = async active => {
    const state = await active.request({ kind: 'snapshot' });
    await active.request(command('model-save', { protocol: 'chat-completions', expectedVersion: state.modelSettings?.version ?? 0, endpoint: website.base + '/v1', model: 'fixture', apiKey: 'local-fixture-not-a-secret' }));
  };
  await configure(client);
  let active = client, learned;
  for (const sample of cases) {
    if (sample.item === 'C') {
      const before = await active.request({ kind: 'snapshot' });
      await active.quit();
      const remaining = remainingOwned();
      assert.equal(remaining.length, 0, 'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
      evidence.workflow.cold = { before, remaining, checkedAt: Date.now() };
      active = await launch();
      await configure(active);
    }
    const file = path.join(data, sample.item + (crossSite ? '-新素材.xlsx' : '-新素材.bin')); fs.writeFileSync(file, sample.bytes);
    const target = website.base + '/edit?item=' + sample.item;
    const taskId = (await active.request(command('create', { goal: `使用“${file}”在 ${target} 发布“${sample.title}”到“${sample.destination}”` }))).taskId;
    const get = async () => (await active.request({ kind: 'snapshot' })).tasks.find(t => t.id === taskId);
    await waitFor(async () => (await get())?.phase === 'manual');
    // 有限只读稳定准备，保留每次观察错误；不改变产品资格判断。
    let fingerprint, attempts = 0;
    const readiness = [];
    await waitFor(async () => {
      if (++attempts > 8) throw Error('WORKFLOW_READINESS_LIMIT');
      let dom;
      try { dom = await active.request({ kind: 'observe', taskId, method: 'DOMSnapshot.captureSnapshot' }); }
      catch (error) { readiness.push({ error: error.message }); if (['PAGE_NOT_AVAILABLE', 'OBSERVATION_NOT_AUTHORIZED', 'STALE_OBSERVATION'].includes(error.message)) return false; throw error; }
      const next = createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      readiness.push({ fingerprint: next, documents: dom.documents.length });
      const stable = fingerprint === next; fingerprint = next; return stable;
    }, 15000);
    await active.request(command('execution-intent', { taskId, intent: 'start' }));
    const readPhase = async phase => waitFor(async () => {
      const e = (await get()).execution;
      if (phase === 'review' ? e?.question?.type === 'review' : e?.phase === phase) return e;
      if (e && ['paused', 'unknown', 'failed'].includes(e.phase)) throw Error(e.summary);
      return false;
    }, 50000);
    const review = await readPhase('review');
    check(sample.item + ' 本次素材、目标和确认独立，批准前没有发布', () => {
      assert.equal(review.publication.content, sample.title);
      assert.equal(review.publication.destination, sample.destination);
      assert.equal(review.publication.attachment.targetUrl, target);
      assert.equal(review.publication.approvalId, null);
      assert.equal(website.receipts.filter(r => r.item === sample.item && r.kind === 'published').length, 0);
      if (learned) assert.deepEqual(review.workflowUses[0].workflow, learned);
    });
    await active.request({ kind: 'participation-decision', taskId, questionId: review.question.id, operation: 'approve' });
    if (sample.negative) {
      const paused = await waitFor(async()=>{const task=await get();return ['paused','unknown'].includes(task.execution?.phase) && task.execution;},50000);
      check(sample.item+' 选择不符或重复标签时不发布、不重复选择',()=>{
        assert.equal(website.receipts.filter(r=>r.kind==='published' && r.item===sample.item).length,0);
        assert.equal(paused.actions.filter(a=>a.action.kind==='select').length,1);
        assert.equal(paused.actions.at(-1).action.kind,'select');
        assert.notEqual(paused.actions.at(-1).status,'confirmed');
        assert.equal(website.receipts.filter(r=>r.kind==='selection' && r.item===sample.item).length,sample.item==='D'?1:0);
        if(sample.item==='D')assert(paused.summary.includes('实际选中'));
        else {
          const diagnostics=fs.readdirSync(path.join(data,'diagnostics')).filter(name=>name.startsWith('controller.') && name.endsWith('.log')).flatMap(name=>fs.readFileSync(path.join(data,'diagnostics',name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
          assert(diagnostics.some(entry=>entry.taskId===taskId && entry.code==='EXECUTION_ACT_SELECTION_UNAVAILABLE'),'DUPLICATE_LABEL_MUST_BE_REJECTED_EXPLICITLY');
        }
      });
      evidence.workflow.cases.push({item:sample.item,taskId,review,paused,negative:true});
      continue;
    }
    const done = await readPhase('complete');
    const bytes = Buffer.from(await (await fetch(done.publication.attachment.url, { signal: AbortSignal.timeout(5000) })).arrayBuffer());
    const html = await (await fetch(done.publicationChecks[0].proposal.url, { signal: AbortSignal.timeout(5000) })).text();
    const sha256 = createHash('sha256').update(sample.bytes).digest('hex');
    const state = await active.request({ kind: 'snapshot' });
    const calls = state.tasks.find(t => t.id === taskId).messages.filter(m => m.call).map(m => m.call);
    const writes = website.receipts.filter(r => r.item === sample.item && ['upload', 'draft', 'published'].includes(r.kind));
    check(sample.item + ' 独立下载字节、全文栏目、唯一结果及分项模型记录', () => {
      assert.deepEqual(bytes, sample.bytes);
      assert((separateFields ? sample.title.split('\n\n').every(part=>html.includes(part)) : html.includes(sample.title)) && html.includes(sample.destination));
      if (separateFields) {
        assert.deepEqual(done.publication.fields.map(f=>f.value), sample.title.split('\n\n'));
        assert.deepEqual(done.actions.at(-1).fieldResults.map(f=>f.textValue), sample.title.split('\n\n'));
        assert.equal(done.actions.filter(a=>a.action.kind==='fill').length,2);
      }
      assert.equal(done.publicationChecks[0].download.sha256, sha256);
      assert.deepEqual(writes.map(r => r.kind), ['upload', 'draft', 'published']);
      assert.equal(done.materialProcessing[0].status, 'complete');
      if (learned) {
        assert.equal(done.workflowUses[0].workflow.version, learned.version);
        assert.equal(website.receipts.filter(r => r.item === sample.item && r.kind === 'planning').length, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].usageKind, 'intent-and-inputs');
        assert(done.actions.every(a => a.workflowStep));
      } else {
        learned = done.learnedWorkflows[0];
        assert(learned.replay, 'LEARNED_LINK_RULES_REQUIRED');
        assert(calls.every(c => c.usageKind === 'web-planning'));
      }
    });
    if(crossSite)check(sample.item+' 显示标签与内部值分开，结果保存实际选中证明',()=>{
      const selected=done.actions.find(a=>a.action.kind==='select');
      assert.equal(selected.selectionResult.selectedLabel,sample.destination);
      assert.equal(selected.selectionResult.name,'栏目：选择');
      const received=website.receipts.find(r=>r.kind==='selection'&&r.item===sample.item);
      assert.equal(received.value,sample.destination==='通知'?'42':'17');
      assert.equal(received.label,sample.destination);
    });
    learned = done.learnedWorkflows[0];
    evidence.workflow.cases.push({ item: sample.item, taskId, sha256, review, done, calls, writes, readiness });

  }
  if (historyCleanup) {
    const all = await active.request({kind:'snapshot'}), task = all.tasks.at(-1), original = task.execution;
    const protectedPreview = await active.request({kind:'cleanup-preview',taskIds:[all.tasks[0].id]});
    check('被其它流程引用的历史保持保护',()=>assert.equal(protectedPreview.tasks[0].eligible,false));
    const preview = await active.request({kind:'cleanup-preview',taskIds:[task.id]});
    check('主动预览列出副本及释放大小',()=>{
      assert.equal(preview.tasks[0].eligible,true);
      assert.equal(preview.bytes, original.materials[0].bytes);
    });
    const commit = {kind:'cleanup-commit',taskIds:[task.id],requestId:randomUUID(),token:preview.token};
    const receipt = await active.request(commit);
    check('清理后原素材、服务器结果与关键证明保留',()=>{
      assert.equal(receipt.phase,'complete');
      assert.equal(fs.existsSync(path.join(data,'materials',original.materials[0].sha256)),false);
      assert.equal(fs.existsSync(original.materials[0].source),true);
      const e=receipt.state.tasks.find(t=>t.id===task.id).execution;
      for(const field of ['actions','materialProcessing','publicationChecks','learnedWorkflows']) assert.deepEqual(e[field],original[field]);
      assert.equal(website.receipts.filter(r=>r.kind==='published').length,3);
    });
    const retry=await active.request(commit);
    assert.equal(retry.removedBytes,0);
    await assert.rejects(active.request(command('execution-intent',{taskId:task.id,intent:'continue'})),/HISTORY_CLEANED/);
    await active.quit();
    assert.equal(remainingOwned().length,0,'CLEANUP_COLD_REQUIRES_NO_OWNED_PROCESSES');
    active = await launch();
    const cold = await active.request({kind:'snapshot'});
    check('清理标记冷开保留且未增加发布',()=>{
      assert.equal(cold.tasks.find(t=>t.id===task.id).execution.historyCleanup.requestId,commit.requestId);
      assert.equal(website.receipts.filter(r=>r.kind==='published').length,3);
    });
    evidence.cleanup={protectedPreview,preview,commit,receipt,retry,cold};
  }
  await active.quit();
}
