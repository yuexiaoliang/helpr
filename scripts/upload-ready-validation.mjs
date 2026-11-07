import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyUploadReady({client,website,data,evidence,command,waitFor,check,launch,remainingOwned}) {
  const detail=evidence.uploadReady={cases:[],realModelCalls:0,remoteWrites:0,scriptedContinuation:false};
  const state=await client.request({kind:'snapshot'});
  await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  for(const item of ['A','B']){
    const bytes=Buffer.from('asynchronous-material-'+item),file=path.join(data,item+'.bin');fs.writeFileSync(file,bytes);
    const target=website.base+'/edit?item='+item,title='异步附件'+item;
    const taskId=(await client.request(command('create',{goal:`使用“${file}”在 ${target} 发布“${title}”到“公告”`}))).taskId;
    const sample={item,taskId,target,readiness:[]};detail.cases.push(sample);
    const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async()=>(await get())?.phase==='manual',15000);
    let previous,attempts=0;
    await waitFor(async()=>{
      assert(++attempts<=8,'READINESS_LIMIT');
      const dom=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});
      const fingerprint=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');sample.readiness.push(fingerprint);
      const stable=previous===fingerprint;previous=fingerprint;return stable;
    },15000);
    await client.request(command('execution-intent',{taskId,intent:'start'}));
    await waitFor(async()=>website.receipts.some(r=>r.kind==='upload'&&r.item===item),50000);
    sample.waiting=await get();
    check(item+' 异步上传待回填时不保存或规划',()=>{
      assert.deepEqual(website.receipts.filter(r=>r.item===item&&['draft','published'].includes(r.kind)),[]);
      assert.equal(sample.waiting.execution.actions.length,1);
      assert.equal(sample.waiting.execution.actions[0].uploadCheck,undefined);
    });
    if(item==='A'){
      const review=sample.review=await waitFor(async()=>{const e=(await get()).execution;return e.question?.type==='review'&&e;},50000);
      const upload=review.actions[0], ready=website.receipts.find(r=>r.kind==='attachment-ready'&&r.item===item);
      check('A 稳定链接与下载字节核对后才保存草稿',()=>{
        assert.equal(upload.status,'confirmed');assert.equal(upload.uploadCheck.rule,'unique-new-link-v1');
        assert.equal(upload.uploadCheck.download.sha256,createHash('sha256').update(bytes).digest('hex'));
        assert(upload.resultSource.observedAt>=ready.at);
        assert(website.receipts.find(r=>r.kind==='draft'&&r.item===item).at>=upload.uploadCheck.download.checkedAt);
      });
      await client.request({kind:'participation-decision',taskId,questionId:review.question.id,operation:'approve'});
      sample.result=await waitFor(async()=>{const t=await get();return t.execution?.phase==='complete'&&t;},50000);
      const downloaded=Buffer.from(await(await fetch(upload.uploadCheck.download.url,{signal:AbortSignal.timeout(5000)})).arrayBuffer());
      assert.deepEqual(downloaded,bytes);
      const publicURL=sample.result.execution.publicationChecks[0].proposal.url;
      const html=await(await fetch(publicURL,{signal:AbortSignal.timeout(5000)})).text();assert(html.includes(title));
      sample.independent={base64:downloaded.toString('base64'),bytes:downloaded.length,sha256:createHash('sha256').update(downloaded).digest('hex'),publicURL,html};
    }else{
      sample.result=await waitFor(async()=>{const t=await get();return t.execution?.phase==='unknown'&&t;},50000);
      check('B 两个新地址保持未知，不下载候选或保存发布',()=>{
        assert.deepEqual(website.receipts.filter(r=>r.item===item&&['download','draft','published'].includes(r.kind)),[]);
        assert.equal(sample.result.execution.actions.length,1);assert.equal(sample.result.execution.actions[0].status,'unknown');
        assert.equal(sample.result.execution.actions[0].uploadCheck,undefined);
      });
    }
    const upload=website.receipts.find(r=>r.kind==='upload'&&r.item===item), ready=website.receipts.find(r=>r.kind==='attachment-ready'&&r.item===item);
    assert(ready.at-upload.at>=1700);
    assert.equal(website.receipts.filter(r=>r.kind==='planning'&&r.item===item&&r.at>upload.at&&r.at<ready.at).length,0);
    assert.equal(website.receipts.filter(r=>r.kind==='upload'&&r.item===item).length,1);
  }
  assert(!website.receipts.some(r=>r.kind==='premature-draft'));
  detail.plansBeforeCold=website.receipts.filter(r=>r.kind==='planning').length;assert(detail.plansBeforeCold<=20);
  await client.quit();assert.deepEqual(remainingOwned(),[]);
  const cold=await launch();
  for(const sample of detail.cases){
    sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);
    assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);
    assert.equal(sample.cold.execution.phase,sample.result.execution.phase);
    assert.equal(website.receipts.filter(r=>r.kind==='upload'&&r.item===sample.item).length,1);
  }
  assert.equal(website.receipts.filter(r=>r.kind==='planning').length,detail.plansBeforeCold);
  await cold.quit();
}
