// PROTOTYPE: three layouts, one in-memory scenario. No model, login, uploads or remote writes.
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHTML = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const symbols = {
  plus:'M9 3v12M3 9h12', close:'m4 4 10 10M14 4 4 14', left:'m11 4-5 5 5 5', right:'m7 4 5 5-5 5',
  check:'m3 9 4 4 8-8', chat:'M3 3h12v9H7l-4 3V3Z', send:'M9 14V3m-5 5 5-5 5 5',
  stop:'M5 5h8v8H5Z', eye:'M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5ZM7 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
  lock:'M5 8V5a4 4 0 0 1 8 0v3M3 8h12v8H3Z', file:'M4 2h7l3 3v11H4V2Zm6 0v4h4M7 10h4M7 13h4',
  grid:'M2 2h5v5H2ZM11 2h5v5h-5ZM2 11h5v5H2ZM11 11h5v5h-5Z',
  archive:'M2 4h14v3H2ZM4 7v9h10V7M7 10h4', settings:'M3 5h12M3 13h12M6 3v4m6 4v4',
  clock:'M9 4v5l3 2M9 1a8 8 0 1 0 0 16A8 8 0 1 0 9 1', replay:'M3 7a6 6 0 1 1 0 5M3 2v5h5',
  minus:'M4 9h10', grow:'M3 7V3h4m4 0h4v4M15 11v4h-4M7 15H3v-4', leaf:'M3 13C0 5 7 2 15 3c0 8-4 12-10 10m-2 3 8-10',
  arrow:'M3 9h12m-5-5 5 5-5 5', bell:'M5 13H3l2-3V6a4 4 0 0 1 8 0v4l2 3H5m2 3h4', down:'m4 7 5 5 5-5',
};
const icon = name => `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="${symbols[name] || symbols.file}"/></svg>`;
const logo = () => `<div class="logo"><span class="logo-mark">${icon('leaf')}</span>helpr<span class="wordmark-dot">.</span></div>`;
const names = {A:'标签工作台', B:'任务侧栏', C:'双页并排'};
const descriptions = {A:'顶部切换任务，悬停标签查看进度卡，右下角交流。',B:'左侧始终看见两项进度，对话靠近任务导航。',C:'同时查看两个网页，两项任务各有对话入口。'};
const defaultGoal = '把《十月经营周报.xlsx》分别发布到 WordPress 的「经营周报」和 Drupal 的「内部资料」，保留原文件供下载。';
const steps = ['读取素材','上传附件','准备发布','核对结果'];
function makeTasks() {
  return {
    A:{id:'A',site:'WordPress',short:'发布经营周报',category:'经营周报',domain:'beishan.example',title:'十月经营周报',file:'十月经营周报.xlsx',body:'本周经营数据已整理完毕，请下载附件查看完整记录。\n数据范围：10 月 5 日 — 10 月 11 日。'},
    B:{id:'B',site:'Drupal',short:'同步内部资料',category:'内部资料',domain:'team.beishan.example',title:'十月经营周报 · 内部资料',file:'十月经营周报.xlsx',body:'本周经营周报同步至内部资料库，供团队查阅。\n原始表格保留在下方附件中。'},
  };
}
let epoch = 0;
let state = {variant: ['A','B','C'].includes(new URL(location.href).searchParams.get('variant')) ? new URL(location.href).searchParams.get('variant') : 'A'};
function initialize() {
  epoch++;
  const variant=state.variant;
  state={variant,active:'A',started:false,didTakeover:false,didResume:false,modal:null,tasks:makeTasks()};
  for(const task of Object.values(state.tasks)) Object.assign(task,{
    status:'ready',progress:0,hidden:false,closed:false,minimized:false,expanded:false,draft:'',run:0,hasTaken:false,hasResumed:false,result:null,
    messages:[{role:'assistant',text:'网页已打开。发起示例委托，体验两项任务一起推进。'}],
  });
}
initialize();
const task = id => state.tasks[id];
const phase = t => Math.min(3,Math.floor(t.progress/25));
const statusName = t => ({ready:'等待委托',running:'正在执行',manual:'已让出操作',checking:'正在核对',done:'已完成',stopped:'已停止'}[t.status]);
const statusHTML = t => `<span class="status state-${t.status}"><i class="dot"></i>${statusName(t)}</span>`;
const siteIcon = t => `<span class="site-icon ${t.id==='B'?'drupal':''}">${t.id==='A'?'W':'d'}</span>`;
const visibleTasks = () => Object.values(state.tasks).filter(t=>!t.hidden&&!t.closed);
const action = (name,id='') => `data-action="${name}"${id?` data-task="${id}"`:''}`;
function taskInfo(t) {
  if(t.status==='manual') return '你正在操作网页';
  if(t.status==='checking') return '保留输入，核对当前页面';
  if(t.status==='done') return '结果已核对，可查看';
  if(t.status==='stopped') return '等待你明确继续';
  if(t.status==='ready') return '示例网页已准备';
  return steps[phase(t)];
}
function header({brand=true}={}) {
  return `<header class="app-header">
    ${brand?logo():`<span class="breadcrumb">内容发布 <span style="padding:0 7px">/</span> 本周工作</span>`}
    ${brand?'<span class="workspace-name">我的工作区</span>':''}<span class="spacer"></span>
    <span class="global-status" data-global></span>
    <button class="activity-btn" ${action('activity')} aria-label="活动任务与历史">${icon('grid')} 任务 <span class="activity-count">2</span></button>
    <button class="primary" ${action('delegate')}>${icon('plus')} 新委托</button>
  </header>`;
}
function taskTab(t) {
  return `<div class="task-tab ${state.active===t.id?'selected':''}" data-preview-tab="${t.id}">
    ${siteIcon(t)}<button class="select-task" ${action('select',t.id)} aria-label="查看任务 ${t.id}：${t.short}" aria-pressed="${state.active===t.id}">
    <div class="task-name">${t.short}</div><small data-status="${t.id}">${statusHTML(t)}</small></button>
    <button class="icon-btn preview-task" ${action('preview-toggle',t.id)} aria-label="查看任务 ${t.id} 进度" aria-haspopup="dialog" aria-expanded="false" aria-controls="task-preview-card" title="查看进度 · 点击固定，Esc 收起">${icon('down')}</button>
    <button class="icon-btn close-task" ${action('close-task',t.id)} aria-label="关闭任务 ${t.id}">${icon('close')}</button>
  </div>`;
}
function sidebarTask(t) {
  return `<section class="sidebar-task ${state.active===t.id?'selected':''}">
    <button class="select-task" ${action('select',t.id)} aria-label="查看任务 ${t.id}：${t.short}" aria-pressed="${state.active===t.id}">
      ${siteIcon(t)}<div class="task-name">${t.short}</div><span class="tiny muted">${t.site} · ${t.category}</span><br>
      <span data-status="${t.id}">${statusHTML(t)}</span>
    </button>
    <button class="icon-btn close-task" ${action('close-task',t.id)} aria-label="关闭任务 ${t.id}">${icon('close')}</button>
    <div class="progress-track"><div class="progress-fill" data-progress="${t.id}" style="width:${t.progress}%"></div></div>
    <div class="step-list" data-steps="${t.id}">${stepList(t)}</div>
  </section>`;
}
function stepList(t) {
  return steps.map((s,i)=>`<div class="${t.progress>=(i+1)*25?'complete':i===phase(t)&&t.status!=='ready'?'current':''}"><span class="step-circle"></span>${s}${t.progress>=(i+1)*25?' · 已完成':''}</div>`).join('');
}
// A keeps tabs as navigation. The progress card only observes the same task state.
const taskPreview={id:null,pinned:false,openTimer:null,closeTimer:null};
function syncPreviewTrigger() {
  $$('.preview-task').forEach(el=>{
    const open=el.dataset.task===taskPreview.id;
    el.setAttribute('aria-expanded',String(open));
    el.classList.toggle('preview-pinned',open&&taskPreview.pinned);
  });
}
function closePreview(restoreFocus=false) {
  clearTimeout(taskPreview.openTimer);clearTimeout(taskPreview.closeTimer);
  const trigger=$('[data-action="preview-toggle"][data-task="'+taskPreview.id+'"]');
  taskPreview.id=null;taskPreview.pinned=false;
  $('#task-preview-layer').innerHTML='';
  syncPreviewTrigger();
  if(restoreFocus)trigger?.focus();
}
function positionPreview() {
  const card=$('#task-preview-card'),anchor=$('[data-preview-tab="'+taskPreview.id+'"]');
  if(!card||!anchor)return;
  const box=anchor.getBoundingClientRect();
  card.style.left=Math.max(8,Math.min(box.left,innerWidth-card.offsetWidth-8))+'px';
  card.style.top=Math.max(8,box.bottom+8)+'px';
  card.style.maxHeight=Math.max(160,innerHeight-box.bottom-24)+'px';
}
function showPreview(id,pinned=false) {
  clearTimeout(taskPreview.openTimer);clearTimeout(taskPreview.closeTimer);
  if(state.variant!=='A'||state.modal||task(id).hidden||task(id).closed)return;
  if(taskPreview.id===id){taskPreview.pinned=pinned||taskPreview.pinned;syncPreviewTrigger();return;}
  const t=task(id);
  taskPreview.id=id;taskPreview.pinned=pinned;
  $('#task-preview-layer').innerHTML=`<section id="task-preview-card" class="task-preview" role="dialog" aria-labelledby="preview-title" data-preview-card="${id}">
    <header class="preview-header">${siteIcon(t)}<div class="spacer"><h2 id="preview-title">${t.short}</h2><span>${t.site} · ${t.category}</span></div><button class="icon-btn" ${action('preview-close')} aria-label="收起进度卡片">${icon('close')}</button></header>
    <div class="preview-progress"><div class="preview-status"><span data-status="${id}">${statusHTML(t)}</span><span data-percent="${id}">${t.progress}%</span></div>
      <div class="progress-track"><div class="progress-fill" data-progress="${id}" style="width:${t.progress}%"></div></div>
      <div class="step-list" data-steps="${id}">${stepList(t)}</div>
    </div>
    <div class="preview-update"><span>最近动态</span><p data-preview-update="${id}">${escapeHTML(t.messages.at(-1).text)}</p></div>
    <footer><span data-caption="${id}">${taskInfo(t)}</span><button class="preview-open" ${action('select',id)}>查看任务 ${id} ${icon('arrow')}</button></footer>
  </section>`;
  positionPreview();syncPreviewTrigger();
}
function queuePreview(id) {
  if(taskPreview.pinned)return;
  clearTimeout(taskPreview.openTimer);clearTimeout(taskPreview.closeTimer);
  taskPreview.openTimer=setTimeout(()=>showPreview(id),280);
}
function queuePreviewClose() {
  clearTimeout(taskPreview.openTimer);clearTimeout(taskPreview.closeTimer);
  if(taskPreview.pinned)return;
  taskPreview.closeTimer=setTimeout(()=>{
    if(!document.activeElement?.closest('.task-preview'))closePreview();
  },180);
}
function siteMenu(t) {
  return `<nav class="site-menu" aria-label="模拟网站导航">
    <div class="site-brand"><span class="wp-logo">${t.id==='A'?'W':'d'}</span><span>北山工作室</span></div>
    ${[['grid','概览'],['file',t.id==='A'?'文章':'内容'],['archive','媒体库'],['chat','评论'],['settings','设置']].map(([i,l],n)=>`<div class="menu-item ${n===1?'selected':''}">${icon(i)}<span class="menu-label">${l}</span></div>`).join('')}
  </nav>`;
}
function website(t) {
  return `<div class="page-space ${t.id==='B'?'drupal-page':''}" data-web="${t.id}" aria-label="任务 ${t.id} 的模拟网页">
    ${siteMenu(t)}
    <div class="site-content">
      <div class="page-header"><div><div class="breadcrumb">${t.id==='A'?'文章 / 编辑文章':'内容管理 / 基本页面'}</div><h2>${t.id==='A'?'编辑文章':'编辑内部资料'}</h2></div>
        <span class="spacer"></span><button class="website-btn" ${action('web-preview',t.id)}>${icon('eye')} 预览</button>
      </div>
      <div class="web-columns"><article class="editor-sheet">
        <div class="editor-kicker"><span>${t.id==='A'?'北山工作室 · 经营记录':'TEAM KNOWLEDGE · 资料库'}</span><span data-web-status="${t.id}">草稿</span></div>
        ${t.id==='B'?'<label class="web-field-label" for="title-B">标题</label>':''}
        <input id="title-${t.id}" class="web-title" data-field="title" data-task="${t.id}" aria-label="任务 ${t.id} 网页标题" value="${escapeHTML(t.title)}" autocomplete="off">
        <p class="editor-summary">${t.id==='A'?'经营周报 / 2026 年 10 月':'资料归档 / 2026 年 10 月'}</p>
        ${t.id==='B'?'<label class="web-field-label" for="body-B">正文</label>':''}
        <textarea id="body-${t.id}" class="web-body" data-field="body" data-task="${t.id}" aria-label="任务 ${t.id} 网页正文">${escapeHTML(t.body)}</textarea>
        <div class="file-card"><span class="excel-icon">X</span><div><div class="file-name">${t.file}</div><div class="file-meta">Excel 工作表 · 78 KB · 本机素材</div></div><span class="file-status" data-file-status="${t.id}">等待上传</span></div>
        <div class="post-meta"><span class="mini-check">${icon('check')}</span>${t.id==='A'?'北山工作室':'运营团队'}<span class="spacer"></span>${t.category}</div>
      </article>
      <aside class="site-details"><h3>${t.id==='A'?'文章设置':'页面信息'}</h3><div class="detail-row"><span>栏目</span><strong>${t.category}</strong></div><div class="detail-row"><span>状态</span><strong data-web-status="${t.id}">草稿</strong></div><div class="detail-row"><span>可见性</span><strong>${t.id==='A'?'公开':'团队成员'}</strong></div><h3>附件</h3><div class="detail-row"><span>原始文件</span><strong>保留下载</strong></div></aside>
      </div>
    </div>
  </div>`;
}
function chatMessages(t) {
  return t.messages.map(m=>`<div class="message ${m.role}">${m.role==='assistant'?'<small>helpr</small>':''}${escapeHTML(m.text)}</div>`).join('');
}
function chatActions(t) {
  if(t.status==='ready') return `<button class="primary" ${action('delegate')}>使用示例委托 ${icon('arrow')}</button>`;
  if(t.status==='manual'||t.status==='stopped') return `<button class="primary" ${action('resume',t.id)}>${icon('arrow')} 核对并继续</button><span class="tiny muted">保留当前网页</span>`;
  if(t.status==='done') return `<button class="primary" ${action('result',t.id)}>查看结果 ${icon('right')}</button><span class="tiny muted">只完成本项任务</span>`;
  return `<span class="tiny muted">${t.status==='checking'?'正在核对你留下的页面…':'直接操作网页即可接管'}</span><span class="spacer"></span><button class="text-btn" ${action('stop',t.id)}>${icon('stop')} 停止</button>`;
}
function chat(t) {
  if(t.minimized) return `<button class="chat-bubble" ${action('expand-chat',t.id)} aria-label="展开任务 ${t.id} 对话">${icon('chat')} ${t.short}<span data-status="${t.id}">${statusHTML(t)}</span></button>`;
  return `<section class="floating-chat ${!t.expanded?'compact':''}" data-chat="${t.id}" aria-label="任务 ${t.id} 的独立对话">
    <header class="chat-header"><span class="chat-avatar">${t.id}</span><div><strong>${t.short}</strong><div class="tiny">此处消息只发给任务 ${t.id}</div></div><span class="spacer"></span>
      ${state.variant==='C'?`<button class="icon-btn" ${action('toggle-chat',t.id)} aria-label="${t.expanded?'收起':'展开'}任务 ${t.id} 对话记录">${icon(t.expanded?'minus':'grow')}</button>`:''}
      <button class="icon-btn" ${action('minimize-chat',t.id)} aria-label="最小化任务 ${t.id} 对话">${icon('minus')}</button></header>
    <div class="chat-feed" data-feed="${t.id}">${chatMessages(t)}</div>
    ${state.variant==='C'&&!t.expanded?`<p class="chat-peek"><button ${action('toggle-chat',t.id)} data-peek="${t.id}">${escapeHTML(t.messages.at(-1).text)}</button></p>`:''}
    <div class="chat-progress"><div class="progress-caption"><span data-caption="${t.id}">${taskInfo(t)}</span><span data-percent="${t.id}">${t.progress}%</span></div><div class="progress-track"><div class="progress-fill" data-progress="${t.id}" style="width:${t.progress}%"></div></div></div>
    <div class="chat-actions" data-chat-actions="${t.id}">${chatActions(t)}</div>
    <form class="chat-compose" data-send="${t.id}"><textarea rows="1" data-draft="${t.id}" aria-label="给任务 ${t.id} 发消息" placeholder="说说你的要求，或输入「继续」">${escapeHTML(t.draft)}</textarea><button class="send-btn" aria-label="发送给任务 ${t.id}">${icon('send')}</button></form>
  </section>`;
}
function frame(t) {
  return `<section class="frame" data-frame="${t.id}">
    <div class="browser-bar">${icon('left')} ${icon('right')}<span class="address">${icon('lock')}${t.domain} / ${t.id==='A'?'wp-admin/post.php':'node/weekly/edit'}</span><span class="spacer"></span><span class="site-tag">模拟网页</span></div>
    <div class="takeover-line" data-takeover="${t.id}" ${t.status==='manual'?'':'hidden'}>${icon('eye')} 你正在操作此网页，helpr 已让出。另一项任务不受影响。</div>
    ${website(t)}${chat(t)}
  </section>`;
}
function empty() {
  return `<div class="empty-stage"><h2>工作区暂时收起来了</h2><span>任务保留原来的状态，可以随时回来查看。</span><button class="secondary" ${action('activity')}>查看活动任务与历史</button></div>`;
}
function VariantA() {
  const ts=visibleTasks();
  return header()+`<nav class="task-tabs" aria-label="任务标签页">${ts.map(taskTab).join('')}<span class="spacer"></span><button class="icon-btn" style="align-self:center" ${action('delegate')} aria-label="新建委托">${icon('plus')}</button></nav>`+(ts.length?frame(task(state.active)):empty());
}
function VariantB() {
  return `<div class="variant-b"><aside class="task-sidebar">${logo()}<div class="sidebar-heading"><span>本周内容发布</span><span>2 项任务</span></div>
    ${visibleTasks().map(sidebarTask).join('')}
    <div class="sidebar-footer"><button class="activity-btn" ${action('activity')}>${icon('archive')} 活动与历史</button><div class="flex">${icon('lock')} 本机工作区 · 界面预览</div></div>
    </aside><div class="sidebar-main">${header({brand:false})}${visibleTasks().length?frame(task(state.active)):empty()}</div></div>`;
}
function VariantC() {
  return `<div class="variant-c">${header()}<div class="parallel-overview">${icon('grid')}<strong>两项任务，一起看</strong><span>每个网页保留自己的对话与操作</span><span class="spacer"></span><span data-global></span></div>
    <div class="parallel-grid">${Object.values(state.tasks).map(t=>`<div class="parallel-pane">
      <header data-pane-head="${t.id}" class="pane-heading ${state.active===t.id?'active':''}">${siteIcon(t)}<div><div class="task-name">${t.short}</div><span data-status="${t.id}">${statusHTML(t)}</span></div><span class="spacer"></span><button class="icon-btn" ${action('close-task',t.id)} aria-label="关闭任务 ${t.id}">${icon('close')}</button></header>
      ${t.hidden||t.closed?`<div class="closed-pane">${icon('archive')}<span>${t.closed?'已归入历史':'任务已收起'}</span><button class="secondary" ${action('reopen',t.id)}>重新查看</button></div>`:frame(t)}</div>`).join('')}</div></div>`;
}
function render() {
  closePreview();
  const ts=visibleTasks();
  if(ts.length&&!ts.some(t=>t.id===state.active)) state.active=ts[0].id;
  document.body.dataset.variant=state.variant;
  $('#app').innerHTML=({A:VariantA,B:VariantB,C:VariantC}[state.variant])();
  renderSwitcher();
  update();
  for(const t of Object.values(state.tasks)) refreshMessages(t);
}
function renderSwitcher() {
  $('#variant-switcher').innerHTML=`<div class="dock-hint">${descriptions[state.variant]} 切换保留本轮进度</div><nav class="scheme-dock" aria-label="比较三种方案"><button class="arrow" ${action('previous')} aria-label="上一个方案">${icon('left')}</button>
  ${Object.entries(names).map(([id,n])=>`<button class="scheme-choice" data-action="variant" data-variant="${id}" aria-pressed="${state.variant===id}"><strong>${id}</strong>${n}</button>`).join('')}
  <button class="arrow" ${action('next')} aria-label="下一个方案">${icon('right')}</button></nav>`;
}
function renderGuide() {
  const allDone=Object.values(state.tasks).every(t=>t.status==='done');
  let no=1,title='发起委托',detail='从一段话开始，把工作交给 helpr。';
  if(state.started){no=2;title='查看两项任务进度';detail='点击网页里的标题，试着改几个字。';}
  if(state.didTakeover){no=3;title='已接管当前网页';detail='改好文字后，在这项任务的对话中发送「继续」。';}
  if(state.didResume){no=4;title='核对后继续';detail='手动修改会保留，可以等待完成或快进查看结果。';}
  if(Object.values(state.tasks).some(t=>t.status==='manual')){no=3;title='已接管当前网页';detail='改好文字后，在这项任务的对话中发送「继续」。';}
  if(Object.values(state.tasks).some(t=>t.status==='stopped')){no=3;title='任务已停止';detail='重新查看保持停止，明确继续后才核对并恢复。';}
  if(allDone){no=5;title='结果已就绪';detail='分别查看两项结果，也可以切换方案比较布局。';}
  const button=!state.started?`<button class="primary" ${action('delegate')}>开始演示 ${icon('arrow')}</button>`:state.didResume&&!allDone?`<button class="text-btn" ${action('advance')}>快进到结果 ${icon('right')}</button>`:'';
  $('#lab-guide').innerHTML=`<div class="lab-guide"><span class="lab-label">界面原型 · 模拟数据</span><div class="guide-copy"><span class="step-no">${no}</span><span class="guide-title">${title}</span><span class="guide-detail">${detail}</span></div><span class="spacer"></span>${button}<button class="text-btn" ${action('help')}>使用说明</button><button class="icon-btn" ${action('reset')} aria-label="重置演示" title="重置演示">${icon('replay')}</button></div>`;
}
function update() {
  for(const t of Object.values(state.tasks)) {
    $$('[data-status="'+t.id+'"]').forEach(el=>el.innerHTML=statusHTML(t));
    $$('[data-progress="'+t.id+'"]').forEach(el=>el.style.width=t.progress+'%');
    $$('[data-caption="'+t.id+'"]').forEach(el=>el.textContent=taskInfo(t));
    $$('[data-percent="'+t.id+'"]').forEach(el=>el.textContent=t.progress+'%');
    $$('[data-steps="'+t.id+'"]').forEach(el=>el.innerHTML=stepList(t));
    $$('[data-chat-actions="'+t.id+'"]').forEach(el=>el.innerHTML=chatActions(t));
    $$('[data-takeover="'+t.id+'"]').forEach(el=>el.hidden=t.status!=='manual');
    $$('[data-file-status="'+t.id+'"]').forEach(el=>el.textContent=t.progress>=26?'已上传':'等待上传');
    $$('[data-web-status="'+t.id+'"]').forEach(el=>el.textContent=t.status==='done'?'已发布':'草稿');
  }
  const running=Object.values(state.tasks).filter(t=>['running','checking'].includes(t.status)).length;
  const done=Object.values(state.tasks).filter(t=>t.status==='done').length;
  $$('[data-global]').forEach(el=>el.textContent=running?running+' 项正在推进':done===2?'本轮工作已完成':'每项任务独立处理');
  renderGuide();
}
function refreshMessages(t) {
  $$('[data-feed="'+t.id+'"]').forEach(el=>{el.innerHTML=chatMessages(t);el.scrollTop=el.scrollHeight;});
  $$('[data-peek="'+t.id+'"]').forEach(el=>el.textContent=t.messages.at(-1).text);
  $$('[data-preview-update="'+t.id+'"]').forEach(el=>el.textContent=t.messages.at(-1).text);
}
function message(t,text,role='assistant') { t.messages.push({role,text});refreshMessages(t); }
let toastTimer;
function toast(text) {
  clearTimeout(toastTimer);
  const el=$('#toast');el.textContent=text;el.classList.add('visible');
  toastTimer=setTimeout(()=>el.classList.remove('visible'),3000);
}
function changeVariant(v) {
  state.variant=v;
  const url=new URL(location.href);url.searchParams.set('variant',v);history.replaceState(null,'',url);
  render();
  console.info('Prototype variant',v,Object.values(state.tasks).map(t=>({task:t.id,status:t.status,progress:t.progress,title:t.title,hidden:t.hidden,closed:t.closed})));
}
function cycle(direction) { const ids=['A','B','C'];changeVariant(ids[(ids.indexOf(state.variant)+direction+3)%3]); }
function takeover(id) {
  const t=task(id);
  state.active=id;
  $$('[data-pane-head]').forEach(el=>el.classList.toggle('active',el.dataset.paneHead===id));
  if(t.status==='running'||t.status==='checking') {
    t.status='manual';t.run++;t.hasTaken=true;state.didTakeover=true;
    message(t,'已让出操作。你可以直接修改网页；准备好后，告诉我“继续”。');
    update();
    toast('任务 '+id+' 已让出，另一项任务保持原来的状态。');
  }
}
function resume(id) {
  const t=task(id);
  if(t.status==='done'){message(t,'这项工作已经完成，结果保留在这里，不会再次发布。');return;}
  if(!['manual','stopped'].includes(t.status)){message(t,'当前'+taskInfo(t)+'，你可以继续查看网页。');return;}
  t.status='checking';t.run++;const run=t.run;const currentEpoch=epoch;
  message(t,'我会先核对当前网页和已有结果，保留你修改的文字。');update();
  setTimeout(()=>{
    if(epoch!==currentEpoch||t.run!==run||t.status!=='checking')return;
    t.status='running';t.hasResumed=true;state.didResume=true;
    message(t,'已核对当前页面。将保留“'+t.title+'”，继续剩余步骤。');update();
  },1100);
}
function stop(id) {
  const t=task(id);if(['done','ready','stopped'].includes(t.status))return;
  t.status='stopped';t.run++;message(t,'已停止。网页和已完成的部分都保留；明确说“继续”后，我会先核对再续做。');update();
}
function finish(t) {
  if(t.status!=='running')return;
  t.status='done';t.progress=100;t.result={title:t.title,body:t.body,file:t.file,category:t.category,site:t.site};
  message(t,'已完成“'+t.title+'”。附件与栏目已核对，结果可在这里查看。');update();
}
function tick() {
  if(!state.started)return;
  for(const t of Object.values(state.tasks)) {
    if(t.status!=='running')continue;
    const previousPhase=phase(t);
    const cap=t.id==='A'&&!t.hasTaken&&!t.hasResumed?65:100;
    t.progress=Math.min(cap,t.progress+(t.id==='A'?3:4));
    if(t.progress>=100){finish(t);continue;}
    if(phase(t)!==previousPhase) message(t,['已找到这次使用的表格。','原始 Excel 已上传，正在填写页面。','附件与栏目已经就位，正在准备发布。','正在核对发布位置和附件。'][phase(t)]);
  }
  update();
}


