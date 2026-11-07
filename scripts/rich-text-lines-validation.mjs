import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {richLineValues} from './rich-text-lines-fixture.mjs';
export async function verifyRichTextLines({client,website,data,evidence,command,waitFor,check,launch,remainingOwned,mode}) {
 const detail=evidence.richTextLines={profile:data,realModelCalls:0,remoteWrites:0,mode,cases:[]};
 const state=await client.request({kind:'snapshot'});
 await client.request(command('model-save',{protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
 const frame=/^(frame|inline)-/.test(mode), success=['success','frame-success','inline-success'].includes(mode);
 const items=success?(frame?['E','C']:['E','A','C']):[{rewrite:'B',focus:'F',stop:'S','frame-focus':'F','frame-replace':'R','inline-focus':'F','inline-replace':'R'}[mode]];
 for(const item of items) {
   const expected=richLineValues[item],entry=website.base+'/rich-edit?item='+item;
   const taskId=(await client.request(command('create',{goal:`在 ${entry} 将正文整体替换为以下纯文本：${expected}`}))).taskId;
   const sample={item,taskId,entry,readiness:[]};detail.cases.push(sample);
   const get=async(active=client)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===taskId);
   await waitFor(async()=>(await get())?.phase==='manual',15000);
   await waitFor(richTextReadiness(client,taskId,sample),15000);
   const frameArgs=async()=>{if(!frame)return {};const tree=await client.request({kind:'observe',taskId,method:'Page.getFrameTree'});sample.frameTreeBefore??=tree;sample.frameTree=tree;return {frameId:tree.frameTree.childFrames[0].frame.id};};
   sample.axBefore=await client.request({kind:'observe',taskId,method:'Accessibility.getFullAXTree',...await frameArgs()});
   let stopping;
   if(mode==='stop')stopping=(async()=>{const deadline=Date.now()+15000;while(!website.receipts.some(r=>r.kind==='rich-input'&&r.item===item)){assert(Date.now()<deadline,'STOP_FIRST_INPUT_TIMEOUT');await new Promise(r=>setTimeout(r,5));}sample.stopRequestedAt=Date.now();await client.request(command('execution-intent',{taskId,intent:'stop'}));sample.stopped=await get();sample.stopReturnedAt=Date.now();sample.receiptsAtStop=website.receipts.filter(r=>r.kind==='rich-input'&&r.item===item).length;})();
   await client.request(command('execution-intent',{taskId,intent:'start'}));
   if(stopping)await stopping;
   await waitFor(async()=>{const t=await get();sample.last=t;if(success&&t?.execution?.phase==='paused')throw Error('RICH_LINES_INTERRUPTED:'+t.execution.pauseReason);return success?t?.execution?.phase==='complete':mode==='stop'?t?.execution?.intent==='stopped':t?.execution?.phase==='paused';},40000);
   if(!success)await new Promise(r=>setTimeout(r,1500));
   sample.result=await get();sample.domAfter=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});sample.axAfter=await client.request({kind:'observe',taskId,method:'Accessibility.getFullAXTree',...await frameArgs()});
   sample.html=await fetch(frame?entry.replace('/rich-edit','/rich-frame'):entry,{signal:AbortSignal.timeout(5000)}).then(r=>r.text());
   check(item+' 逐段输入与结果核对',()=>{
     const e=sample.result.execution;assert.equal(e.actions.length,1);const a=e.actions[0];assert(a.richTextSource);assert.equal(a.action.value,expected);
     const input=website.receipts.filter(r=>r.kind==='rich-input'&&r.item===item);assert(input.length>0);
     if(success){
       const lines=expected.split('\n');assert.equal(input.length,lines.length*2-1);
       for(let i=0;i<lines.length;i++){assert.equal(input[i*2].actual,lines.slice(0,i+1).join('\n'));assert.equal(input[i*2].active,'正文');}
       assert.equal(e.phase,'complete');assert.equal(a.status,'confirmed');assert.equal(a.richTextResult.textValue,expected);assert.equal(input.at(-1).actual,expected);assert(input.at(-1).html.includes('&lt;'));
       assert.equal(a.richTextSource.textValue,item==='E'?'':item==='A'?'\n':'原有段落\n\n原有正文');
     } else {
       assert.equal(a.status,'unknown');assert.equal(a.richTextResult,undefined);
       if(mode==='rewrite'){assert.equal(input.length,1);assert.equal(input[0].actual,'网站改写正文');}
       if(mode==='focus'||mode==='frame-focus'||mode==='inline-focus'){assert.equal(input.length,1);assert.equal(input[0].actual,expected.split('\n')[0]);assert.equal(input[0].active,frame?'外层字段':'其它字段');}
       if(mode==='frame-replace'||mode==='inline-replace'){assert.equal(input.length,1);assert.equal(input[0].actual,expected.split('\n')[0]);}
       if(mode==='stop'){assert.equal(e.intent,'stopped');assert.equal(input.length,sample.receiptsAtStop);assert.notEqual(input.at(-1).actual,expected);}
     }
   });
 }
 detail.plans=website.receipts.filter(r=>r.kind==='rich-planning').length;assert.equal(detail.plans,success?items.length*2:1);
 detail.inputs=website.receipts.filter(r=>r.kind==='rich-input').length;
 await client.quit();assert.deepEqual(remainingOwned(),[]);const cold=await launch();
 for(const sample of detail.cases){sample.cold=await waitFor(async()=>{const t=(await cold.request({kind:'snapshot'})).tasks.find(t=>t.id===sample.taskId);return t?.phase==='manual'&&t;},15000);check(sample.item+' 冷开不重填',()=>{assert.deepEqual(sample.cold.execution.actions,sample.result.execution.actions);assert.equal(sample.cold.execution.phase,sample.result.execution.phase);});}
 assert.equal(website.receipts.filter(r=>r.kind==='rich-planning').length,detail.plans);assert.equal(website.receipts.filter(r=>r.kind==='rich-input').length,detail.inputs);await cold.quit();
}

export function richTextReadiness(client,taskId,sample) {
 let previous,attempts=0;
 return async()=>{
  assert(++attempts<=8,'READINESS_LIMIT');
  try {sample.domBefore=await client.request({kind:'observe',taskId,method:'DOMSnapshot.captureSnapshot'});}
  catch(error){sample.readiness.push({error:error.message});previous=undefined;if(['PAGE_NOT_AVAILABLE','OBSERVATION_NOT_AUTHORIZED','STALE_OBSERVATION'].includes(error.message))return false;throw error;}
  const hash=createHash('sha256').update(JSON.stringify(sample.domBefore.strings)).digest('hex');
  sample.readiness.push(hash);const stable=previous===hash;previous=hash;return stable;
 };
}
