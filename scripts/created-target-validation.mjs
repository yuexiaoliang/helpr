import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export async function verifyCreatedTarget({client, website, evidence, command, waitFor, check, launch, remainingOwned,mismatch=false}) {
  const receipts = () => website.receipts;
  const detail=evidence.createdTarget={realModelCalls:0,remoteWrites:0,scriptedContinuation:false,cases:[]};
  const state=await client.request({kind:'snapshot'});
  await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  for(const item of [mismatch ? 'B' : 'A']) {
    const site = website;
    const entry=site.base+'/new-draft?item='+item;
    const taskId=(await client.request(command('create',{goal:`在 ${entry} 创建“独立草稿${item}”到公告，随后补充正文`}))).taskId;
    const sample={item,taskId,entry,readiness:[]};detail.cases.push(sample);
    const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async()=>(await get())?.phase==='manual',15000);
    let previous, attempts=0;
    await waitFor(async()=>{assert(++attempts<=8,'READINESS_LIMIT');const dom=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});const hash=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');sample.readiness.push(hash);const stable=previous===hash;previous=hash;return stable;},15000);
    await client.request(command('execution-intent',{taskId,intent:'start'}));
    await waitFor(async()=>{const t=await get();return t.url.includes('/created/')&&t.execution?.pauseReason==='page-change'&&(item==='B'||t.execution.actions[0]?.discoveredTarget)&&t;},50000);
    if(item==='B')await new Promise(r=>setTimeout(r,7000));
    sample.result=await get();const e=sample.result.execution,a=e.actions[0];
    check(item+' 动态草稿身份与只读暂停',()=>{
      assert.equal(e.phase,'paused');assert.equal(e.pauseReason,'page-change');assert.equal(a.navigation.association,'during-action');assert.equal(a.navigationResolution,undefined);
      assert.equal(e.actions.length,1);assert.equal(a.effect,'draft');assert(!a.observedUrls.includes(sample.result.url));
      const writes=receipts().filter(r=>r.kind==='target-created'&&r.item===item);assert.equal(writes.length,1);assert.equal(sample.result.url,site.base+writes[0].route);
      if(item==='A'){assert.equal(a.status,'confirmed');assert.equal(a.discoveredTarget.source.url,sample.result.url);assert.deepEqual(e.preparation.map(f=>f.kind),['target','draft']);}
      else{assert.equal(a.status,'unknown');assert.equal(a.discoveredTarget,undefined);assert.equal(e.preparation,undefined);}
    });
  }
  detail.plans=receipts().filter(r=>r.kind==='target-planning').length;assert.equal(detail.plans,1);
  await client.quit();assert.deepEqual(remainingOwned(),[]);const cold=await launch();
  for(const sample of detail.cases){sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);
    check(sample.item+' 冷开不重建不规划',()=>{assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);assert.deepEqual(sample.cold.execution.preparation,sample.result.execution.preparation);assert.equal(sample.cold.execution.phase,'paused');assert.equal(receipts().filter(r=>r.kind==='target-created'&&r.item===sample.item).length,1);assert.equal(receipts().filter(r=>r.kind==='target-planning').length,1);});
  }
  await cold.quit();
}
