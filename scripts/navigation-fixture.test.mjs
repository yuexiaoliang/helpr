import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';

test('导航夹具由真实POST产生编号，303结果独立读取且不会重复写入', async () => {
  const site = await fixture({ navigation: true });
  try {
    const start = await fetch(site.base + '/navigation-start').then(r => r.text());
    assert(start.includes('method="post"'));
    assert.equal(site.receipts.filter(r => r.kind === 'navigation-created').length, 0);
    const response = await fetch(site.base + '/navigation-create', { method: 'POST', redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/navigation-result/1');
    for (let i = 0; i < 2; i++) {
      const text = await fetch(site.base + '/navigation-result/1').then(r => r.text());
      assert(text.includes('条目已创建'));
    }
    assert.equal(site.receipts.filter(r => r.kind === 'navigation-created').length, 1);
    const model = await fetch(site.base + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ content: '{}' }] }) }).then(r => r.text());
    assert(model.includes('新建条目'));
    assert(!model.includes('navigation-result'));
  } finally { await site.close(); }
});
