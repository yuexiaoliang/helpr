import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './workspace-fixture.mjs';
test('链接夹具仅提供普通href与页面文本，只有看到到达文本才提议完成', async () => {
  const site = await fixture({ linkNavigation: true });
  try {
    const start = await fetch(site.base + '/link-start').then(r => r.text());
    assert(start.includes('href="/link-item/42"'));
    assert(!start.includes('LINK-ARRIVED-42'));
    const propose = async text => fetch(site.base + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '页面观察：\n' + text }, { role: 'user', content: JSON.stringify({ previous: null, history: [], links: [] }) }] }) }).then(r => r.text());
    const first = await propose('打开条目');
    assert(first.includes('\\"role\\":\\"link\\"'));
    assert(!first.includes('anchorClick'));
    const page = await fetch(site.base + '/link-item/42').then(r => r.text());
    assert(page.includes('LINK-ARRIVED-42'));
    const second = await propose(page);
    assert(second.includes('\\"decision\\":\\"complete\\"'));
    assert.equal(site.receipts.filter(r => r.kind === 'link-planning').length, 2);
    const redirectStart = await fetch(site.base + '/link-redirect-start').then(r => r.text());
    assert(redirectStart.includes('href="/link-roundtrip"'));
    const redirected = await fetch(site.base + '/link-roundtrip');
    assert.equal(redirected.url, site.base + '/link-roundtrip');
    assert((await redirected.text()).includes('LINK-REDIRECT-ARRIVED'));
    assert.equal(site.receipts.filter(r => r.kind === 'link-redirect').length, 2);
  } finally { await site.close(); }
});
