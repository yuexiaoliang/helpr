import { resultReadiness } from './dynamic-result-validation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';

test('动态夹具只有POST后生成地址，真实表单与303保留正反例目标链接',async()=>{
  const site=await fixture({workflow:true,dynamicResult:true,separateFields:true});
  try{
    for(const item of ['A','B']){
      const edit=await(await fetch(site.base+'/edit?item='+item)).text();
      assert(edit.includes('<form method="post"'));
      assert(!edit.includes('永久链接'));assert(!edit.includes("querySelector('#publish').onclick"));
      const response=await fetch(site.base+'/publish?item='+item,{method:'POST',body:new URLSearchParams({heading:'标题'+item,body:'正文'+item,destination:'公告'}),redirect:'manual'});
      assert.equal(response.status,303);const result=response.headers.get('location');
      assert.match(result,/^\/dynamic\/[0-9a-f-]+\?item=/);
      const html=await(await fetch(site.base+result)).text();
      assert(html.includes('href="'+result+'"'));
      assert(html.includes('href="/edit?item='+(item==='A'?'A':'wrong')+'"'));
    }
    const input={messages:[{content:'页面观察\n'+site.base+'/edit?item=A\n附件编辑\n附件已上传\n草稿已保存\n标题已填写\n正文已填写\n栏目已填写\n[button] 发布附件'}, {content:JSON.stringify({goal:'使用“/tmp/f.bin”在 '+site.base+'/edit?item=A 发布“标题\n\n正文”到“公告”',materials:[{id:'material'}],publication:{approvalId:'approval',content:'标题\n\n正文',fields:[{value:'标题'},{value:'正文'}]}})}]};
    const result=await(await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify(input)})).text();
    assert(result.includes('publication'));assert(!result.includes('public-attachment-v1'));
  }finally{await site.close();}
});

test('管理页只在POST后给出随机结果链接，B同名不同地址，公开页保留编辑关联',async()=>{
  const site=await fixture({workflow:true,dynamicResult:true,separateFields:true,managementResult:true});
  try{
    for(const item of ['A','B']){
      const before=await(await fetch(site.base+'/edit?item='+item)).text();
      assert(!before.includes('/dynamic/'));
      const response=await fetch(site.base+'/publish?item='+item,{method:'POST',body:new URLSearchParams({heading:'标题'+item,body:'正文'+item,destination:'公告'}),redirect:'manual'});
      assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/management?item='+item);
      const html=await(await fetch(site.base+response.headers.get('location'))).text();
      const result=html.match(/href="(\/dynamic\/[^\"]+)"/)[1];
      assert.equal((html.match(new RegExp('>标题'+item+'</a>','g'))??[]).length,item==='A'?1:2);
      assert(html.includes('href="/edit?item='+item+'"'));assert(html.includes('正文'+item));
      assert(!html.includes('rel="canonical"'));
      const published=await(await fetch(site.base+result)).text();
      assert(published.includes('rel="canonical" href="'+result+'"'));
      assert(published.includes('href="/edit?item='+item+'"'));
    }
    assert.equal(site.receipts.filter(r=>r.kind==='published').length,2);
  }finally{await site.close();}
});


test('缩略管理页仅有标题候选，四份公开结果包含歧义、错误目标和错误正文反例',async()=>{
  const site=await fixture({workflow:true,dynamicResult:true,separateFields:true,managementResult:true,summaryResult:true});
  try {
    for(const item of ['A','B','C','D']) {
      const response=await fetch(site.base+'/publish?item='+item,{method:'POST',body:new URLSearchParams({heading:'标题'+item,body:'正文'+item,destination:'公告'}),redirect:'manual'});
      assert.equal(response.status,303);
      const html=await(await fetch(site.base+response.headers.get('location'))).text();
      assert(!html.includes('正文'+item)); assert(!html.includes('/file')); assert(!html.includes('/edit'));assert(!html.includes('公告'));
      assert.equal((html.match(new RegExp('>标题'+item+'</a>','g'))??[]).length,item==='B'?2:1);
      const result=html.match(/href="(\/dynamic\/[^\"]+)"/)[1];
      const published=await(await fetch(site.base+result)).text();
      assert.equal(site.receipts.filter(r=>r.kind==='public-read'&&r.item===item).length,1);
      assert.equal(published.includes('正文'+item),item!=='D');
      assert(published.includes('href="/edit?item='+(item==='C'?'wrong':item)+'"'));
    }
  } finally {await site.close();}
});


test('冷开manual后暂未挂载页面必须继续有界观察并取得两次稳定样本',async()=>{
  const sample={readiness:[]};let calls=0;
  const ready=resultReadiness({request:async()=>{if(++calls===1)throw Error('PAGE_NOT_AVAILABLE');return {strings:['完整页面']};}},'task',sample);
  assert.equal(await ready(),false);assert.equal(await ready(),false);assert.equal(await ready(),true);
  assert.equal(calls,3);assert.deepEqual(sample.readiness[0],{error:'PAGE_NOT_AVAILABLE'});
});


test('冷开观察错误清除旧稳定样本，持续不可用限八次，未知错误立即抛出',async()=>{
  let calls=0;const sample={readiness:[]};
  const ready=resultReadiness({request:async()=>{if(++calls===2)throw Error('STALE_OBSERVATION');return {strings:['页面']};}},'task',sample);
  for(const value of [false,false,false,true])assert.equal(await ready(),value);
  const unavailable=resultReadiness({request:async()=>{throw Error('PAGE_NOT_AVAILABLE');}},'task',{readiness:[]});
  for(let i=0;i<8;i++)assert.equal(await unavailable(),false);
  await assert.rejects(unavailable,/READINESS_LIMIT/);
  const other=resultReadiness({request:async()=>{throw Error('UNEXPECTED');}},'task',{readiness:[]});
  await assert.rejects(other,/UNEXPECTED/);
});
