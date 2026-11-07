import './rich-text-lines-validation.mjs';
import {fixture} from './workspace-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('段落原样保留，每个输入事件独立收件并有有限上限',async()=>{
 const site=await fixture({richLines:true});
 try{
  const html=await fetch(site.base+'/rich-edit?item=A').then(r=>r.text());assert(html.includes('<p><br></p>'));assert(html.includes('white-space:pre-wrap'));
  const old=await fetch(site.base+'/rich-edit?item=C').then(r=>r.text());assert(old.includes('<p>原有段落</p><p>原有正文</p>'));
  for(let i=0;i<65;i++){
   const response=await fetch(site.base+'/rich-input?item=A',{method:'POST',body:JSON.stringify({sent:'行'+i,actual:'行'+i,html:'<p>行'+i+'</p>'})});assert.equal(response.status,i<64?200:429);
  }
  assert.equal(site.receipts.length,64);assert.equal(site.receipts.at(-1).actual,'行63');
 }finally{await site.close();}
});
