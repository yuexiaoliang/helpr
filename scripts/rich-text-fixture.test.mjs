import './rich-text-validation.mjs';
import {fixture} from './workspace-fixture.mjs';
import {richTextValue} from './rich-text-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('富文本夹具保留独立收件，替代模型在反例仍声称成功；重复输入拒绝',async()=>{
 const site=await fixture({richText:true});
 try{
  for(const item of ['A','B']){
   const html=await fetch(site.base+'/rich-edit?item='+item).then(r=>r.text());assert(html.includes('contenteditable="true"'));assert(html.includes('role="textbox"'));
   const response=await fetch(site.base+'/rich-input?item='+item,{method:'POST',body:JSON.stringify({sent:richTextValue,actual:item==='A'?richTextValue:'网站改写正文',html:'&lt;标题&gt;'})});assert.equal(response.status,200);
   const duplicate=await fetch(site.base+'/rich-input?item='+item,{method:'POST',body:'{}'});assert.equal(duplicate.status,429);
   const result=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:'页面'},{content:JSON.stringify({previous:{id:'fill'},controls:[{role:'textbox',name:'正文',richText:{rule:'contenteditable-ax-v1'},textValue:'网站改写正文'}]})}]})}).then(r=>r.text());assert(result.includes('confirmed'));assert(result.includes('complete'));
  }
  assert.equal(site.receipts.filter(r=>r.kind==='rich-input').length,2);
 }finally{await site.close();}
});
