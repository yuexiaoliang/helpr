import {richTextReadiness} from './rich-text-lines-validation.mjs';
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

test('frame夹具使用独立同站URL，BODY内无脚本，替换和外层焦点反例保留',async()=>{
 const site=await fixture({richLines:true,richFrame:true});
 try{
  const html=await fetch(site.base+'/rich-edit?item=C').then(r=>r.text());assert(html.includes('<iframe'));assert(html.includes('/rich-frame?item=C'));
  const child=await fetch(site.base+'/rich-frame?item=C').then(r=>r.text());assert(child.includes('<body role="textbox"'));assert(!child.slice(child.indexOf('<body')).includes('<script'));assert(child.includes('<p>原有段落</p><p>原有正文</p>'));
  const replace=await fetch(site.base+'/rich-frame?item=R').then(r=>r.text());assert(replace.includes('owner.replaceWith(owner.cloneNode(true))'));
  const focus=await fetch(site.base+'/rich-frame?item=F').then(r=>r.text());assert(focus.includes("parent.document.querySelector('input').focus()"));
 }finally{await site.close();}
});

test('inline夹具保留blank初始生成、srcdoc属性和实际frameUrl，不用输入脚本代写',async()=>{
 const site=await fixture({richLines:true,richFrame:true,richInline:true});
 try{
  const blank=await fetch(site.base+'/rich-edit?item=E').then(r=>r.text());assert(blank.includes('src="about:blank"'));assert(blank.includes('child.documentElement.innerHTML='));assert(!blank.includes('child.open()'));assert(!blank.includes('child.write('));assert(!blank.includes('srcdoc='));
  const srcdoc=await fetch(site.base+'/rich-edit?item=C').then(r=>r.text());assert(srcdoc.includes('srcdoc="'));assert(srcdoc.includes('&lt;p&gt;原有段落&lt;/p&gt;'));assert(!srcdoc.includes('child.write('));
  for(const [item,frameUrl] of [['E','about:blank'],['C','about:srcdoc']]) {
   const response=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:JSON.stringify({goal:`在 ${site.base}/rich-edit?item=${item} 将正文整体替换为文字`,controls:[{role:'textbox',name:'正文',frameUrl,richText:{},textValue:''}]})}]})});
   assert.equal(response.status,200);const text=await response.text();const first=JSON.parse(text.split('\n')[0].slice(6));const proposal=JSON.parse(first.choices[0].delta.content);assert.equal(proposal.action.target.frameUrl,frameUrl);assert(proposal.action.value.includes('\n'));
  }
 }finally{await site.close();}
});

test('执行前观察遇代次失效时记录并重取两份连续稳定样本，仍最多八次',async()=>{
 const calls=[],sample={readiness:[]};let n=0;
 const ready=richTextReadiness({request:async command=>{calls.push(command);if(++n===2)throw Error('OBSERVATION_NOT_AUTHORIZED');return {strings:['same']};}},'task',sample);
 assert.equal(await ready(),false);assert.equal(await ready(),false);assert.equal(await ready(),false);assert.equal(await ready(),true);
 assert(sample.readiness.some(x=>x?.error==='OBSERVATION_NOT_AUTHORIZED'));assert(calls.every(c=>c.kind==='observe'));
 for(let i=4;i<8;i++)await ready();await assert.rejects(ready(),/READINESS_LIMIT/);
});
test('执行前准备不吞掉其它观察错误',async()=>{
 const ready=richTextReadiness({request:async()=>{throw Error('CONTROL_DISCONNECTED');}},'task',{readiness:[]});await assert.rejects(ready(),/CONTROL_DISCONNECTED/);
});
test('无名称夹具不注入角色或名称，虚构规划原样消费观察定位',async()=>{
 const site=await fixture({richLines:true,richUnnamed:true});
 try{
  const html=await fetch(site.base+'/rich-edit?item=C').then(r=>r.text());assert(!html.includes('role="textbox"'));assert(!html.includes('aria-label="正文"'));assert(html.includes('<p>原有段落</p><p>原有正文</p>'));
  const locator={richTextNodeId:43,path:'html:nth-child(1) > body:nth-child(2) > div:nth-child(2)',frameUrl:site.base+'/rich-edit?item=C'};
  const response=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:JSON.stringify({controls:[{role:'generic',name:'',frameUrl:locator.frameUrl,richText:{locator},textValue:''}]})}]})});assert.equal(response.status,200);const first=JSON.parse((await response.text()).split('\n')[0].slice(6));assert.deepEqual(JSON.parse(first.choices[0].delta.content).action.target,locator);
 }finally{await site.close();}
});
