import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function verifyFormNavigation({client,website,data,evidence,command,waitFor,check,launch,remainingOwned}) {
  const detail=evidence.formNavigation={profile:data,realModelCalls:0,remoteWrites:0,scriptedContinuation:false,cases:[]};
  const state=await client.request({kind:'snapshot'});
  await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  for(const item of ['A','B']){
    const entry=website.base+'/form-new?item='+item;
    const taskId=(await client.request(command('create',{goal:`在 ${entry} 创建“独立草稿${item}”到公告，并将正文填写为“自动续行正文”`}))).taskId;
    const sample={item,taskId,entry,readiness:[]};detail.cases.push(sample);
    const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async()=>(await get())?.phase==='manual',15000);
    let previous,attempts=0;
    await waitFor(async()=>{assert(++attempts<=8,'READINESS_LIMIT');const dom=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});const hash=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');sample.readiness.push(hash);const stable=previous===hash;previous=hash;return stable;},15000);
    await client.request(command('execution-intent',{taskId,intent:'start'}));
    await waitFor(async()=>{const t=await get();return item==='A'?t?.execution?.phase==='complete':t?.execution?.actions[0]?.discoveredTarget;},50000);
    if(item==='B')await new Promise(r=>setTimeout(r,7000));
    sample.result=await get();sample.html=await (await fetch(sample.result.url,{signal:AbortSignal.timeout(5000)})).text();
    check(item+' 表单新页与剩余动作',()=>{
      const e=sample.result.execution,a=e.actions[0];assert(a.discoveredTarget);assert.equal(a.status,'confirmed');assert.equal(a.navigationResolution,undefined);
      assert.equal(website.receipts.filter(r=>r.kind==='form-created'&&r.item===item).length,1);
      if(item==='A'){assert.equal(e.phase,'complete');assert.equal(e.actions.length,2);assert.equal(a.formNavigationResolution.proof.reason,'formSubmissionPost');assert.equal(a.formNavigationResolution.pausedInputEpoch,a.navigation.inputEpoch+2);assert.equal(e.actions[1].action.kind,'fill');assert(sample.html.includes('<textarea>自动续行正文</textarea>'));}
      else{assert.equal(e.phase,'paused');assert.equal(e.pauseReason,'page-change');assert.equal(e.actions.length,1);assert.equal(a.formNavigationResolution,undefined);assert(sample.html.includes('<textarea></textarea>'));}
    });
  }
  detail.plans=website.receipts.filter(r=>r.kind==='form-planning').length;assert.equal(detail.plans,4);
  await client.quit();assert.deepEqual(remainingOwned(),[]);const cold=await launch();
  for(const sample of detail.cases){sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);check(sample.item+' 冷开不重发',()=>{assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);assert.equal(sample.cold.execution.phase,sample.result.execution.phase);});}
  assert.equal(website.receipts.filter(r=>r.kind==='form-planning').length,detail.plans);assert.equal(website.receipts.filter(r=>r.kind==='form-created').length,2);assert.equal(website.receipts.filter(r=>r.kind==='form-filled').length,1);
  await cold.quit();
}
