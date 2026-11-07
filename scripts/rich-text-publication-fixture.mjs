import { createHash } from 'node:crypto';
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const richPublicationCases = {
  A: { heading: '主文档公告 A', body: '第一行 <中文> & 正文\n第二行精确结束', frame: 'main' },
  B: { heading: '内联空白公告 B', body: 'blank 第一行 <标签>\nblank 第二行 & 完成', frame: 'about:blank' },
  C: { heading: '内联段落公告 C', body: 'srcdoc 第一行\n第二行 <中文> & 文本\n第三行结束', frame: 'about:srcdoc' },
  N: { heading: '节点替换反例 N', body: '不应写入替换节点\n第二行不发送', frame: 'main' },
  P: { heading: '页面替换反例 P', body: '不应沿用旧页预览\n第二行不发送', frame: 'about:srcdoc' },
};
for (const [item, source] of Object.entries({ D: 'A', E: 'B', F: 'C', G: 'A', H: 'B', I: 'C' })) {
  richPublicationCases[item] = { ...richPublicationCases[source], heading: '本次新素材公告 ' + item, body: item + ' 新正文 <中文> & 第一行\n' + item + ' 第二行结束' };
}
export function richTextPublicationFixture(receipts, { rebind = false } = {}) {
  const pages = new Map(); let calls = 0, writes = 0;
  const get = item => { if (!pages.has(item)) pages.set(item, { bytes: null, draft: false, published: false, inputCount: 0 }); return pages.get(item); };
  const child = (item, root = 'div') => {
    const markup = richPublicationCases[item].frame === 'about:srcdoc' ? '<p>原有段落</p><p>原有正文</p>' : '';
    const attrs = 'contenteditable="true" style="white-space:pre-wrap;min-height:100px;border:1px solid #888"';
    const script = `const install=()=>{document.querySelector('[contenteditable]').oninput=e=>{parent.fetch('/rt-input?item=${item}',{method:'POST',body:JSON.stringify({value:e.target.innerText,html:e.target.innerHTML,inputType:e.inputType})});}};if(document.readyState==='loading')addEventListener('DOMContentLoaded',install,{once:true});else install();`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>正文子文档</title><script>${script}</script></head>${root === 'body' ? `<body ${attrs}>${markup}</body>` : `<body><div ${attrs}>${markup}</div></body>`}</html>`;
  };
  return (req, res, url) => {
    const base = `http://${req.headers.host}`;
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
        try {
          if (++calls > 30) throw Error('MODEL_LIMIT');
          const input = JSON.parse(raw), plan = JSON.parse(input.messages.at(-1).content), observed = input.messages.at(-2).content;
          const match = plan.goal.match(/使用“(.+?)”在 (http\S+) 发布“([\s\S]+?)”到“(.+?)”/);
          if (!match) throw Error('GOAL_REQUIRED');
          const [, source, target, content, destination] = match, item = new URL(target).searchParams.get('item');
          const control = plan.controls?.find(c => c.richText?.locator), m = plan.materials?.[0], p = plan.publication;
          const previous = plan.previous ? { id: plan.previous.id, status: 'confirmed', evidence: ['附件编辑'] } : null;
          let step = { decision: 'act', summary: '核对富文本发布', evidence: ['附件编辑'], previous, action: null };
          const candidate = rebind ? plan.workflows?.[0] : undefined;
          if (candidate) step = { ...step, decision: 'reuse', material: { scope: source, rule: 'exact', name: null, extension: null, basis: `使用“${source}”` }, workflow: { taskId: candidate.taskId, version: candidate.version, sha256: candidate.sha256, content, destination, fields: candidate.fields.map(({richText, ...field}) => ({ ...field, value: field.id === 'title' ? content.split('\n\n')[0] : content.split('\n\n')[1], ...(field.frameUrl === candidate.applicability.entryUrl ? { frameUrl: target } : {}) })) } };
          else if (!m) step = { ...step, decision: 'material', material: { scope: source, rule: 'exact', name: null, extension: null, basis: `使用“${source}”` } };
          else if (!observed.includes('附件已上传')) step = { ...step, effect: 'upload', action: { kind: 'upload', materialId: m.id, target: { fileIndex: 0 } } };
          else {
            step.preparation = [{ kind: 'target', url: target, materialId: null, evidence: ['附件编辑'] }, { kind: 'upload', url: base + '/rt-file?item=' + item, materialId: m.id, evidence: ['附件已上传'] }];
            if (!observed.includes('草稿已保存')) step = { ...step, effect: 'draft', action: { kind: 'click', target: { role: 'button', name: '保存草稿' } } };
            else {
              step.preparation.push({ kind: 'draft', url: target, materialId: null, evidence: ['草稿已保存'] });
              if (!control) throw Error('RICH_TEXT_LOCATOR_MISSING');
              const fields = p?.fields ?? [{ id: 'title', name: '发布标题', value: content.split('\n\n')[0] }, { id: 'body', name: '文章正文', value: content.split('\n\n')[1], frameUrl: control.frameUrl, richText: control.richText.locator }];
              const publication = { content, destination, fields, attachment: { materialId: m.id, targetUrl: target, url: base + '/rt-file?item=' + item } };
              if (!p?.approvalId) step = { ...step, decision: 'review', publication };
              else if (observed.includes('已正式发布')) step = { ...step, decision: 'complete', result: { url: base + '/rt-result?item=' + item, targetUrl: target, attachmentUrl: publication.attachment.url, publishedEvidence: ['已正式发布'] } };
              else {
                step.publication = publication; step.approvalId = p.approvalId;
                if (plan.controls.find(c => c.role === 'textbox' && c.name === '发布标题')?.textValue !== fields[0].value) step = { ...step, effect: 'interaction', action: { kind: 'fill', target: { role: 'textbox', name: '发布标题' }, value: fields[0].value } };
                else if (control.textValue !== fields[1].value) step = { ...step, effect: 'interaction', action: { kind: 'fill', target: fields[1].richText, value: fields[1].value } };
                else if (!observed.includes('栏目已填写')) step = { ...step, effect: 'interaction', action: { kind: 'select', target: { role: 'combobox', name: '栏目' }, value: destination } };
                else step = { ...step, effect: 'publication', action: { kind: 'click', target: { role: 'button', name: '发布附件' } }, recovery: { rule: 'public-attachment-v1', url: base + '/rt-result?item=' + item, targetUrl: target, attachmentUrl: publication.attachment.url, evidence: ['永久链接'] } };
              }
            }
          }
          receipts.push({ kind: 'rt-planning', item, decision: step.decision, action: step.action, control, workflows: plan.workflows?.map(w => w.version), at: Date.now() });
          const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason === 'stop' ? { usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } } : {}) }) + '\n\n';
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(chunk({ content: JSON.stringify(step) }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(400); res.end(); }
      }); return true;
    }
    const item = url.searchParams.get('item'), spec = richPublicationCases[item];
    if (!url.pathname.startsWith('/rt-') || !spec) return false;
    const p = get(item), query = '?item=' + item;
    if (url.pathname === '/rt-arm' && req.method === 'POST') { if (!['N', 'P'].includes(item) || p.armedOnce) { res.writeHead(409); res.end(); return true; } p.armedOnce = true; p.arm = true; receipts.push({ kind: 'rt-armed', item, at: Date.now() }); res.end('ok'); return true; }
    if (url.pathname === '/rt-poll') { const armed = p.arm === true; p.arm = false; res.end(armed ? item : ''); return true; }
    if (url.pathname === '/rt-changed') { receipts.push({ kind: 'rt-changed', item, at: Date.now() }); res.end('ok'); return true; }
    if (req.method === 'POST') {
      const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks);
          if (url.pathname === '/rt-input') {
            if (++p.inputCount > 12) throw Error('INPUT_LIMIT');
            receipts.push({ kind: 'rt-input', item, ...JSON.parse(bytes), at: Date.now() });
          } else {
            if (++writes > 9) throw Error('WRITE_LIMIT');
            if (url.pathname === '/rt-upload') { p.bytes = bytes; receipts.push({ kind: 'rt-upload', item, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), at: Date.now() }); }
            else if (url.pathname === '/rt-draft') { p.draft = true; receipts.push({ kind: 'rt-draft', item, at: Date.now() }); }
            else if (url.pathname === '/rt-publish') { if (p.published) throw Error('DUPLICATE_PUBLICATION'); Object.assign(p, JSON.parse(bytes), { published: true }); receipts.push({ kind: 'rt-published', item, heading: p.heading, body: p.body, destination: p.destination, at: Date.now() }); }
            else throw Error('UNKNOWN_WRITE');
          }
          res.end('ok');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(409); res.end(); }
      }); return true;
    }
    if (url.pathname === '/rt-file') { if (!p.bytes) res.writeHead(404); else receipts.push({ kind: 'rt-download', item, at: Date.now() }); res.end(p.bytes); return true; }
    if (url.pathname === '/rt-result') {
      if (!p.published) { res.writeHead(404); res.end(); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<link rel="canonical" href="/rt-result${query}"><article><h1>${escape(p.heading)}</h1><section>${escape(p.body)}</section><p>${escape(p.destination)}</p><a href="/rt-file${query}">下载附件</a><a href="/rt-edit${query}">编辑原条目</a></article>`); receipts.push({ kind: 'rt-public-read', item, at: Date.now() }); return true;
    }
    if (url.pathname === '/rt-edit') {
      const inline = spec.frame !== 'main', document = child(item, spec.frame === 'about:srcdoc' ? 'body' : 'div');
      const editor = inline ? `<iframe title="正文编辑器" ${spec.frame === 'about:blank' ? 'src="about:blank"' : 'srcdoc="' + escape(document) + '"'} style="width:600px;height:180px"></iframe>` : '<div contenteditable="true" style="white-space:pre-wrap;min-height:100px;border:1px solid #888"></div>';
      const setup = spec.frame === 'about:blank' ? `const child=document.querySelector('iframe').contentDocument;child.documentElement.innerHTML=${JSON.stringify(document).replaceAll('<', '\\u003c')};const script=child.createElement('script');script.textContent=child.querySelector('script').textContent;child.head.append(script);` : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>附件编辑</title><h1>附件编辑</h1><label>附件<input type="file"></label><p id="upload">${p.bytes ? `附件已上传 <a href="/rt-file${query}">下载附件</a>` : '等待素材'}</p><button id="draft">保存草稿</button><p id="drafted">${p.draft ? '草稿已保存' : '尚未保存'}</p><label>发布标题<input id="heading"></label>${editor}<label>栏目<select id="destination"><option>公告</option><option>通知</option></select></label><output id="selected"></output><a href="/rt-result${query}">永久链接</a><button id="publish">发布附件</button><p id="result">${p.published ? '已正式发布' : '尚未发布'}</p><script>
const q=${JSON.stringify(query)};${setup}
const editor=()=>${inline ? "document.querySelector('iframe').contentDocument" : 'document'}.querySelector('[contenteditable]');
${inline ? '' : "editor().oninput=e=>fetch('/rt-input'+q,{method:'POST',body:JSON.stringify({value:e.target.innerText,html:e.target.innerHTML,inputType:e.inputType})});"}
document.querySelector('[type=file]').onchange=async e=>{document.querySelector('#upload').textContent='正在上传附件';await fetch('/rt-upload'+q,{method:'POST',body:await e.target.files[0].arrayBuffer()});document.querySelector('#upload').innerHTML='附件已上传 <a href="/rt-file'+q+'">下载附件</a>';};
document.querySelector('#draft').onclick=async()=>{await fetch('/rt-draft'+q,{method:'POST'});document.querySelector('#drafted').textContent='草稿已保存';};
document.querySelector('#destination').onchange=()=>{document.querySelector('#selected').textContent='栏目已填写';};
document.querySelector('#publish').onclick=async()=>{document.querySelector('#result').textContent='正在发布附件';await fetch('/rt-publish'+q,{method:'POST',body:JSON.stringify({heading:document.querySelector('#heading').value,body:editor().innerText,destination:document.querySelector('#destination').value})});document.querySelector('#result').textContent='已正式发布';};
${['N', 'P'].includes(item) ? "const timer=setInterval(async()=>{const action=await fetch('/rt-poll'+q).then(r=>r.text());if(!action)return;clearInterval(timer);if(action==='N'){editor().replaceWith(editor().cloneNode(true));await fetch('/rt-changed'+q);}else{await fetch('/rt-changed'+q);location.reload();}},100);" : ''}
</script>`);
      receipts.push({ kind: 'rt-page', item, at: Date.now() }); return true;
    }
    return false;
  };
}
