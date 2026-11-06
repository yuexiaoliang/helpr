import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyAgreements({client, website, data, evidence, command, waitFor, check, launch, remainingOwned, confirmNavigation=false}) {
  let active=client;
  evidence.agreements={cases:[],realModelCalls:0,remoteWrites:0,acceptance:confirmNavigation?'scripted-navigation-confirmed':'scripted-public-entry',navigationConfirmations:[]};
  const dir=path.join(data,'reports');fs.mkdirSync(dir);
  const file=path.join(dir,'daily.xlsx');
  const original=fs.readFileSync('tests/workspace/fixtures/excel/report-a.xlsx');fs.writeFileSync(file,original);
  await active.request(command('model-save',{protocol:'chat-completions',expectedVersion:0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  const owner=(await active.request(command('create',{goal:'在 '+website.base+'/new 整理以后从表格发布文章的约定'}))).taskId;
  const get=async(id=owner)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===id);
  await waitFor(async()=>(await get()).phase==='manual');
  await active.request(command('execution-intent',{taskId:owner,intent:'stop'}));
  const prepare=async destination=>{
    const text=`从“${dir}”取唯一 xlsx，在 ${website.base}/new 的“${destination}”栏目，按“逐行列出项目和数量，忽略不确定公式”自动发布，新内容另发，同内容一次`;
    await active.request(command('agreement-prepare',{taskId:owner,expectedVersion:(await get()).execution.version,text}));
    return (await get()).execution.agreements.at(-1);
  };
  let agreement=await prepare('公告');
  await assert.rejects(()=>active.request(command('agreement-use',{taskId:owner,versionId:agreement.versionId})),/AGREEMENT_EXPIRED/);
  assert.equal(website.receipts.filter(r=>r.kind==='published').length,0);
  await active.request(command('agreement-accept',{taskId:owner,versionId:agreement.versionId}));
  const use=async(extra={})=>{
    const before=(await active.request({kind:'snapshot'})).tasks.map(t=>t.id);
    await active.request(command('agreement-use',{taskId:owner,versionId:agreement.versionId,...extra}));
    const state=await active.request({kind:'snapshot'});
    return state.tasks.find(t=>!before.includes(t.id)).id;
  };
  const done=async(id)=>waitFor(async()=>{
    const task=await get(id),e=task.execution;
    if(e.phase==='complete')return e;
    if(confirmNavigation&&e.phase==='paused'&&e.pauseReason==='page-change'&&!evidence.agreements.navigationConfirmations.some(c=>c.taskId===id)){
      const target=new URL(task.url);
      assert.equal(target.origin,website.base);
      if(task.phase!=='manual'||target.pathname==='/new')return false;
      assert.equal(target.pathname,'/edit');
      assert(website.receipts.some(r=>r.kind==='created'&&r.item===target.searchParams.get('item')));
      assert.equal(e.actions.at(-1)?.action?.target?.name,'创建文章');
      assert(evidence.agreements.navigationConfirmations.length<4);
      evidence.agreements.navigationConfirmations.push({taskId:id,version:e.version,reason:e.pauseReason,url:task.url,operation:'explicit-continue',by:'validation-script'});
      await active.request(command('execution-intent',{taskId:id,intent:'continue',expectedVersion:e.version}));
      return false;
    }
    if(['paused','unknown','failed'].includes(e.phase))throw Error(e.summary);
    return false;
  },55000);
  const verify=async(id,expectedBytes,destination)=>{
    const e=await done(id);
    assert.equal((await active.request({kind:'snapshot'})).active,owner,'BACKGROUND_TASK_MUST_NOT_SELECT_ITSELF');
    const c=e.publicationChecks.at(-1);
    const html=await(await fetch(c.proposal.url,{signal:AbortSignal.timeout(5000)})).text();
    const bytes=Buffer.from(await(await fetch(c.proposal.attachmentUrl,{signal:AbortSignal.timeout(5000)})).arrayBuffer());
    assert.deepEqual(bytes,expectedBytes);assert(html.includes(e.publication.content));assert(html.includes(destination));
    assert.equal(e.publication.agreementVersionId,agreement.versionId);assert.equal(e.materialWorks[0].status,'complete');assert(!e.question);
    const item=new URL(c.proposal.url).searchParams.get('item');
    assert.equal(website.receipts.filter(r=>r.kind==='published'&&r.item===item).length,1);
    evidence.agreements.cases.push({taskId:id,destination,sha256:createHash('sha256').update(bytes).digest('hex'),execution:e});
    return e;
  };
  const firstId=await use(),first=await verify(firstId,original,'公告');
  check('明确接受后按约定批准内容，发布并独立核对全文与附件',()=>assert.equal(website.receipts.filter(r=>r.kind==='published').length,1));
  fs.renameSync(file,path.join(dir,'renamed.xlsx'));
  const duplicateId=await use();
  await waitFor(async()=>(await get(duplicateId)).execution.duplicateWork);
  check('同内容改名命中原完成工作，未上传或重复发布',()=>assert.equal(website.receipts.filter(r=>r.kind==='published').length,1));
  const changed=fs.readFileSync('tests/workspace/fixtures/excel/report-b.xlsx');fs.writeFileSync(path.join(dir,'renamed.xlsx'),changed);
  const changedId=await use();await verify(changedId,changed,'公告');
  const beforeRepeat=(await active.request({kind:'snapshot'})).tasks.map(t=>t.id);
  await active.request(command('message',{taskId:firstId,text:'再发一次'}));
  const repeatId=(await active.request({kind:'snapshot'})).tasks.find(t=>!beforeRepeat.includes(t.id)).id;
  assert.equal((await get(repeatId)).execution.agreementBinding.repeatOf,first.materialWorks[0].id);
  await verify(repeatId,original,'公告');
  check('同名新字节按约定另发；明确再发仍采用原固定素材',()=>assert.equal(website.receipts.filter(r=>r.kind==='published').length,3));
  const old=agreement.versionId;agreement=await prepare('通知');
  await assert.rejects(()=>active.request(command('agreement-use',{taskId:owner,versionId:old})),/AGREEMENT_EXPIRED/);
  await assert.rejects(()=>active.request(command('agreement-use',{taskId:owner,versionId:agreement.versionId})),/AGREEMENT_EXPIRED/);
  await active.request(command('agreement-accept',{taskId:owner,versionId:agreement.versionId}));
  const other=await use();await verify(other,changed,'通知');
  await active.request(command('agreement-revoke',{taskId:owner,versionId:agreement.versionId}));
  await assert.rejects(()=>active.request(command('agreement-use',{taskId:owner,versionId:agreement.versionId})),/AGREEMENT_EXPIRED/);
  check('修改栏目先撤旧版并重新接受；新目标独立完成，撤销后不再放行',()=>assert.equal(website.receipts.filter(r=>r.kind==='published').length,4));
  const before=await active.request({kind:'snapshot'});
  await active.quit();assert.equal(remainingOwned().length,0);
  active=await launch();const after=await active.request({kind:'snapshot'});
  check('冷开保留约定撤销、工作身份及完成事实，不重复发布',()=>{
    for(const t of before.tasks){const next=after.tasks.find(n=>n.id===t.id);for(const key of ['agreements','agreementBinding','materialWorks','duplicateWork','publicationChecks'])assert.deepEqual(next.execution?.[key],t.execution?.[key]);}
    assert.equal(website.receipts.filter(r=>r.kind==='published').length,4);
  });
  evidence.agreements.cold={before,after};
  const readiness=[];
  for(const t of after.tasks.filter(t=>t.url)){
    let last,attempts=0;
    await waitFor(async()=>{
      if(++attempts>8)throw Error('AGREEMENT_COLD_READINESS_LIMIT');
      let dom;
      try{dom=await active.request({kind:'observe',taskId:t.id,method:'DOMSnapshot.captureSnapshot'});}
      catch(error){readiness.push({taskId:t.id,error:error.message});if(['PAGE_NOT_AVAILABLE','OBSERVATION_NOT_AUTHORIZED','STALE_OBSERVATION'].includes(error.message))return false;throw error;}
      const hash=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      readiness.push({taskId:t.id,hash});const stable=last===hash;last=hash;return stable;
    },15000);
  }
  evidence.agreements.cold.readiness=readiness;
  await active.quit();
}
