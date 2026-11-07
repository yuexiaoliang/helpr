import './created-target-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';
test('草稿夹具先POST后随机身份，虚构模型仅冻结真实观察字段',async()=>{
  const site=await fixture({createdTarget:true});
  try{
    const page=await fetch(site.base+'/new-draft?item=A').then(r=>r.text());assert(!page.includes('/created/'));
    const response=await fetch(site.base+'/create-draft?item=A',{method:'POST',body:'title=Draft-A',redirect:'manual'});assert.equal(response.status,303);
    const location=response.headers.get('location'),html=await fetch(site.base+location).then(r=>r.text());assert(html.includes('value="Draft-A"'));assert(html.includes('href="'+location+'"'));
    const result=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:'页面观察：公告'},{content:JSON.stringify({controls:[{name:'草稿标题',textValue:'Draft-A'}]})}]})}).then(r=>r.text());
    assert(result.includes('same-site-editor-v1'));assert(!result.includes(location));assert.equal(site.receipts.filter(r=>r.kind==='target-created').length,1);
    const duplicate=await fetch(site.base+'/create-draft?item=A',{method:'POST',body:'title=Duplicate',redirect:'manual'});assert.equal(duplicate.status,429);assert.equal(site.receipts.filter(r=>r.kind==='target-created').length,1);
  }finally{await site.close();}
});
