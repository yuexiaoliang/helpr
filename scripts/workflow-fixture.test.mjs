import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { workflowFixture } from './workflow-fixture.mjs';
import { Script } from 'node:vm';

test('替代模型从发布语义识别按钮，文件选择按钮排在末尾也不被当作发布', () => {
  for (const name of ['发布附件', '确认送出']) {
    const req = Object.assign(new EventEmitter(), {headers:{host:'127.0.0.1:1234'}, method:'POST'});
    let response;
    const res = {writeHead: status => assert.equal(status, 200), end: value => {response=value;}};
    const handler = workflowFixture([]);
    handler(req, res, new URL('http://localhost/v1/chat/completions'));
    req.emit('data', JSON.stringify({messages:[
      {content:`附件编辑 附件已上传 草稿已保存 标题已填写 栏目已填写\n[button] 保存草稿\n[button] ${name}\n[button] 附件：A-修复素材.bin`},
      {content:JSON.stringify({goal:'使用“/tmp/fixture.bin”在 http://127.0.0.1:1234/edit?item=A 发布“全文”到“公告”', materials:[{id:'material'}], publication:{content:'全文',approvalId:'approval'}})},
    ]}));
    req.emit('end');
    const delta = JSON.parse(response.split('\n')[0].slice(6));
    const proposal = JSON.parse(delta.choices[0].delta.content);
    assert.equal(proposal.action.target.name, name);
    assert.equal(proposal.effect, 'publication');
  }
});

test('多字段夹具保留换行、生成独立输入及合法页面脚本，不把合并全文塞入标题', () => {
  const handler = workflowFixture([], {separateFields:true});
  let html;
  handler({headers:{host:'127.0.0.1:1234'},method:'GET'}, {setHeader(){},end(value){html=value;}}, new URL('http://localhost/edit?item=A'));
  assert(html.includes('<textarea id="body">'));
  new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  for(const reuse of [false,true]) {
    const req=Object.assign(new EventEmitter(),{headers:{host:'127.0.0.1:1234'},method:'POST'});
    let response;
    handler(req,{writeHead(status){assert.equal(status,200);},end(value){response=value;}},new URL('http://localhost/v1/chat/completions'));
    req.emit('data',JSON.stringify({messages:[{content:'附件编辑 附件已上传 草稿已保存\n[button] 保存草稿\n[button] 发布附件'},{content:JSON.stringify({goal:'使用“/tmp/fields.bin”在 http://127.0.0.1:1234/edit?item=A 发布“本次标题\n\n独立正文”到“公告”',materials:[{id:'material'}],...(reuse?{workflows:[{taskId:'old',version:'version',sha256:'hash'}]}:{})})}]}));
    req.emit('end');
    const step=JSON.parse(JSON.parse(response.split('\n')[0].slice(6)).choices[0].delta.content);
    const proposal=reuse?step.workflow:step.publication;
    assert.deepEqual(proposal.fields.map(f=>f.value),['本次标题','独立正文']);
    assert.equal(proposal.content,'本次标题\n\n独立正文');
  }
});
