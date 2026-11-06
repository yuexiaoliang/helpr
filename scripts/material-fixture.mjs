import { createHash } from 'node:crypto';
import fs from 'node:fs';

// 确定性本机替代服务；只检验产品公开入口与真实网页字节，不评价真实模型能力。
export function materialFixture(config, receipts) {
  let uploaded, draft = false, replaced = false, calls = 0, published = false, title = '';
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  return (req, res, url) => {
    const base = `http://${req.headers.host}`;
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          if (++calls > 14) throw Error('MODEL_LIMIT');
          const input = JSON.parse(body), plan = JSON.parse(input.messages.at(-1).content);
          const observed = input.messages.at(-2).content;
          const loaded = observed.includes('附件已上传'), saved = observed.includes('草稿已保存');
          const p = plan.publication, posted = observed.includes('已发布到公告');
          const material = plan.materials?.[0];
          const proposal = { decision: 'act', summary: '准备测试草稿', evidence: ['素材准备'], previous: null, action: null };
          if (!material) {
            proposal.decision = 'material';
            proposal.material = { scope: config.source, rule: 'exact', name: null, extension: null, basis: `使用“${config.source}”` };
          } else if (saved) {
            proposal.decision = 'prepared';
            if (config.publication) {
              const attachmentUrl = observed.match(/\[link-url\] (http[^\s]+\/files\/[a-f0-9]{64})/)?.[1];
              if (!attachmentUrl) throw Error('LINK_NOT_OBSERVED');
              if (posted) {
                proposal.decision = 'complete';
                proposal.evidence = ['已发布到公告'];
                proposal.result = { url: base + '/result/1', targetUrl: base + '/page?task=A', attachmentUrl, publishedEvidence: ['已发布到公告'] };
              } else if (!p?.approvalId) {
                proposal.decision = 'review';
                proposal.publication = { content: '附件日报', destination: '公告', attachment: { materialId: material.id, targetUrl: base + '/page?task=A', url: attachmentUrl } };
              } else {
                const typed = observed.includes('预览：' + p.content);
                proposal.decision = 'act';
                proposal.publication = { content: p.content, destination: p.destination, attachment: p.attachment };
                proposal.approvalId = p.approvalId;
                proposal.effect = typed ? 'publication' : 'interaction';
                if (typed && config.recovery) proposal.recovery = { rule: 'public-attachment-v1', url: base + '/result/1', targetUrl: base + '/page?task=A', attachmentUrl, evidence: ['永久链接'] };
                proposal.action = typed ? { kind: 'click', target: { role: 'button', name: '发布附件' } } : { kind: 'fill', target: { role: 'textbox', name: '发布标题' }, value: p.content };
              }
            }
            proposal.preparation = [{ kind: 'target', url: base + '/page?task=A', materialId: null, evidence: ['素材准备'] }, { kind: 'draft', url: base + '/page?task=A', materialId: null, evidence: ['草稿已保存'] }];
          } else if (loaded) {
            const link = observed.match(/\[link-url\] (http[^\s]+\/files\/[a-f0-9]{64})/)?.[1];
            if (!link) throw Error('LINK_NOT_OBSERVED');
            proposal.preparation = [{ kind: 'target', url: base + '/page?task=A', materialId: null, evidence: ['素材准备'] }, { kind: 'upload', url: link, materialId: material.id, evidence: ['附件已上传'] }];
            proposal.effect = 'draft';
            proposal.action = { kind: 'click', target: { role: 'button', name: '保存草稿', frameUrl: base + '/form' } };
          } else if (plan.previous) {
            proposal.decision = 'observe';
          } else {
            if (!replaced) { fs.writeFileSync(config.source, 'changed after selection'); replaced = true; }
            proposal.action = { kind: 'upload', materialId: material.id, target: { fileIndex: 0, frameUrl: base + '/form' } };
          }
          if (plan.previous) proposal.previous = { id: plan.previous.id, status: proposal.decision === 'observe' ? 'unknown' : 'confirmed', evidence: [saved ? '草稿已保存' : loaded ? '附件已上传' : '素材准备'] };
          receipts.push({ kind: 'planning', decision: proposal.decision });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ id: 'material-fixture', choices: [{ index: 0, delta: { content: JSON.stringify(proposal) }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'material-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(400); res.end(); }
      });
      return true;
    }
    if (url.pathname === '/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', b => chunks.push(b));
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        uploaded = { bytes, sha256: digest(bytes) };
        receipts.push({ kind: 'upload', sha256: uploaded.sha256, bytes: bytes.length });
        res.end('/files/' + uploaded.sha256);
      });
      return true;
    }
    if (url.pathname.startsWith('/files/')) {
      if (!uploaded || !url.pathname.endsWith(uploaded.sha256)) { res.writeHead(404); res.end(); }
      else { receipts.push({ kind: 'download', sha256: uploaded.sha256 }); res.end(uploaded.bytes); }
      return true;
    }
    if (url.pathname === '/draft' && req.method === 'POST') {
      draft = true; receipts.push({ kind: 'draft', sha256: uploaded?.sha256 }); res.end('ok'); return true;
    }
    if (config.publication && url.pathname === '/publish' && req.method === 'POST') {
      let content = ''; req.on('data', b => { content += b; });
      req.on('end', () => { title = content; published = true; receipts.push({ kind: 'published', content, destination: '公告', sha256: uploaded?.sha256 }); res.end('ok'); }); return true;
    }
    if (config.publication && url.pathname === '/result/1') {
      if (!published) { res.writeHead(404); res.end(); return true; }
      const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`${config.recovery ? '<link rel="canonical" href="/result/1">' : ''}<article><h1>${escape(title)}</h1><p>公告</p><a href="/files/${uploaded.sha256}">原始附件</a></article>`); receipts.push({ kind: 'public-read' }); return true;
    }
    if (url.pathname === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>素材准备</title><h1>素材准备</h1>' + (config.publication ? `<p>栏目：公告</p>${config.recovery ? '<a href="/result/1">永久链接</a>' : ''}<label>发布标题<input aria-label="发布标题"></label><output id="preview"></output><button id="publish">发布附件</button><p id="result">${published ? '已发布到公告 <a href="/result/1">查看结果</a>' : '尚未发布'}</p><script>const box=document.querySelector('input');box.oninput=()=>document.querySelector('#preview').textContent='预览：'+box.value;document.querySelector('#publish').onclick=async()=>{await fetch('/publish',{method:'POST',body:box.value});document.querySelector('#result').innerHTML='已发布到公告 <a href="/result/1">查看结果</a>'}</script>` : '') + '<iframe title="素材表单" src="/form" style="width:90%;height:500px;border:0"></iframe>');
      receipts.push({ kind: 'page' }); return true;
    }
    if (url.pathname === '/form') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><h2>素材准备</h2><label>附件 <input type="file"></label><p id="upload">${uploaded ? `附件已上传 <a href="/files/${uploaded.sha256}">下载附件</a>` : '等待素材'}</p><button>保存草稿</button><p id="draft">${draft ? '草稿已保存' : '尚未保存'}</p><script>document.querySelector('input').onchange=async e=>{const r=await fetch('/upload',{method:'POST',body:await e.target.files[0].arrayBuffer()});const a=document.createElement('a');a.href=await r.text();a.textContent='下载附件';document.querySelector('#upload').replaceChildren('附件已上传 ',a)};document.querySelector('button').onclick=async()=>{await fetch('/draft',{method:'POST'});document.querySelector('#draft').textContent='草稿已保存'}</script>`);
      return true;
    }
    return false;
  };
}
