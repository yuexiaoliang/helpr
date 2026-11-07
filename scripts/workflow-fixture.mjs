import { randomUUID } from 'node:crypto';
// 本机替代模型从委托提取参数并提议首次动作；复用阶段只回答绑定，不提供网页步骤。
export function workflowFixture(receipts, { repair = false, article = false, agreements = false, schedules = false, crossSite = false, separateFields = false, dynamicResult = false } = {}) {
  let calls = 0, writes = 0, newItems = 0;
  const waitingDrafts = new Map();
  const labels = id => crossSite ? {draft: '保存草稿', title: '正文：纯文本', publish: '发布附件'} : !repair || id === 'A' ? {draft: '保存草稿', title: '发布标题', publish: '发布附件'} : id === 'C' ? {draft: '暂存附件', title: '正文内容', publish: '确认送出'} : {draft: '暂存附件', title: '公告全文', publish: '发布附件'};
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
          if (schedules && plan.request?.now) {
            const startAt=plan.request.text.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
            if(!startAt)throw Error('SCHEDULE_FIXTURE_INPUT');
            const answer={decision:'review',summary:'Review the explicit schedule',evidence:['User request'],previous:null,action:null,schedule:{zone:'Asia/Shanghai',startAt,cadence:{kind:'interval',seconds:60},overlap:'ask',gap:'ask',missed:'latest',graceSeconds:60,periodKey:'date'}};
            receipts.push({kind:'schedule-model',at:Date.now()});
            res.writeHead(200, {'Content-Type':'text/event-stream'});
            res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(answer)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})+'\n\ndata: [DONE]\n\n');
            return;
          }
          if (agreements && plan.request) {
            const match = plan.request.text.match(/从“(.+?)”取唯一 xlsx，在 (http\S+) 的“(.+?)”栏目，按“(.+?)”自动发布，新内容另发，同内容一次/);
            if (!match) throw Error('AGREEMENT_FIXTURE_INPUT');
            const [,scope,entryUrl,destination,contentRules] = match;
            const answer = {decision:'review',summary:'请接受完整发布约定',evidence:['用户发布约定要求'],previous:null,action:null,agreement:{selection:{scope,rule:'only',name:null,extension:'.xlsx'},entryUrl,destination,contentRules,changedBytes:'new-publication',period:'once-per-material'}};
            receipts.push({kind:'agreement-model',at:Date.now()});
            res.writeHead(200, {'Content-Type':'text/event-stream'});
            res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(answer)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})+'\n\ndata: [DONE]\n\n');
            return;
          }
          if (article && plan.source) {
            const source = plan.source;
            const blocks = [];
            for (const sheet of source.sheets) {
              for (const cell of sheet.cells.filter(c => c.status === 'value' && c.address.startsWith('A'))) {
                const value = sheet.cells.find(c => c.address === 'B' + cell.address.slice(1) && c.status === 'value');
                if (value) blocks.push({ kind: 'fact', text: cell.display + '：' + value.display + '。', citations: [cell,value].map(c => ({sheet:sheet.name,address:c.address,quote:c.display})) });
              }
            }
            const answer = {decision:'review', summary:'已按固定表格生成文章建议', evidence:['基于固定素材提出建议'], previous:null, action:null, article:{destination:agreements ? source.requirements.goal.match(/的“(.+?)”。/)?.[1] ?? '公告' : '公告',blocks}};
            receipts.push({kind:'content-model', sourceId:source.id, at:Date.now()});
            res.writeHead(200, {'Content-Type':'text/event-stream'});
            res.end('data: ' + JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(answer)},finish_reason:null}]}) + '\n\ndata: ' + JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}) + '\n\ndata: [DONE]\n\n');
            return;
          }
          const observed = input.messages.at(-2).content;
          const bound = plan.publishingAgreement;
          const normal = bound ? null : plan.goal.match(/使用“(.+?)”在 (http\S+) 发布“([\s\S]+?)”到“(.+?)”/);
          const source = bound?.selection.scope ?? normal[1];
          const target = bound ? observed.match(/页面观察[^\n]*\n(http[^\s]+)/)[1] : normal[2];
          const content = bound ? '' : normal[3], destination = bound?.destination ?? normal[4];
          const targetURL = new URL(target), id = targetURL.searchParams.get('item');
          const material = bound ? {...bound.selection,basis:plan.goal} : { scope: source, rule: 'exact', name: null, extension: null, basis: `使用“${source}”` };
          const p = plan.publication, m = plan.materials?.[0];
          const fields = separateFields ? [{id:'title',name:labels(id).title,value:content.split('\n\n')[0]},{id:'body',name:'文章正文',value:content.split('\n\n')[1]}] : undefined;
          const buttons = [...observed.matchAll(/\[button\] ([^\n]+)/g)].map(m => m[1]);
          const titleControl = plan.controls?.find(c => c.role === 'textbox')?.name ?? /\[textbox\] ([^\n：]+)/.exec(observed)?.[1];
          const previous = plan.previous ? { id: plan.previous.id, status: 'confirmed', evidence: [observed.includes('已正式发布') ? '已正式发布' : observed.includes('栏目已填写') ? '栏目已填写' : observed.includes('正文已填写') ? '正文已填写' : observed.includes('标题已填写') ? '标题已填写' : observed.includes('草稿已保存') ? '草稿已保存' : observed.includes('附件已上传') ? '附件已上传' : '附件编辑'] } : null;
          let step = { decision: 'act', summary: '核对本次附件', evidence: ['附件编辑'], previous, action: null };
          if (agreements && targetURL.pathname === '/new') step = {...step,evidence:['创建文章'],effect:'draft',action:{kind:'click',target:{role:'button',name:'创建文章'}}};
          else if (!dynamicResult && !article && plan.workflows?.length) {
            const w = plan.workflows[0];
            step = { ...step, decision: 'reuse', material, workflow: { taskId: w.taskId, version: w.version, sha256: w.sha256, content, destination, ...(fields ? {fields} : {}) } };
          } else if (/正在(上传|保存|发布)附件/.test(observed)) step = { ...step, decision: 'observe', previous: null };
          else if (!m) step = { ...step, decision: 'material', material };
          else if (article && !plan.article) step = { ...step, decision: 'compose', compose: {materialId:m.id} };
          else if (!observed.includes('附件已上传')) step = { ...step, effect: 'upload', action: { kind: 'upload', materialId: m.id, target: { fileIndex: 0 } } };
          else {
            step.preparation = [{ kind: 'target', url: target, materialId: null, evidence: ['附件编辑'] }, { kind: 'upload', url: base + '/file?item=' + id, materialId: m.id, evidence: ['附件已上传'] }];
            if (!observed.includes('草稿已保存')) step = { ...step, effect: 'draft', action: { kind: 'click', target: { role: 'button', name: buttons.find(name => /保存草稿|暂存附件/.test(name)) } } };
            else {
              step.preparation.push({ kind: 'draft', url: target, materialId: null, evidence: ['草稿已保存'] });
              const publication = { ...(fields ? {fields: p?.fields ?? fields} : {}), ...(article ? {articleId: p?.articleId ?? plan.article.id} : {}), content: p?.content ?? plan.article?.content ?? content, destination, attachment: { materialId: m.id, targetUrl: target, url: base + '/file?item=' + id } };
              if (!p?.approvalId) step = { ...step, decision: 'review', publication };
              else if (observed.includes('已正式发布')) step = { ...step, decision: 'complete', result: { url: base + '/result?item=' + id, targetUrl: target, attachmentUrl: publication.attachment.url, publishedEvidence: ['已正式发布'] } };
              else {
                step.publication = publication; step.approvalId = p.approvalId;
                if (!observed.includes('标题已填写')) step = { ...step, effect: 'interaction', action: { kind: 'fill', target: { role: 'textbox', name: titleControl }, value: fields ? publication.fields[0].value : publication.content } };
                else if (fields && !observed.includes('正文已填写')) step = {...step,effect:'interaction',action:{kind:'fill',target:{role:'textbox',name:'文章正文'},value:publication.fields[1].value}};
                else if (!observed.includes('栏目已填写')) step = { ...step, effect: 'interaction', action: { kind: 'select', target: { role: 'combobox', name: plan.controls?.find(c => c.role === 'combobox')?.name ?? '栏目' }, value: destination } };
                else step = { ...step, effect: 'publication', action: { kind: 'click', target: { role: 'button', name: buttons.find(name => /发布附件|确认送出/.test(name)) } }, recovery: { rule: 'public-attachment-v1', url: base + '/result?item=' + id, targetUrl: target, attachmentUrl: publication.attachment.url, evidence: ['永久链接'] } };
              }
            }
          }
          if (agreements && targetURL.pathname === '/edit' && !plan.preparation?.some(f=>f.kind==='target')) step.preparation=[{kind:'target',url:target,materialId:null,evidence:['附件编辑']},...(step.preparation??[]).filter(f=>f.kind!=='target')];
          if (agreements && targetURL.pathname === '/edit' && observed.includes('草稿已保存') && !plan.preparation?.some(f=>f.kind==='draft') && !step.preparation?.some(f=>f.kind==='draft')) (step.preparation??=[]).push({kind:'draft',url:target,materialId:null,evidence:['草稿已保存']});
          if (dynamicResult) delete step.recovery;
          if (repair) step.coordination = {account: {name: '账号 fixture', url: base + '/users/fixture'}, target: {name: '当前记录', url: target}, permissionEvidence: ['可编辑此记录']};
          receipts.push({ kind: 'planning', item: id, decision: step.decision, repair: !!plan.repair, at: Date.now() });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(step) }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { receipts.push({ kind: 'fixture-error', error: error.message }); res.writeHead(400); res.end(); }
      }); return true;
    }
    if (agreements && url.pathname === '/readiness') {receipts.push({kind:'readiness',state:Object.fromEntries(url.searchParams),at:Date.now()});res.end('ok');return true;}
    if (agreements && url.pathname === '/new') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>新文章</title><button onclick="location.href='/create'">创建文章</button><script>
