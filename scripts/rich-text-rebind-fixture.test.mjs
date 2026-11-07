import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './workspace-fixture.mjs';
test('富文本复用夹具仅给新字段值，主文档改当前地址而不复制旧节点', async()=>{
  const site=await fixture({richPublication:true,richRebind:true});
  try {
    const target=site.base+'/rt-edit?item=D', old=site.base+'/rt-edit?item=A';
    const candidate={taskId:'task',version:'version',sha256:'hash',applicability:{entryUrl:old},fields:[{id:'title',name:'发布标题',value:'旧标题'},{id:'body',name:'文章正文',value:'旧正文',frameUrl:old,richText:{richTextNodeId:99,path:'old',frameUrl:old}}]};
    const response=await fetch(site.base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{content:'附件编辑'},{content:JSON.stringify({goal:`使用“/tmp/f.bin”在 ${target} 发布“新标题\n\n新正文”到“通知”`,workflows:[candidate]})}]})});
    assert.equal(response.status,200);const step=JSON.parse(JSON.parse((await response.text()).split('\n')[0].slice(6)).choices[0].delta.content);
    assert.equal(step.decision,'reuse');assert.equal(step.workflow.fields[1].frameUrl,target);assert.equal(step.workflow.fields[1].value,'新正文');assert.equal(step.workflow.fields[1].richText,undefined);
    for(const item of ['A','D','G','B','E','H','C','F','I']) assert.equal((await fetch(site.base+'/rt-edit?item='+item)).status,200);
  }finally{await site.close();}
});
