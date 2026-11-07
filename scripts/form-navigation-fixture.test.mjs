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
test('请求链夹具：C仅首次最终GET触发额外同URL脚本导航，后续页面完整',async()=>{
 const site=await fixture({formNavigation:true,formChain:true});
 try{
  const page=await fetch(site.base+'/form-new?item=C').then(r=>r.text());const route=page.match(/action="([^"]+)"/)[1];
  const response=await fetch(site.base+route,{method:'POST',body:'title=独立草稿C'});const html=await response.text();
  assert.equal(response.url,site.base+route);assert(html.includes('location.replace(location.href)'));
  const after=await fetch(site.base+route).then(r=>r.text());assert(!after.includes('location.replace'));assert(after.includes('当前草稿'));
  assert.equal(site.receipts.filter(r=>r.kind==='form-created').length,1);
 }finally{await site.close();}
});
test('请求链夹具：B向当前地址POST后才生成新的编辑URL，303/302后保持来源链接',async()=>{
 const site=await fixture({formNavigation:true,formChain:true});
 try{
  const entry='/form-new?item=B',page=await fetch(site.base+entry).then(r=>r.text());assert.equal(page.match(/action="([^"]+)"/)[1],entry);
  const response=await fetch(site.base+entry,{method:'POST',body:'title=独立草稿B'}),html=await response.text();
  assert(response.url.startsWith(site.base+'/form-post/'));assert(html.includes('href="'+entry+'"'));
  assert.equal(site.receipts.filter(r=>r.kind==='form-redirect').length,2);
  assert.equal(site.receipts.find(r=>r.kind==='form-created').request,entry);
 }finally{await site.close();}
});
