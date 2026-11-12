// 本机普通链接；产品从AX观察取得href，夹具不提供导航许可或恢复答案。
export function linkNavigationFixture(receipts) {
  let redirectHits = 0;
  return (req, res, url) => {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const input = JSON.parse(body);
        const observed = input.messages.at(-2).content;
        const arrived = observed.includes('LINK-ARRIVED-42');
        const role = observed.includes('重定向清单') ? 'navigation' : 'main';
        const { scopedLinks = [] } = JSON.parse(input.messages.at(-1).content);
        const within = scopedLinks
          .filter(link => link.name === '打开条目')
          .flatMap(link => link.landmarks)
          .find(scope => scope.role === role);
        receipts.push({ kind: 'link-planning', arrived, region: within?.role });
        const proposal = arrived
          ? { decision: 'complete', summary: '已核对条目', evidence: ['LINK-ARRIVED-42'], previous: null, action: null }
          : { decision: 'act', summary: '打开条目', evidence: ['打开条目'], previous: null, effect: 'interaction', action: { kind: 'click', target: { role: 'link', name: '打开条目', ...(within ? { within } : {}) } } };
        const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'link', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(chunk({ content: JSON.stringify(proposal) }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      });
      return true;
    }
    if (url.pathname === '/link-redirect-start') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>重定向清单</title><main><a href="/link-wrong-region">打开条目</a></main><nav aria-label="侧栏"><a href="/link-roundtrip">打开条目</a></nav>');
      return true;
    }
    if (url.pathname === '/link-roundtrip' && redirectHits++ === 0) {
      receipts.push({ kind: 'link-redirect', path: url.pathname });
      res.writeHead(302, { Location: '/link-middle' }); res.end(); return true;
    }
    if (url.pathname === '/link-middle') {
      receipts.push({ kind: 'link-redirect', path: url.pathname });
      res.writeHead(302, { Location: '/link-roundtrip' }); res.end(); return true;
    }
    if (url.pathname === '/link-roundtrip') {
      receipts.push({ kind: 'link-redirect-arrival' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>重定向结果</title><p>LINK-REDIRECT-ARRIVED</p>'); return true;
    }
    if (url.pathname === '/link-start') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>链接清单</title><nav aria-label="侧栏"><a href="/link-wrong-region">打开条目</a></nav><main><a href="/link-item/42">打开条目</a></main>');
      return true;
    }
    if (url.pathname === '/link-wrong-region') {
      receipts.push({ kind: 'link-wrong-region' });
      res.writeHead(400).end('WRONG-REGION');
      return true;
    }
    if (url.pathname === '/link-item/42') {
      receipts.push({ kind: 'link-arrival' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>条目42</title><p>LINK-ARRIVED-42</p>');
      return true;
    }
    return false;
  };
}
