import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyDynamicResult({client, website, data, evidence, command, waitFor, check, launch, remainingOwned, management = false}) {
  const detail = evidence.dynamicResult = {realModelCalls:0, remoteWrites:0, cases:[], scriptedContinuation:false, management};
  const state = await client.request({kind:'snapshot'});
  await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  for (const item of ['A','B']) {
    const bytes=Buffer.from('dynamic-result-'+item), file=path.join(data,item+'.bin');fs.writeFileSync(file,bytes);
    const title='动态结果标题'+item+'\n\n动态正文'+item, target=website.base+'/edit?item='+item;
    const taskId=(await client.request(command('create',{goal:`使用“${file}”在 ${target} 发布“${title}”到“公告”`}))).taskId;
    const sample={item,taskId,target,readiness:[]};detail.cases.push(sample);
    const get=async (active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async()=>(await get())?.phase==='manual',15000);
    let last, attempts=0;
    await waitFor(async()=>{
      assert(++attempts<=8,'READINESS_LIMIT');
      const dom=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});
      const next=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      sample.readiness.push(next);const stable=next===last;last=next;return stable;
    },15000);
    await client.request(command('execution-intent',{taskId,intent:'start'}));
    const review=sample.review=await waitFor(async()=>{const e=(await get()).execution;return e?.question?.type==='review'&&e;},50000);
    assert.equal(review.publication.content,title);
    assert.equal(website.receipts.filter(r=>r.kind==='published'&&r.item===item).length,0);
    await client.request({kind:'participation-decision',taskId,questionId:review.question.id,operation:'approve'});
    await waitFor(async()=>{const t=await get();return t.url.includes(management ? '/management' : '/dynamic/')&&(item==='A'?t.execution?.phase==='complete':t.execution?.pauseReason==='page-change')&&t;},50000);
    if(item==='B') await new Promise(r=>setTimeout(r,7000));
    const task=sample.result=await get(), e=task.execution, a=e.actions.at(-1);
    check(item+' POST/303动态地址与只读结果独立核对',()=>{
      assert.equal(a.effect,'publication');assert.equal(a.submission.recovery,undefined);
      assert.equal(a.navigation.association,'during-action');assert.equal(a.navigationResolution,undefined);
      assert.equal(a.navigation.url,website.base+'/publish?item='+item);
      assert(!a.observedUrls?.includes(task.url));
      assert.equal(website.receipts.filter(r=>r.kind==='published'&&r.item===item).length,1);
      assert.deepEqual(website.receipts.filter(r=>r.item===item&&['upload','draft','published'].includes(r.kind)).map(r=>r.kind),['upload','draft','published']);
      if(item==='A'){
        assert.equal(e.phase,'complete');if(management){assert.equal(a.discoveredRecovery.entry.name,title.split('\n\n')[0]);assert.equal(a.discoveredRecovery.source.url,task.url);assert.notEqual(a.discoveredRecovery.recovery.url,task.url);}else assert.equal(a.discoveredRecovery.recovery.url,task.url);
        assert.equal(e.publicationChecks[0].status,'verified');
        assert.equal(e.publicationChecks[0].download.sha256,createHash('sha256').update(bytes).digest('hex'));
        assert.equal(a.status,'confirmed');
      }else{
        assert.equal(e.pauseReason,'page-change');assert.equal(a.status,'unknown');
        assert.equal(a.discoveredRecovery,undefined);assert.equal(e.result,undefined);
      }
    });
    if(management){
      const html=await(await fetch(task.url,{signal:AbortSignal.timeout(5000)})).text();
      sample.managementPage={url:task.url,html,sha256:createHash('sha256').update(html).digest('hex')};
    }
    if(item==='A'){
      const html=await(await fetch(a.discoveredRecovery.recovery.url,{signal:AbortSignal.timeout(5000)})).text();
      assert(title.split('\n\n').every(v=>html.includes(v)));
      const download=Buffer.from(await(await fetch(e.publication.attachment.url,{signal:AbortSignal.timeout(5000)})).arrayBuffer());
      assert.deepEqual(download,bytes);
      sample.independentPublicRead={url:a.discoveredRecovery.recovery.url,html,pageSha256:createHash('sha256').update(html).digest('hex'),attachmentUrl:e.publication.attachment.url,bytes:download.length,sha256:createHash('sha256').update(download).digest('hex')};
    }
  }
  detail.plansBeforeCold=website.receipts.filter(r=>r.kind==='planning').length;
  assert(detail.plansBeforeCold<=24,'MODEL_FIXTURE_LIMIT');
  await client.quit();assert.deepEqual(remainingOwned(),[]);
  const cold=await launch();
  for(const sample of detail.cases){
    sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);
    check(sample.item+' 冷开保持结果与未知，不重发或规划',()=>{
      assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);
      assert.equal(sample.cold.execution.phase,sample.result.execution.phase);
      assert.equal(website.receipts.filter(r=>r.kind==='published'&&r.item===sample.item).length,1);
      assert.equal(website.receipts.filter(r=>r.kind==='planning').length,detail.plansBeforeCold);
    });
  }
  await cold.quit();
}
