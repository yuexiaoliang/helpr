import { createHash, randomUUID } from 'node:crypto';

const escape = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1>${body}</main>`;
const sendPage = (res, title, body) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page(title, body));
};
const redirect = (res, href) => {
  res.writeHead(303, { Location: href });
  res.end();
};
const submit = (role, name) => ({
  kind: 'click',
  target: { role, name, exact: true },
});
const goalPattern =
  /使用“(.+?)”在 (http\S+) (?:发布“([\s\S]+?)”|读取表格成文并发布)到“(.+?)”/;
const controls = (drupal, changed) => ({
  list: drupal ? '内容管理' : '文章列表',
  add: drupal ? '添加内容' : '添加新文章',
  create: drupal ? '创建日报草稿' : '创建文章草稿',
  editor: drupal ? '编辑日报' : '编辑文章',
  title: drupal ? '标题（必填）' : '文章标题',
  body: drupal ? '正文' : '文章正文',
  category: drupal ? '栏目（必填）' : '文章栏目',
  publish: changed ? '确认公开发布' : drupal ? '保存并发布' : '发布文章',
});

export const p1Cases = {
  business: ['F', 'R', 'C', 'A', 'D'],
  performance: ['F', 'R'],
  'wrong-target': ['I'],
  'unknown-result': ['U'],
  'changed-node': ['N'],
  'stop-after-upload': ['S'],
  repair: ['F', 'P', 'R'],
  automation: ['W'],
  'automation-missed': ['W'],
};

function articlePlan(source, destination) {
  const sheet = source.sheets[0];
  const read = (address) => {
    const cell = sheet.cells.find(
      (c) => c.address === address && c.status === 'value',
    );
    if (!cell) throw Error('P1_MISSING_EXCEL_CELL');
    return { sheet: sheet.name, address, quote: cell.display };
  };
  const blocks = [1, 2].map((row) => {
    const citations = [read('A' + row), read('B' + row)];
    return {
      kind: 'fact',
      text: citations[0].quote + '：' + citations[1].quote + '。',
      citations,
    };
  });
  return {
    decision: 'review',
    summary: '按固定表格成文',
    evidence: ['基于固定素材提出建议'],
    previous: null,
    action: null,
    article: { destination, blocks },
  };
}

function propose(plan, text, target) {
  if (plan.source) {
    const goal = plan.source.requirements.goal;
    const destination =
      goalPattern.exec(goal)?.[4] ?? /的“([^”]+)”/u.exec(goal)?.[1];
    if (!destination) throw Error('P1_EXCEL_GOAL_MISSING');
    return articlePlan(plan.source, destination);
  }
  const [, file, requestedEntry, requestedContent, explicitDestination] =
    goalPattern.exec(plan.goal) ?? [];
  const agreement = plan.publishingAgreement;
  const destination = agreement?.destination ?? explicitDestination;
  if ((!file && !agreement) || !destination || !target)
    throw Error('P1_GOAL_MISSING');
  const entry = agreement?.entryUrl ?? requestedEntry;
  const drupal = new URL(entry).pathname === '/p1/content';
  const names = controls(
    drupal,
    plan.controls.some((c) => c.name === '确认公开发布'),
  );
  const observed = new URL(target);
  const editor = plan.preparation?.find((f) => f.kind === 'target')?.url;
  const material = plan.materials[0];
  const pending = plan.previous;
  const currentEvidence = [
    '栏目已选择',
    '正文已填写',
    '标题已填写',
    '附件已关联',
  ].find((evidence) => text.includes(evidence));
  const observedStage = [
    names.list,
    '选择内容类型',
    '新建草稿',
    '附件库',
    names.editor,
  ].find((value) => text.includes(value));
  const base = {
    summary: '核对本次委托与页面',
    evidence: [observedStage],
    previous: null,
    action: null,
  };
  const materialProposal = {
    scope: file,
    rule: 'exact',
    name: null,
    extension: null,
    basis: `使用“${file}”`,
  };
  const candidate =
    requestedContent &&
    plan.workflows.find(
      (w) =>
        new URL(w.applicability.entryUrl).pathname === new URL(entry).pathname,
    );
  if (candidate) {
    const values = requestedContent.split('\n\n');
    return {
      ...base,
      decision: 'reuse',
      material: materialProposal,
      workflow: {
        taskId: candidate.taskId,
        version: candidate.version,
        sha256: candidate.sha256,
        content: requestedContent,
        destination,
        fields: candidate.fields.map(({ id, name, frameUrl }, index) => ({
          id,
          name,
          value: values[index],
          ...(frameUrl
            ? {
                frameUrl:
                  frameUrl === candidate.previousEditorUrl ? target : frameUrl,
              }
            : {}),
        })),
      },
    };
  }
  if (!material)
    return { ...base, decision: 'material', material: materialProposal };
  if (!requestedContent && !plan.article)
    return {
      ...base,
      decision: 'compose',
      compose: { materialId: material.id },
    };
  const act = (action, effect = 'interaction') => ({
    ...base,
    decision: 'act',
    action,
    effect,
    previous:
      pending && currentEvidence
        ? { id: pending.id, status: 'confirmed', evidence: [currentEvidence] }
        : null,
  });
  if (['/p1/posts', '/p1/content'].includes(observed.pathname))
    return act(submit('link', names.add));
  if (observed.pathname === '/p1/types') return act(submit('link', '日报'));
  if (observed.pathname === '/p1/new') {
    const fields = plan.controls.filter(
      (c) =>
        c.role === 'textbox' && c.frameUrl === target && c.readOnly === false,
    );
    if (fields.length === 0 || fields.some((f) => f.textValue !== ''))
      throw Error('P1_EMPTY_FORM_NOT_OBSERVED');
    return {
      ...act(submit('button', names.create), 'draft'),
      targetCreation: {
        rule: 'redirected-blank-editor-v1',
        fields: fields.map((f) => ({ name: f.name, value: f.textValue })),
        destination: '内容栏目',
      },
    };
  }
  const upload = plan.preparation?.find((f) => f.kind === 'upload');
  const fileIndex = /\[file (\d+)\] /.exec(text);
  const uploadFile = () => {
    if (!fileIndex) throw Error('P1_FILE_CONTROL_NOT_OBSERVED');
    return act(
      {
        kind: 'upload',
        materialId: material.id,
        target: { fileIndex: Number(fileIndex[1]) },
      },
      'upload',
    );
  };
  if (observed.pathname === '/p1/media') {
    if (!upload) return uploadFile();
    if (!text.includes('附件已关联'))
      return pending
        ? { ...base, decision: 'observe' }
        : act(submit('button', '关联到文章'));
    return act(submit('link', '返回文章'));
  }
  if (!editor || editor !== target) throw Error('P1_EDITOR_NOT_OBSERVED');
  if (!upload) return drupal ? uploadFile() : act(submit('link', '打开附件库'));
  if (!text.includes('附件已关联')) return { ...base, decision: 'wait' };
  const content = plan.article?.content ?? requestedContent;
  const [title, body] = content.split('\n\n');
  const rich = plan.controls.find((c) => c.richText?.locator);
  if (!drupal && !rich) throw Error('P1_RICH_EDITOR_NOT_OBSERVED');
  const fields = plan.publication?.fields ?? [
    { id: 'title', name: names.title, value: title },
    {
      id: 'body',
      name: names.body,
      value: body,
      ...(rich
        ? { frameUrl: rich.frameUrl, richText: rich.richText.locator }
        : {}),
    },
  ];
  const publication = {
    content,
    destination,
    fields,
    ...(plan.article ? { articleId: plan.article.id } : {}),
    attachment: { materialId: material.id, targetUrl: editor, url: upload.url },
  };
  const approvalId = plan.publication?.approvalId;
  if (!approvalId) return { ...base, decision: 'review', publication };
  const textbox = (name) => ({ role: 'textbox', name, exact: true });
  const titleControl = plan.controls.find(
    (c) => c.name === names.title && c.role === 'textbox',
  );
  const bodyControl =
    rich ??
    plan.controls.find((c) => c.name === names.body && c.role === 'textbox');
  const category = plan.controls.find(
    (c) => c.name === names.category && c.role === 'combobox',
  );
  let next;
  if (titleControl?.textValue !== title)
    next = act({ kind: 'fill', target: textbox(names.title), value: title });
  else if (bodyControl?.textValue !== body)
    next = act({
      kind: 'fill',
      target: fields[1].richText ?? textbox(names.body),
      value: body,
    });
  else if (category?.selectedLabel !== destination)
    next = act({
      kind: 'select',
      target: { role: 'combobox', name: names.category, exact: true },
      value: destination,
    });
  else next = act(submit('button', names.publish), 'publication');
  return { ...next, publication, approvalId };
}

function editorMarkup(record) {
  const { id, drupal, entry, file, linked, item } = record;
  const names = controls(drupal, record.changed);
  const root = record.changed
    ? '<section><div contenteditable="true"></div></section>'
    : '<div contenteditable="true"></div>';
  const attachment = linked
    ? `附件已关联 <a href="${file}">下载附件</a>`
    : '等待附件';
  const fileControls = drupal
    ? '<label>文件（必填）<input type="file" accept=".xlsx"></label>'
    : `<a href="/p1/media?draft=${id}">打开附件库</a>`;
  return `<p>内容栏目</p><a href="${record.editor}">编辑此草稿</a><a href="${item === 'I' ? '/p1/posts' : entry}">新建来源</a>
    <p id="attachment">${attachment}</p>${fileControls}
    <form method="post" action="/p1/publish?draft=${id}">
      <label>${names.title}<input id="title" name="title" required></label>
      ${drupal ? `<label>${names.body}<textarea id="body" name="body"></textarea></label>` : `${root}<input type="hidden" name="body">`}
      <label>${names.category}<select id="category" name="category" required><option>其他</option><option>公告</option><option>通知</option><option>简报</option></select></label>
      <button>${names.publish}</button>
    </form><p id="title-state"></p><p id="body-state"></p><p id="category-state"></p>
    <style>[contenteditable], textarea { white-space: pre-wrap; min-height: 90px; border: 1px solid #888; }</style>
    <script>
      const body=()=>document.querySelector('${drupal ? '#body' : '[contenteditable]'}');
      document.querySelector('#title').oninput=()=>{document.querySelector('#title-state').textContent='标题已填写'};
      const markBody=()=>{body().oninput=()=>{document.querySelector('#body-state').textContent='正文已填写'}};
      markBody();
      document.querySelector('#category').onchange=()=>{document.querySelector('#category-state').textContent='栏目已选择'};
      ${drupal ? uploadScript(record, true) : "document.querySelector('form').onsubmit=e=>{e.currentTarget.elements.body.value=body().innerText};"}
      ${
        item === 'N'
          ? `const poll=setInterval(async()=>{
        if(await fetch('/p1/armed?draft=${id}').then(r=>r.text())!=='yes')return;
        clearInterval(poll);body().replaceWith(body().cloneNode(true));markBody();await fetch('/p1/replaced?draft=${id}',{method:'POST'});
      },125);`
          : ''
      }
    </script>`;
}

function uploadScript(record, inline) {
  const { id, file } = record;
  return `document.querySelector('[type=file]').onchange=async e=>{
    const status=document.querySelector('#attachment');
    status.textContent='正在接收附件';
    const response=await fetch('/p1/upload?draft=${id}',{method:'POST',body:await e.target.files[0].arrayBuffer()});
    if(response.ok){
      status.innerHTML='${inline ? '附件已关联' : '附件可选'} <a href="${file}">下载附件</a>';
      ${inline ? '' : "document.querySelector('#insert').disabled=false;"}
    }
  };`;
}

export function releaseP1Fixture(receipts, mode) {
  const drafts = new Map(),
    items = new Map(),
    files = new Map();
  const allowed = p1Cases[mode];
  let modelCalls = 0;
  const record = (kind, item, details = {}) =>
    receipts.push({ kind, item, ...details, at: Date.now() });
  const post = (req, res, fn) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        fn(Buffer.concat(chunks));
      } catch (error) {
        record('p1-error', null, { code: error.message });
        res.writeHead(409);
        res.end();
      }
    });
    return true;
  };
  return (req, res, url) => {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return post(req, res, (raw) => {
        if (++modelCalls > 90) throw Error('P1_MODEL_LIMIT');
        const { messages } = JSON.parse(raw);
        const plan = JSON.parse(messages.at(-1).content);
        const text = messages.at(-2)?.content ?? '';
        const target = /页面观察[^\n]*\n(https?:\/\/[^\s]+)/u.exec(text)?.[1];
        const requested = plan.request?.text;
        const entry =
          plan.publishingAgreement?.entryUrl ??
          /在 (http\S+) /.exec(
            plan.goal ?? plan.source?.requirements.goal ?? requested ?? '',
          )?.[1];
        const item = entry ? new URL(entry).searchParams.get('item') : 'W';
        if (!allowed.includes(item)) throw Error('P1_SAMPLE_LIMIT');
        let step;
        if (mode.startsWith('automation') && requested) {
          const review = {
            decision: 'review',
            summary: '核对定时发布要求',
            previous: null,
            action: null,
          };
          if (plan.request.now) {
            const startAt = /\d{4}-\d{2}-\d{2}T[0-9:.]+Z/.exec(requested)?.[0];
            const missed = mode === 'automation-missed';
            step = {
              ...review,
              evidence: ['User request'],
              schedule: {
                zone: 'Asia/Shanghai',
                startAt,
                cadence: missed ? { kind: 'once' } : { kind: 'interval', seconds: 60 },
                overlap: 'ask',
                gap: 'ask',
                missed: missed ? 'ask' : 'latest',
                graceSeconds: missed ? 0 : 60,
                periodKey: 'date',
              },
            };
          } else {
            const [, scope, entryUrl, destination, contentRules] =
              /从“(.+?)”取唯一 xlsx，在 (http\S+) 的“(.+?)”栏目，按“(.+?)”自动发布/u.exec(
                requested,
              ) ?? [];
            step = {
              ...review,
              evidence: ['用户发布约定要求'],
              agreement: {
                selection: {
                  scope,
                  rule: 'only',
                  name: null,
                  extension: '.xlsx',
                },
                entryUrl,
                destination,
                contentRules,
                changedBytes: 'new-publication',
                period: 'once-per-material',
              },
            };
          }
        } else step = propose(plan, text, target);
        record('p1-model', item, {
          decision: step.decision,
          action: step.action?.kind,
          repair: !!plan.repair,
          content: !!plan.source,
        });
        const chunk = (delta, finish_reason) =>
          'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason }],
            ...(finish_reason === 'stop'
              ? {
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 100,
                    total_tokens: 200,
                  },
                }
              : {}),
          }) +
          '\n\n';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          chunk({ content: JSON.stringify(step) }, null) +
            chunk({}, 'stop') +
            'data: [DONE]\n\n',
        );
      });
    }
    if (!url.pathname.startsWith('/p1/')) return false;
    const item = url.searchParams.get('item');
    const params = item && '?item=' + item;
    if (allowed.includes(item)) {
      const drupal = item === 'D',
        names = controls(drupal);
      if (url.pathname === (drupal ? '/p1/content' : '/p1/posts')) {
        sendPage(
          res,
          names.list,
          `<a href="${drupal ? '/p1/types' : '/p1/new'}${params}">${names.add}</a>`,
        );
        return true;
      }
      if (url.pathname === '/p1/types' && drupal) {
        sendPage(res, '选择内容类型', `<a href="/p1/new${params}">日报</a>`);
        return true;
      }
      if (url.pathname === '/p1/new') {
        const entry = url.pathname + url.search;
        if (req.method === 'POST')
          return post(req, res, (raw) => {
            const values = new URLSearchParams(raw.toString());
            if (
              items.has(item) ||
              values.get('title') !== '' ||
              (drupal && values.get('body') !== '')
            )
              throw Error('P1_INVALID_CREATION');
            const id = randomUUID();
            const editor = `/p1/${drupal ? 'node' : 'post'}/${id}/edit`;
            const draft = {
              id,
              item,
              entry,
              editor,
              drupal,
              changed: mode === 'repair' && ['P', 'R'].includes(item),
              file: '/p1/file/' + randomUUID(),
            };
            items.set(item, draft);
            drafts.set(id, draft);
            files.set(draft.file, draft);
            record('p1-created', item, { editor, entry });
            redirect(res, editor);
          });
        sendPage(
          res,
          '新建草稿',
          `<p>内容栏目</p><form method="post" action="${entry}"><label>${names.title}<input name="title"></label>
          ${drupal ? `<label>${names.body}<textarea name="body"></textarea></label>` : ''}
          <button>${names.create}</button></form>`,
        );
        return true;
      }
    }
    const id =
      url.searchParams.get('draft') ??
      /^\/p1\/(?:node|post|result)\/([^/]+)/.exec(url.pathname)?.[1];
    const draft = drafts.get(id) ?? files.get(url.pathname);
    if (!draft) return false;
    const current = draft.item;
    if (url.pathname === draft.editor) {
      sendPage(res, controls(draft.drupal).editor, editorMarkup(draft));
      return true;
    }
    if (url.pathname === '/p1/media') {
      sendPage(
        res,
        '附件库',
        `<label>本地文件<input type="file" accept=".xlsx"></label>
        <a href="${draft.editor}">返回文章</a><p id="attachment">等待附件</p><button id="insert" disabled>关联到文章</button>
        <script>${uploadScript(draft, false)}
        document.querySelector('#insert').onclick=async()=>{
          const response=await fetch('/p1/insert?draft=${id}',{method:'POST'});
          if(response.ok)document.querySelector('#attachment').firstChild.textContent='附件已关联 ';
        };</script>`,
      );
      return true;
    }
    if (url.pathname === '/p1/upload' && req.method === 'POST')
      return post(req, res, (bytes) => {
        if (draft.bytes || bytes.length === 0 || bytes.length > 128000)
          throw Error('P1_INVALID_UPLOAD');
        draft.bytes = bytes;
        record('p1-upload', current, {
          file: draft.file,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        setTimeout(
          () => {
            if (draft.drupal) draft.linked = true;
            res.end('ok');
          },
          current === 'S' ? 2000 : 400,
        );
      });
    if (url.pathname === '/p1/insert' && req.method === 'POST')
      return post(req, res, () => {
        if (!draft.bytes || draft.linked)
          throw Error('P1_INVALID_ATTACHMENT_ASSOCIATION');
        draft.linked = true;
        record('p1-linked', current);
        res.end('ok');
      });
    if (url.pathname === draft.file && draft.bytes) {
      record('p1-download', current);
      res.end(draft.bytes);
      return true;
    }
    if (
      url.pathname === '/p1/arm' &&
      current === 'N' &&
      req.method === 'POST'
    ) {
      draft.armed = true;
      res.end('ok');
      return true;
    }
    if (url.pathname === '/p1/armed' && current === 'N') {
      res.end(draft.armed ? 'yes' : 'no');
      return true;
    }
    if (
      url.pathname === '/p1/replaced' &&
      current === 'N' &&
      req.method === 'POST'
    ) {
      record('p1-replaced', current);
      res.end('ok');
      return true;
    }
    if (url.pathname === '/p1/publish' && req.method === 'POST')
      return post(req, res, (raw) => {
        const values = Object.fromEntries(new URLSearchParams(raw.toString()));
        if (
          draft.result ||
          !draft.linked ||
          !values.title ||
          !values.body ||
          !values.category
        )
          throw Error('P1_INVALID_PUBLICATION');
        Object.assign(draft, values, { result: '/p1/result/' + id });
        record('p1-published', current, {
          ...values,
          editor: draft.editor,
          result: draft.result,
          file: draft.file,
        });
        redirect(res, draft.drupal ? draft.result : '/p1/manage?draft=' + id);
      });
    if (url.pathname === '/p1/manage' && draft.result) {
      sendPage(
        res,
        '已发布',
        `<a href="${draft.result}">${escape(draft.title)}</a>`,
      );
      return true;
    }
    if (url.pathname === draft.result) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><link rel="canonical" href="${draft.result}">
        <article><h1>${escape(draft.title)}</h1><p>${escape(current === 'U' ? '错配内容' : draft.body)}</p><p>${escape(draft.category)}</p>
        <a href="${draft.file}">下载附件</a><a href="${draft.editor}">编辑原条目</a></article>`);
      record('p1-public-read', current);
      return true;
    }
    return false;
  };
}
