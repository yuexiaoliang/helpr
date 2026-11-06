import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyArticle({client, website, data, evidence, command, waitFor, check, launch, remainingOwned}) {
  evidence.article = {cases:[], realModelCalls:0, remoteWrites:0, confirmations:'scripted-public-entry'};
  let active = client;
  const configure = async () => {
    const state = await active.request({kind:'snapshot'});
    await active.request(command('model-save',{protocol:'chat-completions', expectedVersion:state.modelSettings?.version??0, endpoint:website.base+'/v1', model:'fixture', apiKey:'local-fixture-not-a-secret'}));
  };
  await configure();
  for (const [item, fileName, first, second] of [['A','report-a.xlsx',7,5],['B','report-b.xlsx',11,2]]) {
    const original = fs.readFileSync(path.join('tests/workspace/fixtures/excel',fileName));
    const file = path.join(data,fileName); fs.writeFileSync(file,original);
    const target = website.base+'/edit?item='+item;
    const taskId = (await active.request(command('create',{goal:`使用“${file}”在 ${target} 发布“读取 Excel 后生成文章，保留原始附件”到“公告”`}))).taskId;
    const get = async () => (await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async ()=>(await get())?.phase==='manual');
    let fingerprint, attempts=0; const readiness=[];
    await waitFor(async()=>{
      if (++attempts>8) throw Error('ARTICLE_READINESS_LIMIT');
      let dom;
      try {dom=await active.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});}
      catch(error){readiness.push({error:error.message});if(['PAGE_NOT_AVAILABLE','OBSERVATION_NOT_AUTHORIZED','STALE_OBSERVATION'].includes(error.message))return false;throw error;}
      const next=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      readiness.push({fingerprint:next});const stable=next===fingerprint;fingerprint=next;return stable;
    },15000);
    await active.request(command('execution-intent',{taskId,intent:'start'}));
    const phase = async wanted => waitFor(async()=>{
      const e=(await get()).execution;
      if(wanted==='review'?e?.question?.type==='review':e?.phase===wanted)return e;
      if(e&&['paused','failed','unknown'].includes(e.phase))throw Error(e.summary);
      return false;
    },50000);
    let review=await phase('review');
    const expected=`项目：数量。\n\n甲：${first}。\n\n乙：${second}。`;
    check(item+' 表格事实、来源与逐任务未确认预览一致',()=>{
      assert.equal(review.publication.content,expected);
      assert.equal(review.publication.approvalId,null);
      assert.equal(review.contentSources[0].materialSha256,createHash('sha256').update(original).digest('hex'));
      assert.equal(review.articles[0].sourceId,review.contentSources[0].id);
      assert.equal(review.contentSources[0].sheets[0].cells.find(c=>c.address==='B4').status,'formula-unverified');
      assert.equal(website.receipts.filter(r=>r.item===item&&r.kind==='published').length,0);
    });
    // 仅改变来源路径的字节，产品仍须使用已选定副本。
    fs.writeFileSync(file,fs.readFileSync(path.join('tests/workspace/fixtures/excel',item==='A'?'report-b.xlsx':'report-a.xlsx')));
    let expectedFinal=expected;
    if(item==='A'){
      const oldQuestion=review.question.id;
      expectedFinal=expected+'\n\n已核对原始数据，合计公式尚待确认。';
      await active.request({kind:'participation-decision',taskId,questionId:oldQuestion,operation:'edit',content:expectedFinal});
      review=(await get()).execution;
      await assert.rejects(()=>active.request({kind:'participation-decision',taskId,questionId:oldQuestion,operation:'approve'}),/REQUEST_CONTENT_CONFLICT|PARTICIPATION_EXPIRED/);
      check('改稿产生新版本且旧回复被拒绝',()=>{
        assert.equal(review.articles.length,2);assert.equal(review.publication.content,expectedFinal);assert.equal(review.publication.approvalId,null);
      });
    }
    const questionId=review.question.id;
    await active.request({kind:'participation-decision',taskId,questionId,operation:'approve'});
    const done=await phase('complete');
    await active.request({kind:'participation-decision',taskId,questionId,operation:'approve'});
    const downloaded=Buffer.from(await(await fetch(done.publication.attachment.url,{signal:AbortSignal.timeout(5000)})).arrayBuffer());
    const html=await(await fetch(done.publicationChecks[0].proposal.url,{signal:AbortSignal.timeout(5000)})).text();
    const calls=(await get()).messages.filter(m=>m.call).map(m=>m.call);
    const writes=website.receipts.filter(r=>r.item===item&&['upload','draft','published'].includes(r.kind));
    check(item+' 独立公开正文、源表数字、原始附件及一次发布核对',()=>{
      assert(html.includes(expectedFinal));assert(html.includes('公告'));
      assert.deepEqual(downloaded,original);
      assert.deepEqual(writes.map(r=>r.kind),['upload','draft','published']);
      assert.equal(done.materialProcessing[0].status,'complete');
      assert.equal(calls.filter(c=>c.usageKind==='material-content').length,1);
      assert(calls.filter(c=>c.usageKind!=='material-content').every(c=>['web-planning','intent-and-inputs'].includes(c.usageKind)));
    });
    evidence.article.cases.push({item,taskId,expectedFinal,sha256:createHash('sha256').update(original).digest('hex'),review,done,calls,writes,readiness});
  }
  const before=await active.request({kind:'snapshot'});
  await active.quit();
  assert.equal(remainingOwned().length,0,'COLD_START_REQUIRES_OLD_PROCESSES_GONE');
  active=await launch();
  const after=await active.request({kind:'snapshot'});
  check('冷重开保持解析、文章、有效确认及结果，不重复发布',()=>{
    for(const prior of before.tasks.filter(t=>t.execution?.articles?.length)){
      const next=after.tasks.find(t=>t.id===prior.id);
      for(const key of ['articles','contentSources','publication','publicationChecks','materialProcessing'])assert.deepEqual(next.execution[key],prior.execution[key]);
    }
    assert.equal(website.receipts.filter(r=>r.kind==='published').length,2);
  });
  evidence.article.cold={before,after};
  await active.quit();
}
