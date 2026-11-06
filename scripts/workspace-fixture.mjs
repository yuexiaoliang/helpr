import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { materialFixture } from './material-fixture.mjs';
import { workflowFixture } from './workflow-fixture.mjs';

export async function fixture({ participation = false, review = false, material, workflow = false } = {}) {
  const receipts = [];
  const handleMaterial = material ? materialFixture(material, receipts) : null;
  const handleWorkflow = workflow ? workflowFixture(receipts) : null;
  const login = 'fixture-' + randomUUID();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (handleWorkflow?.(req, res, url)) return;
    if (handleMaterial?.(req, res, url)) return;
    const task = url.searchParams.get('task') || 'A';
    if (
      (participation || review) &&
      url.pathname === '/v1/chat/completions' &&
      req.method === 'POST'
    ) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const plan = JSON.parse(payload.messages.at(-1).content);
          const answer = plan.clarifications?.at(-1)?.answer;
          const decision = answer ? 'complete' : 'ask';
          const summary = answer
            ? '已核对网页提示。'
            : '要核对网页上的哪条提示？';
          let proposal = {
            decision,
            summary,
            evidence: [answer || '网页输入'],
            previous: null,
            action: null,
          };
          if (review) {
            const p = plan.publication;
            const signedIn = receipts.some(
              (r) => r.kind === 'page' && r.task === 'A' && r.authenticated,
            );
            const published = receipts.find((r) => r.kind === 'published');
            const title = '团队简报';
            const next = !p?.approvalId
              ? 'review'
              : plan.loginOrigin
                ? signedIn
                  ? 'authenticated'
                  : 'login'
                : !signedIn
                  ? 'login'
                  : published
                    ? 'complete'
                    : 'act';
            const typed = !!plan.history.some((a) => a.action.kind === 'fill');
            const action =
              next !== 'act'
                ? null
                : typed
                  ? {
                      kind: 'click',
                      target: { role: 'button', name: '发布简报' },
                    }
                  : {
                      kind: 'fill',
                      target: { role: 'textbox', name: '网页输入' },
                      value: p.content,
                    };
            const evidence = published
              ? '已发布到内部公告'
              : typed
                ? '预览：' + p.content
                : signedIn
                  ? '虚构会话仍有效'
                  : '尚未登录虚构账号';
            proposal = {
              decision: next,
              summary:
                next === 'review' ? '请确认团队简报。' : '核对团队简报。',
              evidence: [evidence],
              previous: plan.previous
                ? {
                    id: plan.previous.id,
                    status: 'confirmed',
                    evidence: [evidence],
                  }
                : null,
              action,
            };
            if (next === 'review')
              proposal.publication = {
                destination: '内部公告',
                content: title,
              };
            if (next === 'act') {
              proposal.publication = {
                destination: p.destination,
                content: p.content,
              };
              proposal.approvalId = p.approvalId;
            }
          }
          receipts.push({ kind: 'planning', decision: proposal.decision });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const chunk = (delta, finish_reason) =>
            'data: ' +
            JSON.stringify({
              id: 'participation',
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            '\n\n';
          res.end(
            chunk({ content: JSON.stringify(proposal) }, null) +
              chunk({}, 'stop') +
              'data: [DONE]\n\n',
          );
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
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
    if (review && url.pathname === '/publish' && req.method === 'POST') {
      if (!(req.headers.cookie || '').includes('helpr_fixture=' + login)) {
        res.writeHead(401);
        res.end();
        return;
      }
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
      });
      req.on('end', () => {
        receipts.push({
          kind: 'published',
          task,
          text,
          destination: '内部公告',
        });
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
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>任务 ${task} 的网站</title><style>body{font:16px -apple-system;background:${task === 'A' ? '#f5f8fc' : '#f5faf6'};color:#244135;padding:40px}h1{font-size:28px}input,textarea{padding:12px;border:1px solid #c6d8cc;border-radius:8px;font:inherit}textarea{display:block;width:440px;height:160px;margin-top:18px}a{display:inline-block;padding:12px;background:#1b7956;color:white;border-radius:8px}p{line-height:1.9}</style><h1>任务 ${task} 网站</h1><p>这是本机虚构网站，用于检查真实页面、会话和输入隔离。</p><p id="session">${authenticated ? '虚构会话仍有效' : '尚未登录虚构账号'}</p><a href="/login?task=${task}">登录虚构账号</a><p><label>网页输入 <input aria-label="网页输入" placeholder="仅属于任务 ${task}"></label></p>${review ? '<p>发布栏目：内部公告</p><output></output><button>发布简报</button><script>const box=document.querySelector("input"),out=document.querySelector("output");box.oninput=()=>out.textContent="预览："+box.value;document.querySelector("button").onclick=async()=>{const r=await fetch("/publish"+location.search,{method:"POST",body:box.value});if(r.ok)out.textContent="已发布到内部公告"};</script>' : ''}<textarea aria-label="网站草稿" placeholder="网站未保存的编辑"></textarea><script>fetch('/probe?task=${task}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node:typeof process,require:typeof require,bridge:typeof window.workspace})})</script></html>`,
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
