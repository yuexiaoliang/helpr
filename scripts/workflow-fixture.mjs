// 本机替代模型从委托提取参数并提议首次动作；复用阶段只回答绑定，不提供网页步骤。
export function workflowFixture(receipts, { repair = false } = {}) {
  let calls = 0, writes = 0;
  const waitingDrafts = new Map();
  const labels = id => !repair || id === 'A' ? {draft: '保存草稿', title: '发布标题', publish: '发布附件'} : id === 'C' ? {draft: '暂存附件', title: '正文内容', publish: '确认送出'} : {draft: '暂存附件', title: '公告全文', publish: '发布附件'};
  const pages = new Map();
  const get = id => {
    if (!pages.has(id)) pages.set(id, { bytes: null, draft: false, published: false, content: '', destination: '公告' });
    return pages.get(id);
  };
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return (req, res, url) => {
    const base = `http://${req.headers.host}`;
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = ''; req.on('data', b => { body += b; });
      req.on('end', () => {
        try {
          if (++calls > 80) throw Error('FIXTURE_MODEL_LIMIT');
          const input = JSON.parse(body), plan = JSON.parse(input.messages.at(-1).content);
          const observed = input.messages.at(-2).content;
          const [, source, target, content, destination] = plan.goal.match(/使用“(.+?)”在 (http\S+) 发布“(.+?)”到“(.+?)”/);
          const targetURL = new URL(target), id = targetURL.searchParams.get('item');
          const material = { scope: source, rule: 'exact', name: null, extension: null, basis: `使用“${source}”` };
          const p = plan.publication, m = plan.materials?.[0];
          const buttons = [...observed.matchAll(/\[button\] ([^\n]+)/g)].map(m => m[1]);
          const titleControl = /\[textbox\] ([^\n：]+)/.exec(observed)?.[1];
          const previous = plan.previous ? { id: plan.previous.id, status: 'confirmed', evidence: [observed.includes('已正式发布') ? '已正式发布' : observed.includes('栏目已填写') ? '栏目已填写' : observed.includes('标题已填写') ? '标题已填写' : observed.includes('草稿已保存') ? '草稿已保存' : '附件已上传'] } : null;
          let step = { decision: 'act', summary: '核对本次附件', evidence: ['附件编辑'], previous, action: null };
          if (plan.workflows?.length) {
            const w = plan.workflows[0];
            step = { ...step, decision: 'reuse', material, workflow: { taskId: w.taskId, version: w.version, sha256: w.sha256, content, destination } };
          } else if (/正在(上传|保存|发布)附件/.test(observed)) step = { ...step, decision: 'observe', previous: null };
          else if (!m) step = { ...step, decision: 'material', material };
          else if (!observed.includes('附件已上传')) step = { ...step, effect: 'upload', action: { kind: 'upload', materialId: m.id, target: { fileIndex: 0 } } };
          else {
            step.preparation = [{ kind: 'target', url: target, materialId: null, evidence: ['附件编辑'] }, { kind: 'upload', url: base + '/file?item=' + id, materialId: m.id, evidence: ['附件已上传'] }];
            if (!observed.includes('草稿已保存')) step = { ...step, effect: 'draft', action: { kind: 'click', target: { role: 'button', name: buttons.find(name => /保存草稿|暂存附件/.test(name)) } } };
            else {
              step.preparation.push({ kind: 'draft', url: target, materialId: null, evidence: ['草稿已保存'] });
              const publication = { content: p?.content ?? content, destination, attachment: { materialId: m.id, targetUrl: target, url: base + '/file?item=' + id } };
              if (!p?.approvalId) step = { ...step, decision: 'review', publication };
              else if (observed.includes('已正式发布')) step = { ...step, decision: 'complete', result: { url: base + '/result?item=' + id, targetUrl: target, attachmentUrl: publication.attachment.url, publishedEvidence: ['已正式发布'] } };
              else {
                step.publication = publication; step.approvalId = p.approvalId;
                if (!observed.includes('标题已填写')) step = { ...step, effect: 'interaction', action: { kind: 'fill', target: { role: 'textbox', name: titleControl }, value: publication.content } };
                else if (!observed.includes('栏目已填写')) step = { ...step, effect: 'interaction', action: { kind: 'select', target: { role: 'combobox', name: '栏目' }, value: destination } };
                else step = { ...step, effect: 'publication', action: { kind: 'click', target: { role: 'button', name: buttons.find(name => /发布附件|确认送出/.test(name)) } }, recovery: { rule: 'public-attachment-v1', url: base + '/result?item=' + id, targetUrl: target, attachmentUrl: publication.attachment.url, evidence: ['永久链接'] } };
              }
            }
          }
          if (repair) step.coordination = {account: {name: '账号 fixture', url: base + '/users/fixture'}, target: {name: '当前记录', url: target}, permissionEvidence: ['可编辑此记录']};
          receipts.push({ kind: 'planning', item: id, decision: step.decision, repair: !!plan.repair, at: Date.now() });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(step) }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(400); res.end(); }
      }); return true;
    }
    const id = url.searchParams.get('item');
    if (!id || !['A', 'B', 'C', 'D'].includes(id)) return false;
    const p = get(id), query = '?item=' + id;
    if (req.method === 'POST') {
      const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
        if (++writes > 15) { res.writeHead(429); res.end(); return; }
        const bytes = Buffer.concat(chunks);
        if (url.pathname === '/upload') { p.bytes = bytes; receipts.push({ kind: 'upload', item: id, bytes: bytes.length }); }
        else if (url.pathname === '/draft') {
          if (repair && ['B', 'C'].includes(id)) {
            receipts.push({kind:'draft-start', item:id, at:Date.now()});
            const timer = setTimeout(() => { waitingDrafts.delete(id); receipts.push({kind:'draft-timeout', item:id}); res.writeHead(504); res.end(); }, 12000);
            waitingDrafts.set(id, () => {clearTimeout(timer); p.draft = true; receipts.push({kind:'draft', item:id, at:Date.now()}); res.end('ok');});
            if (waitingDrafts.size === 2) {for (const finish of waitingDrafts.values()) finish(); waitingDrafts.clear();}
            return;
          }
          p.draft = true; receipts.push({ kind: 'draft', item: id, at:Date.now() });
        }
        else if (url.pathname === '/publish') { Object.assign(p, JSON.parse(bytes.toString()), { published: true }); receipts.push({ kind: 'published', item: id, content: p.content, destination: p.destination }); }
        else { res.writeHead(404); }
        res.end('ok');
      }); return true;
    }
    if (url.pathname === '/file') { if (p.bytes) { receipts.push({ kind: 'download', item: id }); res.end(p.bytes); } else { res.writeHead(404); res.end(); } return true; }
    if (url.pathname === '/result') {
      if (!p.published) { res.writeHead(404); res.end(); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<link rel="canonical" href="/result${query}"><article><h1>${escape(p.content)}</h1><p>${escape(p.destination)}</p><a href="/file${query}">下载附件</a></article>`);
      receipts.push({ kind: 'public-read', item: id }); return true;
    }
    if (url.pathname === '/edit') {
      const names = labels(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>附件编辑</title><h1>附件编辑</h1>${repair ? `<a href="/users/fixture">账号 fixture</a><a href="/edit${query}">当前记录</a><p>可编辑此记录</p>` : ''}<p>固定标签：公告</p><label>附件<input type="file"></label><p id="upload">${p.bytes ? `附件已上传 <a href="/file${query}">下载附件</a>` : '等待素材'}</p><button id="draft">${names.draft}</button><p id="drafted">${p.draft ? '草稿已保存' : '尚未保存'}</p><label>${names.title}<input id="title"></label><output id="preview"></output><label>栏目<select id="destination"><option>公告</option><option>通知</option></select></label><output id="selected"></output><a href="/result${query}">永久链接</a><button id="publish">${names.publish}</button><p id="result">${p.published ? '已正式发布' : '尚未发布'}</p><script>
const q=${JSON.stringify(query)};
document.querySelector('[type=file]').onchange=async e=>{document.querySelector('#upload').textContent='正在上传附件';await fetch('/upload'+q,{method:'POST',body:await e.target.files[0].arrayBuffer()});document.querySelector('#upload').innerHTML='附件已上传 <a href="/file'+q+'">下载附件</a>'};
document.querySelector('#draft').onclick=async()=>{document.querySelector('#drafted').textContent='正在保存附件';await fetch('/draft'+q,{method:'POST'});document.querySelector('#drafted').textContent='草稿已保存'};
document.querySelector('#title').oninput=e=>{document.querySelector('#preview').textContent='标题已填写 '+e.target.value};
document.querySelector('#destination').onchange=e=>{document.querySelector('#selected').textContent='栏目已填写 '+e.target.value};
document.querySelector('#publish').onclick=async()=>{document.querySelector('#result').textContent='正在发布附件';await fetch('/publish'+q,{method:'POST',body:JSON.stringify({content:document.querySelector('#title').value,destination:document.querySelector('#destination').value})});document.querySelector('#result').textContent='已正式发布'};
</script>`);
      receipts.push({ kind: 'page', item: id }); return true;
    }
    return false;
  };
}
