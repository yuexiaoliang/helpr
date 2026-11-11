// 独立网站和替代模型。只从委托与页面观察提议动作，不写产品记录或执行资格。
export function coordinationFixture(receipts) {
  const records = new Map(), waiting = new Set();
  let account = 'alice', planningWait = false, holdWrites = false, calls = 0, writes = 0;
  let participationItem;
  const record = id => {
    if (!records.has(id)) records.set(id, { value: '', revision: 0 });
    return records.get(id);
  };
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const control = change => {
    if ('account' in change) account = change.account;
    if ('planningWait' in change) planningWait = change.planningWait;
    if ('participationItem' in change) participationItem = change.participationItem;
    if ('holdWrites' in change) {
      holdWrites = change.holdWrites;
      if (!holdWrites) { for (const release of waiting) release(); waiting.clear(); }
    }
    receipts.push({ kind: 'environment', ...change, at: Date.now() });
  };
  const handle = (req, res, url) => {
    const base = `http://${req.headers.host}`, id = url.searchParams.get('item');
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = ''; req.on('data', b => { raw += b; });
      req.on('end', () => {
        try {
          if (++calls > 80) throw Error('FIXTURE_MODEL_LIMIT');
          const payload = JSON.parse(raw), plan = JSON.parse(payload.messages.at(-1).content), observed = payload.messages.at(-2).content;
          const [, target, value] = plan.goal.match(/更新 (http\S+) 为“([^”]+)”/);
          const item = new URL(target).searchParams.get('item');
          const identity = /\[link\] 账号 (alice|bob)/.exec(observed)?.[1];
          const previous = plan.previous ? { id: plan.previous.id, status: 'confirmed', evidence: [plan.previous.action.kind === 'fill' ? '输入内容 ' + value : '已保存 ' + value] } : null;
          let step = { decision: 'act', summary: '更新当前记录', evidence: ['记录编辑'], previous, action: null };
          if (!identity) step = { ...step, decision: 'login', previous: null, evidence: ['登录已过期'] };
          else {
            step.coordination = { account: { name: '账号 ' + identity, url: base + '/users/' + identity }, target: { name: '当前记录', url: target }, permissionEvidence: ['可编辑此记录'] };
            if (plan.loginOrigin) step.decision = 'authenticated';
            else if (item === participationItem && !plan.clarifications?.length)
              step = { ...step, decision: 'ask', summary: '请确认是否更新本条记录。' };
            else if (planningWait || observed.includes('正在保存')) step = { ...step, decision: 'observe', previous: null };
            else if (observed.includes('已保存 ' + value)) step.decision = 'complete';
            else if (!observed.includes('输入内容 ' + value)) step.action = { kind: 'fill', target: { role: 'textbox', name: '记录内容' }, value };
            else step.action = { kind: 'click', target: { role: 'button', name: '保存记录' } };
          }
          receipts.push({ kind: 'planning', item, decision: step.decision, account: identity ?? null, at: Date.now() });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(step) }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(400); res.end(); }
      }); return true;
    }
    if (url.pathname === '/session' || url.pathname === '/edit') {
      const cookie = /(?:^|;\s*)coordination_account=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
      if (cookie !== (account ?? 'expired')) res.setHeader('Set-Cookie', `coordination_account=${account ?? 'expired'}; Path=/; HttpOnly; SameSite=Lax`);
    }
    if (url.pathname === '/session') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ account })); return true; }
    if (!id || !/^[A-Z][0-9]?$/.test(id)) return false;
    if (url.pathname === '/record') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(record(id))); return true; }
    if (url.pathname === '/save' && req.method === 'POST') {
      let value = ''; req.on('data', b => { value += b; });
      req.on('end', () => {
        const cookieAccount = /(?:^|;\s*)coordination_account=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
        if (!account || cookieAccount !== account || ++writes > 12) { res.writeHead(403); res.end(); return; }
        const owner = account;
        receipts.push({ kind: 'write-start', item: id, value, account: owner, at: Date.now() });
        const finish = () => {
          Object.assign(record(id), { value, revision: record(id).revision + 1 });
          receipts.push({ kind: 'write-end', item: id, value, account: owner, revision: record(id).revision, at: Date.now() });
          res.end('ok');
        };
        if (holdWrites) waiting.add(finish); else setTimeout(finish, 150);
      }); return true;
    }
    if (url.pathname === '/edit') {
      const p = record(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>记录编辑</title><h1>记录编辑</h1><div id="identity"></div><a href="/edit?item=${id}">当前记录</a><p id="permission"></p><label>记录内容<input aria-label="记录内容" value="${escape(p.value)}"></label><p id="input">输入内容 ${escape(p.value)}</p><button>保存记录</button><p id="result">${p.revision ? '已保存 ' + escape(p.value) : '尚未保存'}</p><script>
let a=${JSON.stringify(account)}; const show=()=>{document.querySelector('#identity').innerHTML=a?'<a href="/users/'+a+'">账号 '+a+'</a>':'登录已过期';document.querySelector('#permission').textContent=a?'可编辑此记录':'需要重新登录'};show();
setInterval(async()=>{const s=await(await fetch('/session')).json();if(a!==s.account){a=s.account;show()}},300);
document.querySelector('input').oninput=e=>document.querySelector('#input').textContent='输入内容 '+e.target.value;
document.querySelector('button').onclick=async()=>{const value=document.querySelector('input').value;document.querySelector('#result').textContent='正在保存';const r=await fetch('/save?item=${id}',{method:'POST',body:value});document.querySelector('#result').textContent=r.ok?'已保存 '+value:'保存被拒绝'};
</script></html>`);
      receipts.push({ kind: 'page', item: id, account, revision: p.revision, at: Date.now() }); return true;
    }
    return false;
  };
  return { handle, control };
}
