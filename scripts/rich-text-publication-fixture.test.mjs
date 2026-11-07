import { publicationReview, richPublicationItems } from './rich-text-publication-validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';
const plan = async (site, value) => {
  const response = await fetch(site.base + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ content: '附件编辑 附件已上传 草稿已保存' }, { content: JSON.stringify(value) }] }) });
  assert.equal(response.status, 200);
  return JSON.parse(JSON.parse((await response.text()).split('\n')[0].slice(6)).choices[0].delta.content);
};
test('发布预览复制实际观察locator，完整字段和显式内联frame不造假名称', async () => {
  const site = await fixture({ richPublication: true });
  try {
    const target = site.base + '/rt-edit?item=B', locator = { richTextNodeId: 42, path: 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)', frameUrl: 'about:blank' };
    const value = { goal: `使用“/tmp/input.bin”在 ${target} 发布“标题\n\n第一行\n第二行”到“通知”`, materials: [{ id: 'material' }], controls: [{ role: 'generic', name: '', frameUrl: 'about:blank', textValue: '', richText: { locator } }] };
    const review = await plan(site, value); assert.equal(review.decision, 'review'); assert.deepEqual(review.publication.fields[1], { id: 'body', name: '文章正文', value: '第一行\n第二行', frameUrl: 'about:blank', richText: locator });
    const action = await plan(site, { ...value, publication: { ...review.publication, approvalId: 'approved' }, controls: [...value.controls, { role: 'textbox', name: '发布标题', textValue: '标题' }] }); assert.deepEqual(action.action.target, locator); assert.equal(action.action.value, '第一行\n第二行');
    for (const item of ['A', 'B', 'C']) { const html = await fetch(site.base + '/rt-edit?item=' + item).then(r => r.text()); assert(!html.includes('role="textbox"')); assert(!html.includes('aria-label="文章正文"')); assert(!html.includes('child.write(')); }
  } finally { await site.close(); }
});
test('独立网站保留精确实际收件、附件字节、公开结果并拒绝重复发布', async () => {
  const site = await fixture({ richPublication: true });
  try {
    const bytes = Buffer.from([0, 255, 128]), body = '首行 <中文> & 文本\n次行';
    const post = (route, value) => fetch(site.base + route + '?item=A', { method: 'POST', body: value });
    await post('/rt-upload', bytes); await post('/rt-input', JSON.stringify({ value: body, html: 'untrusted', inputType: 'insertText' }));
    assert.equal((await post('/rt-publish', JSON.stringify({ heading: '标题', body, destination: '通知' }))).status, 200);
    const html = await fetch(site.base + '/rt-result?item=A').then(r => r.text()); assert(html.includes('首行 &lt;中文&gt; &amp; 文本\n次行')); assert(html.includes('/rt-edit?item=A'));
    assert.deepEqual(Buffer.from(await (await fetch(site.base + '/rt-file?item=A')).arrayBuffer()), bytes);
    assert.equal((await post('/rt-publish', '{}')).status, 409); assert.equal(site.receipts.filter(r => r.kind === 'rt-published').length, 1);
  } finally { await site.close(); }
});
test('节点和页面替换只在明确准备后发生且只触发一次', async () => {
  const site = await fixture({ richPublication: true });
  try {
    for (const item of ['N', 'P']) {
      const query = '?item=' + item; assert.equal(await fetch(site.base + '/rt-poll' + query).then(r => r.text()), '');
      assert.equal((await fetch(site.base + '/rt-arm' + query, { method: 'POST' })).status, 200);
      assert.equal(await fetch(site.base + '/rt-poll' + query).then(r => r.text()), item);
      assert.equal(await fetch(site.base + '/rt-poll' + query).then(r => r.text()), '');
      assert.equal((await fetch(site.base + '/rt-arm' + query, { method: 'POST' })).status, 409);
    }
  } finally { await site.close(); }
});

test('实际预览以paused等待参与，先识别review且其它暂停仍报错', () => {
  const e = { phase: 'paused', question: { type: 'review' }, summary: '请确认本次发布的目标和内容。' };
  assert.equal(publicationReview(e), e);
  assert.throws(() => publicationReview({ phase: 'paused', summary: '现场失效' }), /REVIEW_INTERRUPTED/);
});

test('虚构模型显式返回用量，不能累计未知预留到第五次规划预算耗尽', async () => {
  const site = await fixture({ richPublication: true });
  try {
    const response = await fetch(site.base + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ content: '附件编辑' }, { content: JSON.stringify({ goal: `使用“/tmp/input.bin”在 ${site.base}/rt-edit?item=A 发布“标题\n\n正文”到“通知”` }) }] }) });
    const chunks = (await response.text()).split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 });
  } finally { await site.close(); }
});

test('暂停后的同站反例分开资料轮，保留独占守卫', () => {
  assert.deepEqual(richPublicationItems('node-replace'), ['N']);
  assert.deepEqual(richPublicationItems('page-replace'), ['P']);
});
