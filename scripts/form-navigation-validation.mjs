import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function verifyFormNavigation({client,website,data,evidence,command,waitFor,check,launch,remainingOwned,chain=false,blank=false}) {
  const detail=evidence.formNavigation={profile:data,realModelCalls:0,remoteWrites:0,scriptedContinuation:false,blank,cases:[]};
  // 仅在隔离资料读取本轮原生追踪，不产生输入，也不解除阻断。
  const files=fs.readdirSync(data).filter(n=>n.startsWith('.input-gate-'));
  assert.equal(files.length,1,'ONE_NATIVE_GATE_REQUIRED');
  const gate=createRequire(import.meta.url)(path.join(evidence.app,'Contents/Resources/input-bridge.node'));
  gate.open(path.join(data,files[0]),false);
  const state=await client.request({kind:'snapshot'});
  await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  for(const item of (chain&&!blank?['A','B','C']:['A','B'])){
    const successful=blank?item==='A':item!=='C';
    const entry=website.base+'/form-new?item='+item;
    const taskId=(await client.request(command('create',{goal:blank?`在 ${entry} 按页面创建编号创建空白草稿到公告，再填写正文为“自动续行正文”`:`在 ${entry} 创建“独立草稿${item}”到公告，并将正文填写为“自动续行正文”`}))).taskId;
    const sample={item,taskId,entry,readiness:[]};detail.cases.push(sample);
    const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
    await waitFor(async()=>(await get())?.phase==='manual',15000);
    let previous,attempts=0;
    await waitFor(async()=>{assert(++attempts<=8,'READINESS_LIMIT');const dom=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});if(blank)sample.domBefore=dom;const hash=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');sample.readiness.push(hash);const stable=previous===hash;previous=hash;return stable;},15000);
    if(blank)sample.axBefore=await client.request({kind:'observe',taskId,method:'Accessibility.getFullAXTree'});
    await client.request(command('execution-intent',{taskId,intent:'start'}));
    try {
      await waitFor(async()=>{const t=await get();sample.last=t;
        if(t?.execution?.phase==='paused' && t.execution.pauseReason!=='page-change') throw Error('FORM_NAVIGATION_INTERRUPTED:'+t.execution.pauseReason);
        return successful?t?.execution?.phase==='complete':t?.execution?.pauseReason==='page-change';},50000);
    } finally { sample.nativeTrace=gate.traceRead();sample.nativeGate=gate.state(taskId); }
    if(!successful)await new Promise(r=>setTimeout(r,7000));
    sample.result=await get();sample.html=await (await fetch(sample.result.url,{signal:AbortSignal.timeout(5000)})).text();
    check(item+' 表单新页与剩余动作',()=>{
      const e=sample.result.execution,a=e.actions[0];if(successful){assert(a.discoveredTarget);assert.equal(a.status,'confirmed');if(blank){assert.equal(a.targetCreation.rule,'readonly-identity-editor-v1');assert(a.creationSourceControls.some(c=>c.readOnly&&c.textValue===a.targetCreation.identity.value));assert(a.discoveredTarget.controls.some(c=>c.readOnly&&c.textValue===a.targetCreation.identity.value));}}assert.equal(a.navigationResolution,undefined);
      assert.equal(website.receipts.filter(r=>r.kind==='form-created'&&r.item===item).length,1);
      if(successful){assert.equal(e.phase,'complete');assert.equal(e.actions.length,2);assert.equal(a.formNavigationResolution.proof.reason,'formSubmissionPost');const r=a.formNavigationResolution,c=r.proof.chain;assert(c);assert.equal(c.finalUrl,sample.result.url);assert.equal(c.requests.length,blank?3:item==='A'?1:3);assert.equal(r.chain.host.events.length,c.requests.length);const blocks=[...r.chain.host.events,...r.chain.control].sort((a,b)=>a.before-b.before);let epoch=a.navigation.inputEpoch;for(const block of blocks){assert.equal(block.before,epoch);assert.equal(block.after,++epoch);}assert.equal(r.pausedInputEpoch,epoch);assert.equal(e.actions[1].action.kind,'fill');assert(/<textarea[^>]*>自动续行正文<\/textarea>/.test(sample.html));}
      else{if(blank){assert.equal(a.status,'unknown');assert.equal(a.discoveredTarget,undefined);}assert.equal(e.phase,'paused');assert.equal(e.pauseReason,'page-change');assert.equal(e.actions.length,1);assert.equal(a.formNavigationResolution,undefined);assert(/<textarea[^>]*><\/textarea>/.test(sample.html));}
    });
  }
  detail.plans=website.receipts.filter(r=>r.kind==='form-planning').length;assert.equal(detail.plans,blank?4:chain?7:6);
  await client.quit();assert.deepEqual(remainingOwned(),[]);const cold=await launch();
  for(const sample of detail.cases){sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);check(sample.item+' 冷开不重发',()=>{assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);assert.equal(sample.cold.execution.phase,sample.result.execution.phase);});}
  assert.equal(website.receipts.filter(r=>r.kind==='form-planning').length,detail.plans);assert.equal(website.receipts.filter(r=>r.kind==='form-created').length,blank?2:chain?3:2);assert.equal(website.receipts.filter(r=>r.kind==='form-filled').length,blank?1:2);
  await cold.quit();
}
