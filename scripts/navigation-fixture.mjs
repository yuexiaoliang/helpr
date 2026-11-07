// 只有测试网站知道结果编号；产品只收到普通网页和一个通用点击提议。
export function navigationFixture(receipts) {
  let writes = 0;
  return (req, res, url) => {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const input = JSON.parse(body);
        const plan = JSON.parse(input.messages.at(-1).content);
        receipts.push({ kind: 'navigation-planning', pending: plan.previous?.id ?? null });
        const proposal = { decision: 'act', summary: '打开新建条目', evidence: ['新建条目'], previous: null,
          effect: 'interaction', action: { kind: 'click', target: { role: 'button', name: '新建条目' } } };
        const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'navigation', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(chunk({ content: JSON.stringify(proposal) }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      });
      return true;
    }
    if (url.pathname === '/navigation-start') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>条目清单</title><form method="post" action="/navigation-create"><button>新建条目</button></form>');
      return true;
    }
    if (url.pathname === '/navigation-create' && req.method === 'POST') {
      writes++;
      receipts.push({ kind: 'navigation-created', id: writes });
      res.writeHead(303, { Location: '/navigation-result/' + writes });
      res.end();
      return true;
    }
    if (url.pathname.startsWith('/navigation-result/')) {
      receipts.push({ kind: 'navigation-result-read', path: url.pathname });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>新条目</title><p>条目已创建</p>');
      return true;
    }
    return false;
  };
}
