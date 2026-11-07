import './form-navigation-validation.mjs';
import {fixture} from './workspace-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('空白夹具：身份来自源页只读字段，POST之后生成编辑地址；错配页不会冒用源身份',async()=>{
 const site=await fixture({blankCreation:true});
 try{
  for(const item of ['A','B']){
   const entry=site.base+'/form-new?item='+item, html=await fetch(entry).then(r=>r.text());
   const identity=html.match(/readonly value="([^"]+)"/)[1]; assert(html.includes('<textarea name="body"></textarea>'));assert(!html.includes('/form-post/'));
   const response=await fetch(entry,{method:'POST',body:'body='}),after=await response.text();
   assert(response.url.startsWith(site.base+'/form-post/'));assert.equal(after.includes(identity),item==='A');
   assert(after.includes('/form-new?item='+item));assert(after.includes('<textarea name="body"></textarea>'));
   const plan={controls:[{name:'创建编号',readOnly:true,textValue:identity},{name:'正文',readOnly:false,textValue:''}],previous:null};
   const result=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:'页面观察 公告'},{content:JSON.stringify(plan)}]})}).then(r=>r.text());
   assert(result.includes('readonly-identity-editor-v1'));assert(result.includes(identity));
   const duplicate=await fetch(entry,{method:'POST',body:'body='});assert.equal(duplicate.status,429);
  }
  assert.equal(site.receipts.filter(r=>r.kind==='form-created').length,2);
  assert.equal(site.receipts.filter(r=>r.kind==='form-filled').length,0);
 }finally{await site.close();}
});
