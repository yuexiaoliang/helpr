import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture } from './workspace-fixture.mjs';

test('整链夹具按委托分别绑定入口、正文和栏目', async () => {
  const site = await fixture({ releaseP1: 'business' });
  try {
    const entry = site.base + '/p1/posts?item=F';
    const editor = site.base + '/p1/post/' + randomUUID() + '/edit';
    const file = '/tmp/固定版本.xlsx';
    const content = '标题\n\n第一行\n第二行';
    const locator = {
      richTextNodeId: 23,
      frameUrl: editor,
      path: 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)',
    };
    const plan = {
      goal: `使用“${file}”在 ${entry} 发布“${content}”到“通知”`,
      controls: [{ frameUrl: editor, richText: { locator } }],
      materials: [{ id: randomUUID() }],
      preparation: [
        { kind: 'target', url: editor },
        { kind: 'upload', url: site.base + '/p1/file/saved' },
      ],
      workflows: [],
    };
    const response = await fetch(site.base + '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { content: `页面观察：\n${editor}\n编辑文章\n附件已关联` },
          { content: JSON.stringify(plan) },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const event = (await response.text()).split('\n')[0];
    const step = JSON.parse(
      JSON.parse(event.slice(6)).choices[0].delta.content,
    );
    assert.equal(step.decision, 'review');
    assert.equal(step.publication.content, content);
    assert.equal(step.publication.destination, '通知');
    assert.deepEqual(
      step.publication.fields.map((field) => field.value),
      ['标题', '第一行\n第二行'],
    );
  } finally {
    await site.close();
  }
});