let frames=0;const started=performance.timeOrigin;function tick(){frames++;if(performance.now()<6500)requestAnimationFrame(tick)}requestAnimationFrame(tick);
for(const delay of [1000,3000,6000])setTimeout(()=>fetch('/readiness?'+new URLSearchParams({started,frames,visibility:document.visibilityState,ready:document.readyState,focus:document.hasFocus(),width:innerWidth,height:innerHeight,button:JSON.stringify(document.querySelector('button').getBoundingClientRect().toJSON())})),delay);
</script>`);return true;}
    if (agreements && url.pathname === '/create') {const id='W'+(++newItems);get(id).draft=true;receipts.push({kind:'created',item:id},{kind:'draft',item:id,at:Date.now()});res.writeHead(302,{Location:'/edit?item='+id});res.end();return true;}
    const id = url.searchParams.get('item');
    if (!id || !(agreements ? /^W[1-9][0-9]*$/.test(id) : ['A', 'B', 'C', 'D', 'E'].includes(id))) return false;
    const p = get(id), query = '?item=' + id;
    if (crossSite && url.pathname === '/selection') { receipts.push({kind:'selection',item:id,value:url.searchParams.get('value'),label:url.searchParams.get('label')}); res.end('ok'); return true; }
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
        else if (url.pathname === '/publish') { Object.assign(p, dynamicResult ? Object.fromEntries(new URLSearchParams(bytes.toString())) : JSON.parse(bytes.toString()), { published: true }); if (dynamicResult) { p.content = p.heading + '\n\n' + p.body; p.resultPath = '/dynamic/' + randomUUID(); } receipts.push({ kind: 'published', item: id, content: p.content, heading:p.heading, body:p.body, destination: p.destination }); }
        else { res.writeHead(404); }
        if (dynamicResult && url.pathname === '/publish') res.writeHead(303, { Location: p.resultPath + query });
        res.end('ok');
      }); return true;
    }
    if (url.pathname === '/file') { if (p.bytes) { receipts.push({ kind: 'download', item: id }); res.end(p.bytes); } else { res.writeHead(404); res.end(); } return true; }
    if ((!dynamicResult && url.pathname === '/result') || (dynamicResult && url.pathname === p.resultPath)) {
      if (!p.published) { res.writeHead(404); res.end(); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<link rel="canonical" href="${dynamicResult ? p.resultPath : '/result'}${query}"><article><h1>${escape(separateFields ? p.heading : p.content)}</h1><p>${escape(p.destination)}</p>${separateFields ? `<section>${escape(p.body)}</section>` : ''}<a href="/file${query}">下载附件</a>${dynamicResult ? `<a href="/edit?item=${id === 'B' ? 'wrong' : id}">编辑原条目</a>` : ''}</article>`);
      receipts.push({ kind: 'public-read', item: id }); return true;
    }
    if (url.pathname === '/edit') {
      const names = labels(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>附件编辑</title><h1>附件编辑</h1>${repair ? `<a href="/users/fixture">账号 fixture</a><a href="/edit${query}">当前记录</a><p>可编辑此记录</p>` : ''}<p>固定标签：公告</p><label>附件<input type="file"></label><p id="upload">${p.bytes ? `附件已上传 <a href="/file${query}">下载附件</a>` : '等待素材'}</p><button id="draft">${names.draft}</button><p id="drafted">${p.draft ? '草稿已保存' : '尚未保存'}</p>${dynamicResult ? `<form method="post" action="/publish${query}">` : ''}<label>${names.title}${article || crossSite ? '<textarea id="title"></textarea>' : '<input id="title" name="heading">'}</label><output id="preview"></output>${separateFields ? '<label>文章正文<textarea id="body" name="body"></textarea></label><output id="body-preview"></output>' : ''}<label>${crossSite ? '栏目：选择' : '栏目'}<select id="destination" name="destination">${crossSite ? '<option value="17">公告</option><option value="42">通知</option>' + (id === 'E' ? '<option value="99">通知</option>' : '') : '<option>公告</option><option>通知</option>'}</select></label><output id="selected"></output>${dynamicResult ? '' : `<a href="/result${query}">永久链接</a>`}<button id="publish">${names.publish}</button>${dynamicResult ? '</form>' : ''}<p id="result">${p.published ? '已正式发布' : '尚未发布'}</p><script>
const q=${JSON.stringify(query)};
document.querySelector('[type=file]').onchange=async e=>{document.querySelector('#upload').textContent='正在上传附件';await fetch('/upload'+q,{method:'POST',body:await e.target.files[0].arrayBuffer()});document.querySelector('#upload').innerHTML='附件已上传 <a href="/file'+q+'">下载附件</a>'};
document.querySelector('#draft').onclick=async()=>{document.querySelector('#drafted').textContent='正在保存附件';await fetch('/draft'+q,{method:'POST'});document.querySelector('#drafted').textContent='草稿已保存'};
document.querySelector('#title').oninput=e=>{document.querySelector('#preview').textContent='标题已填写 '+e.target.value};
${separateFields ? `document.querySelector('#body').oninput=e=>{document.querySelector('#body-preview').textContent='正文已填写 '+e.target.value};` : ''}
document.querySelector('#destination').onchange=e=>{const requested=e.target.selectedOptions[0].label; ${crossSite ? ("if(" + JSON.stringify(id) + "==='D')e.target.value='17'; fetch('/selection'+q+'&value='+e.target.value+'&label='+encodeURIComponent(e.target.selectedOptions[0].label));") : ''} document.querySelector('#selected').textContent='栏目已填写 '+requested};
${dynamicResult ? '' : `document.querySelector('#publish').onclick=async()=>{document.querySelector('#result').textContent='正在发布附件';await fetch('/publish'+q,{method:'POST',body:JSON.stringify({content:document.querySelector('#title').value${separateFields ? `+'\\n\\n'+document.querySelector('#body').value,heading:document.querySelector('#title').value,body:document.querySelector('#body').value` : ''},destination:document.querySelector('#destination').selectedOptions[0].label})});document.querySelector('#result').textContent='已正式发布'};`}
</script>`);
      receipts.push({ kind: 'page', item: id }); return true;
    }
    return false;
  };
}
