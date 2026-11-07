import './form-navigation-validation.mjs';
import {fixture} from './workspace-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('表单夹具：A直接POST响应，B重定向回同一地址；模型只按实际字段提议剩余动作',async()=>{
  const site=await fixture({formNavigation:true});
  try{
    for(const item of ['A','B']){
      const page=await fetch(site.base+'/form-new?item='+item).then(r=>r.text());
      const route=page.match(/action="([^"]+)"/)[1];
      const r=await fetch(site.base+route,{method:'POST',body:'title=独立草稿'+item,redirect:'manual'});
      assert.equal(r.status,item==='A'?200:303);
      if(item==='A')assert((await r.text()).includes('href="'+route+'"'));
      else {const middle=await fetch(site.base+r.headers.get('location'),{redirect:'manual'});assert.equal(middle.status,302);assert.equal(middle.headers.get('location'),route);}
    }
    const plan={controls:[{name:'草稿标题',textValue:'独立草稿A'},{name:'正文',textValue:''}],previous:null};
    const result=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:'页面观察 公告 已创建草稿'},{content:JSON.stringify(plan)}]})}).then(r=>r.text());
    assert(result.includes('自动续行正文'));assert(result.includes('fill'));assert(!result.includes('targetCreation'));
    assert.equal(site.receipts.filter(r=>r.kind==='form-created').length,2);
  }finally{await site.close();}
});
