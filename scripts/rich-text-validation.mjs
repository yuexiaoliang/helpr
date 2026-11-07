import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {richTextValue,richTextRejectedValue} from './rich-text-fixture.mjs';
export async function verifyRichText({client,website,data,evidence,command,waitFor,check,launch,remainingOwned,paragraph=false}) {
 const detail=evidence.richText={profile:data,realModelCalls:0,remoteWrites:0,scriptedContinuation:false,paragraph,cases:[]};
 const state=await client.request({kind:'snapshot'});
 await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
 for(const item of (paragraph?['A']:['A','B'])) {
   const expected=item==='B'?richTextRejectedValue:richTextValue;
   const entry=website.base+'/rich-edit?item='+item;
   const taskId=(await client.request(command('create',{goal:`在 ${entry} 将正文整体替换为以下纯文本：${expected}`}))).taskId;
   const sample={item,taskId,entry,readiness:[]};detail.cases.push(sample);
   const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
   await waitFor(async()=>(await get())?.phase==='manual',15000);
   let previous,attempts=0;
   await waitFor(async()=>{assert(++attempts<=8,'READINESS_LIMIT');sample.domBefore=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});const hash=createHash('sha256').update(JSON.stringify(sample.domBefore.strings)).digest('hex');sample.readiness.push(hash);const stable=previous===hash;previous=hash;return stable;},15000);
   sample.axBefore=await client.request({kind:'observe',taskId,method:'Accessibility.getFullAXTree'});
   await client.request(command('execution-intent',{taskId,intent:'start'}));
   await waitFor(async()=>{const t=await get();sample.last=t;if(t?.execution?.phase==='paused'&&item==='A'&&!paragraph)throw Error('RICH_TEXT_INTERRUPTED:'+t.execution.pauseReason);return item==='A'&&!paragraph?t?.execution?.phase==='complete':t?.execution?.phase==='paused';},50000);
   if(item==='B'||paragraph)await new Promise(r=>setTimeout(r,2000));
   sample.result=await get();sample.domAfter=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});sample.axAfter=await client.request({kind:'observe',taskId,method:'Accessibility.getFullAXTree'});
   sample.html=await fetch(entry,{signal:AbortSignal.timeout(5000)}).then(r=>r.text());
   check(item+' 富文本实际全文核对',()=>{
     const e=sample.result.execution;assert.equal(e.actions.length,1);const a=e.actions[0];assert(a.richTextSource);assert.equal(a.action.value,expected);
     const input=website.receipts.filter(r=>r.kind==='rich-input'&&r.item===item);assert.equal(input.length,1);assert.equal(input[0].sent,paragraph?richTextValue.replace('\n','\n\n'):expected);
     if(item==='A'&&!paragraph){assert.equal(e.phase,'complete');assert.equal(a.status,'confirmed');assert.equal(a.richTextSource.textValue,'');assert.equal(a.richTextResult.textValue,richTextValue);assert.equal(input[0].actual,richTextValue);assert(input[0].html.includes('&lt;标题&gt;'));}
     else{assert.equal(e.phase,'paused');assert.equal(a.status,'unknown');assert.equal(a.richTextResult,undefined);assert.equal(input[0].actual,paragraph?richTextValue.replace('\n','\n\n'):'网站改写正文');assert.equal(a.richTextSource.textValue.replaceAll('\n',''),paragraph?'':'原有段落原有正文');}
   });
 }
 detail.plans=website.receipts.filter(r=>r.kind==='rich-planning').length;assert.equal(detail.plans,paragraph?2:4);
 await client.quit();assert.deepEqual(remainingOwned(),[]);const cold=await launch();
 for(const sample of detail.cases){sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);check(sample.item+' 冷开不重填',()=>{assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);assert.equal(sample.cold.execution.phase,sample.result.execution.phase);});}
 assert.equal(website.receipts.filter(r=>r.kind==='rich-planning').length,paragraph?2:4);assert.equal(website.receipts.filter(r=>r.kind==='rich-input').length,paragraph?1:2);await cold.quit();
}