let previousFocus;
function openModal(name,title,content,footer='') {
  closePreview();
  previousFocus=document.activeElement;state.modal=name;
  $('#overlay').innerHTML=`<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><h2 id="modal-title">${title}</h2><span class="spacer"></span><button class="icon-btn" ${action('dismiss')} aria-label="关闭弹窗">${icon('close')}</button></header>${content}${footer}</section></div>`;
  requestAnimationFrame(()=>($('.modal textarea')||$('.modal button'))?.focus());
}
function dismiss() {
  $('#overlay').innerHTML='';state.modal=null;
  if(previousFocus?.isConnected) previousFocus.focus();
}
function delegation() {
  openModal('delegate','交给 helpr 一件事',`<p>用一句话说明目标。两项任务会各自推进，分别保留网页、对话和结果。</p>
    <form data-delegate><label class="tiny muted" for="delegation">这次想完成什么？</label><textarea id="delegation" class="delegation-input">${escapeHTML(defaultGoal)}</textarea>
    ${Object.values(state.tasks).map(t=>`<div class="example-task">${siteIcon(t)}<div><strong class="task-name">${t.short}</strong><br><small>${t.site} · ${t.category}</small></div><span class="spacer"></span><span class="tiny muted">独立任务 ${t.id}</span></div>`).join('')}
    <div class="modal-footer"><span class="muted">${state.started?'重新开始会重置本轮模拟任务。':'此演示固定使用这两项示例任务。'}</span><button type="submit" class="primary">${state.started?'重新开始演示':'开始两项任务'} ${icon('arrow')}</button></div></form>`);
}
function startTasks(goal) {
  initialize();state.started=true;
  for(const t of Object.values(state.tasks)) {
    t.status='running';t.progress=t.id==='A'?12:8;
    t.messages=[{role:'user',text:goal},{role:'assistant',text:'我负责'+t.site+'的「'+t.category+'」。会上传原始 Excel，并核对发布结果。'}];
  }
  dismiss();render();toast('两项任务已开始。点击网页里的标题，就可以接管这一项。');
}
function activity() {
  openModal('activity','活动任务与历史',`<p>收起和重新查看只改变展示；停止的任务仍保持停止。</p>${Object.values(state.tasks).map(t=>`<div class="activity-row">${siteIcon(t)}<div class="spacer"><div class="task-name">${t.short}</div><span data-status="${t.id}">${statusHTML(t)}</span><span class="tiny muted"> · ${t.closed?'历史记录':t.hidden?'已收起':'在工作区'}</span></div><button class="secondary" ${action('reopen',t.id)}>查看任务 ${t.id}</button></div>`).join('')}`);
}
function result(id,preview=false) {
  const t=task(id);const r=t.result||t;
  openModal(preview?'preview':'result',preview?'网页预览':'任务 '+id+' · 完成结果',`
    <div class="result-hero"><span class="status state-done">${icon(preview?'eye':'check')} ${preview?'当前草稿预览':'模拟发布完成'}</span><h3>${escapeHTML(r.title)}</h3><span class="tiny muted">${t.domain} / ${t.category}</span></div>
    <div class="result-body">${escapeHTML(r.body)}</div>
    <div class="result-row"><span>目标位置</span><strong>${t.site} / ${r.category}</strong></div>
    <div class="result-row"><span>原始附件</span><strong>${r.file}</strong></div>
    <div class="result-row"><span>手动修改</span><strong>${t.hasTaken?'已保留本次网页中的文字':'本轮没有手动修改'}</strong></div>
    <p class="tiny">这是界面原型的模拟结果，未向网站发布，也未上传本机文件。</p>`,
    `<div class="modal-footer"><button class="primary" ${action('dismiss')}>返回工作区</button></div>`);
}
function closeTask(id,anchor) {
  closePreview();
  const t=task(id);
  if(['ready','done','stopped'].includes(t.status)){t.closed=true;render();toast('已关闭标签页，可从活动与历史重新查看。');return;}
  state.modal='close';previousFocus=anchor;
  const box=anchor.getBoundingClientRect();
  $('#overlay').innerHTML=`<section class="close-popover" role="dialog" aria-label="关闭任务 ${id}" style="left:${Math.max(8,Math.min(box.left-180,innerWidth-293))}px;top:${Math.min(box.bottom+8,innerHeight-190)}px"><strong>“${t.short}”${t.status==='manual'?'由你接管中':'还未完成'}</strong><p>${t.status==='manual'?'收起后保留网页，等你明确说“继续”再推进。':'收起后保持当前状态，可从活动任务随时返回。'}</p><div class="flex"><button class="secondary" ${action('hide',id)}>收起任务</button><button class="stop-btn" ${action('stop-close',id)}>停止任务</button></div></section>`;
  $('.close-popover .secondary')?.focus();
}
function hideTask(id) {
  const t=task(id);if(t.status==='done')t.closed=true;else t.hidden=true;
  dismiss();render();toast('任务 '+id+' 已收起，原来的状态会保留。');
}
function reopen(id) { const t=task(id);t.hidden=false;t.closed=false;state.active=id;dismiss();render(); }
function help() {
  openModal('help','这样比较三个方案',`<ol class="help-list">
      <li>点「开始演示」，发送示例委托。</li><li>观察两个任务的进度；在网页标题里改几个字。</li>
      <li>对应任务会显示「已让出操作」，另一项继续。</li><li>在这项任务的对话中发送「继续」，或点「核对并继续」。</li>
      <li>点顶部「快进到结果」，再分别查看两项结果。</li>
    </ol><p>底部 A / B / C 随时切换，同一轮任务、输入和对话会保留。键盘 ← → 也能切换，输入文字时不会抢按键。</p>
    <p>A 方案：悬停顶部标签，可查看这项任务的进度、步骤和最近动态，不切换网页。移入卡片可继续阅读；点击标签或卡片里的「查看任务」才切换。标签上的小箭头可固定打开卡片，Esc 或点击外部收起。键盘聚焦标签后按 ↓ 也可打开。</p>
    <p>任务 A 会在发布前留出时间，等你体验接管。需要重来时，点顶部重置图标。刷新页面会重置模拟任务，保留所选方案。</p>
    <p>这里只比较界面。网页、进度和回复都是模拟，不验证真实浏览器接管或发布能力。</p>`);
}
function send(id) {
  const t=task(id);const text=t.draft.trim();if(!text)return;
  t.draft='';const input=$('[data-draft="'+id+'"]');if(input)input.value='';
  if(!state.started){startTasks(text);return;}
  message(t,text,'user');
  if(['继续','继续吧','核对并继续','继续任务'].includes(text))resume(id);
  else if(['停止','停止任务','停下'].includes(text))stop(id);
  else {
    const response=t.status==='manual'?'网页仍由你操作，准备好后可以说“继续”。':t.status==='done'?'这项工作已完成，可以点击“查看结果”。':'当前'+taskInfo(t)+'。';
    message(t,response+' 这条消息只保留在任务 '+id+' 的对话中。');
  }
  input?.focus();
}
const handlers = {
  delegate:()=>delegation(), activity:()=>activity(), help:()=>help(), dismiss:()=>dismiss(),
  select:id=>{state.active=id;render();},
  'preview-toggle':(id,el,event)=>{
    if(taskPreview.id===id&&taskPreview.pinned){closePreview();return;}
    showPreview(id,true);
    if(event.detail===0)$('#task-preview-card .preview-open')?.focus();
  },
  'preview-close':()=>closePreview(true),
  previous:()=>cycle(-1), next:()=>cycle(1),
  variant:(_,el)=>changeVariant(el.dataset.variant),
  reset:()=>{dismiss();initialize();render();toast('已重置，三种方案使用同一组示例任务。');},
  stop:id=>stop(id), resume:id=>resume(id),
  'web-preview':id=>result(id,true), result:id=>result(id),
  'close-task':(id,el)=>closeTask(id,el), hide:id=>hideTask(id),
  'stop-close':id=>{stop(id);task(id).closed=true;dismiss();render();},
  reopen:id=>reopen(id),
  'minimize-chat':id=>{task(id).minimized=true;render();},
  'expand-chat':id=>{task(id).minimized=false;task(id).expanded=true;render();},
  'toggle-chat':id=>{task(id).expanded=!task(id).expanded;render();},
  advance:()=>{
    for(const t of Object.values(state.tasks)) if(t.status==='running')finish(t);
    toast(Object.values(state.tasks).some(t=>['manual','stopped','checking'].includes(t.status))?'接管、停止或核对中的任务保持原状态。':'本轮模拟任务已完成，可以分别查看结果。');
  },
};
document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');
  if(el){handlers[el.dataset.action]?.(el.dataset.task,el,event);return;}
  if(event.target.matches('[data-backdrop]'))dismiss();
});
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('[data-preview-tab],.task-preview'))closePreview();
  if($('.close-popover')&&!event.target.closest('.close-popover')&&!event.target.closest('[data-action="close-task"]'))dismiss();
  const web=event.target.closest('[data-web]');
  if(web&&event.button===0)takeover(web.dataset.web);
});
document.addEventListener('pointerover',event=>{
  if(event.pointerType==='touch')return;
  const tab=event.target.closest('[data-preview-tab]');
  if(tab&&!tab.contains(event.relatedTarget))queuePreview(tab.dataset.previewTab);
  if(event.target.closest('.task-preview'))clearTimeout(taskPreview.closeTimer);
});
document.addEventListener('pointerout',event=>{
  if(event.pointerType==='touch')return;
  const source=event.target.closest('[data-preview-tab],.task-preview');
  if(!source||source.contains(event.relatedTarget))return;
  const next=event.relatedTarget;
  if(next?.closest?.('.task-preview')||next?.closest?.('[data-preview-tab]')?.dataset.previewTab===taskPreview.id)return;
  queuePreviewClose();
});
document.addEventListener('focusout',event=>{
  if(!event.target.closest('.task-preview'))return;
  requestAnimationFrame(()=>{
    const next=document.activeElement;
    if(!next?.closest('.task-preview')&&!next?.closest('[data-preview-tab]'))closePreview();
  });
});
window.addEventListener('resize',positionPreview);
window.addEventListener('scroll',positionPreview);
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.dataset.draft)task(el.dataset.draft).draft=el.value;
  if(el.dataset.field){const t=task(el.dataset.task);takeover(t.id);t[el.dataset.field]=el.value;}
});
for(const kind of ['compositionstart','paste'])document.addEventListener(kind,event=>{
  const web=event.target.closest('[data-web]');if(web)takeover(web.dataset.web);
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.matches('[data-delegate]')) {
    const goal=$('#delegation').value.trim();
    if(goal)startTasks(goal);
    else $('#delegation').focus();
  }
  if(event.target.dataset.send)send(event.target.dataset.send);
});
document.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'){
    if(taskPreview.id){event.preventDefault();closePreview(!!event.target.closest('.task-preview'));return;}
    dismiss();return;
  }
  const previewTab=event.target.closest('[data-preview-tab]');
  if(event.key==='ArrowDown'&&previewTab&&!state.modal){
    event.preventDefault();showPreview(previewTab.dataset.previewTab,true);
    $('#task-preview-card .preview-open')?.focus();return;
  }
  if(event.target.dataset?.draft&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();send(event.target.dataset.draft);return;}
  const modal=$('.modal');
  if(modal&&event.key==='Tab'){
    const items=$$('button,input,textarea,select,[tabindex="0"]',modal).filter(el=>!el.disabled);
    const first=items[0],last=items.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  if(event.target.closest('input,textarea,select,[contenteditable="true"]')||state.modal)return;
  if(event.key==='ArrowLeft'){event.preventDefault();cycle(-1);}
  if(event.key==='ArrowRight'){event.preventDefault();cycle(1);}
});
window.addEventListener('popstate',()=>{
  const v=new URL(location.href).searchParams.get('variant');if(names[v]){state.variant=v;render();}
});
render();
setInterval(tick,2500);
