import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function fixture() {
  const receipts = [];
  const login = 'fixture-' + randomUUID();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const task = url.searchParams.get('task') || 'A';
    if (url.pathname === '/probe') {
      let body = '';
      req.on('data', (part) => {
        body += part;
      });
      req.on('end', () => {
        receipts.push({ kind: 'probe', task, ...JSON.parse(body) });
        res.end('ok');
      });
      return;
    }
    if (url.pathname === '/login') {
      receipts.push({ kind: 'login', task });
      res.writeHead(302, {
        'Set-Cookie': `helpr_fixture=${login}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax`,
        Location: '/page?task=' + task,
      });
      res.end();
      return;
    }
    if (url.pathname === '/page') {
      const authenticated = (req.headers.cookie || '').includes(
        `helpr_fixture=${login}`,
      );
      receipts.push({ kind: 'page', task, authenticated });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>任务 ${task} 的网站</title><style>body{font:16px -apple-system;background:${task === 'A' ? '#f5f8fc' : '#f5faf6'};color:#244135;padding:40px}h1{font-size:28px}input,textarea{padding:12px;border:1px solid #c6d8cc;border-radius:8px;font:inherit}textarea{display:block;width:440px;height:160px;margin-top:18px}a{display:inline-block;padding:12px;background:#1b7956;color:white;border-radius:8px}p{line-height:1.9}</style><h1>任务 ${task} 网站</h1><p>这是本机虚构网站，用于检查真实页面、会话和输入隔离。</p><p id="session">${authenticated ? '虚构会话仍有效' : '尚未登录虚构账号'}</p><a href="/login?task=${task}">登录虚构账号</a><p><label>网页输入 <input aria-label="网页输入" placeholder="仅属于任务 ${task}"></label></p><textarea aria-label="网站草稿" placeholder="网站未保存的编辑"></textarea><script>fetch('/probe?task=${task}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node:typeof process,require:typeof require,bridge:typeof window.workspace})})</script></html>`,
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    receipts,
    login,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
