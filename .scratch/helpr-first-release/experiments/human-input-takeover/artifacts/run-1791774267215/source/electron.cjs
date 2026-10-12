// 一次性 HITL 实验；任务控制复用既有模块，不作为产品实现。
const {app,BrowserWindow,WebContentsView,ipcMain,clipboard}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {performance}=require('node:perf_hooks');
const {pathToFileURL}=require('node:url');
const {chromium}=require('../visible-page-control/node_modules/playwright');
const native=require('./build/input-monitor.node');
const out=process.env.TAKEOVER_OUT;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rows=[],checks=[],nativeRows=[],domRows=[],humanStops={};
const statuses={A:'准备中',B:'准备中'},controls={},pages={},views={},loops={};
const counts={A:{auto:0,manual:0,late:0,accepted:0},B:{auto:0,manual:0,late:0,accepted:0}};
let win,server,browser,phase='prepare',mode='automatic',viewMode='split',origin,stopping=false,commandBusy=false;
let chatted=false,viewSamples=new Set(),phaseStart=0,acceptedDelay=700;
const started=performance.now();
const state={phaseLabel:'自动准备',instruction:'正在核对来源、取消和并行。',chatHelp:'准备完成后按窗口指引操作。'};
function log(row){const entry={seq:rows.length+1,at:new Date().toISOString(),ms:Math.round((performance.now()-started)*100)/100,mode,phase,...row};rows.push(entry);fs.appendFileSync(out+'/events.jsonl',JSON.stringify(entry)+'\n');return entry;}
function save(name,value){fs.writeFileSync(out+'/'+name,JSON.stringify(value,null,2)+'\n');}
function broadcast(){const full={...state,a:statuses.A,b:statuses.B,phase,mode,viewMode};for(const wc of [win?.webContents,views.chat?.webContents])if(wc&&!wc.isDestroyed())wc.send('lab-state',full);save('status.json',{...full,humanStops,checks,counts});}
function setGuide(label,instruction,chatHelp){Object.assign(state,{phaseLabel:label,instruction,chatHelp});broadcast();}
function check(name,condition,detail={}){const row=log({kind:'assertion',name,pass:Boolean(condition),detail});checks.push(row);save('checks.json',checks);if(!condition)throw Error('check failed: '+name);}
async function until(predicate,label,timeout=5000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('timeout: '+label);await sleep(15);}}
function layout(){if(!win)return;const [width,height]=win.getContentSize(),top=108,half=Math.floor(width/2);for(const t of ['A','B']){views[t]?.setVisible(viewMode==='split'||viewMode===t);views[t]?.setBounds({x:viewMode==='split'&&t==='B'?half:0,y:top,width:viewMode==='split'?half:width,height:height-top});}views.chat?.setBounds({x:width-412,y:height-292,width:400,height:280});}
function registerNativeViews(reason){
 // 登记具体原生视图前，两页必须都在已知布局中；重载后重新取得当前 NSView，不沿用旧的命中结果。
 if(viewMode!=='split')throw Error('native-registration-requires-split-view');
 native.stop();native.install(win.getNativeWindowHandle(),onNative);
 const [width,height]=win.getContentSize();
 const tags={A:native.tag('A',100,170),B:native.tag('B',width/2+100,170),chat:native.tag('chat',width-150,height-100),shell:native.tag('shell',400,30)};
 log({kind:'native-tags',reason,tags,size:{width,height}});return tags;
}
async function reloadTaskDocuments(){
 if(Object.values(controls).some(control=>control.active))throw Error('reload-requires-settled-tasks');
 viewMode='split';layout();
 for(const task of ['A','B']){await pages[task].reload();await pages[task].waitForFunction(()=>Boolean(window.lab));}
 registerNativeViews('after-owned-task-reload');
}
async function snapshot(task,reason){const value=await pages[task].evaluate(()=>window.lab.snapshot());log({kind:'page-observed',task,reason,value});return value;}
async function capture(name){if(win&&!win.isDestroyed()){const image=await win.capturePage();fs.writeFileSync(out+'/'+name+'.png',image.toPNG());}}
function stop(task,reason){log({kind:'stop-requested',task,reason});controls[task].stop();statuses[task]='正在让出操作';broadcast();}
async function yieldTask(task,reason){stop(task,reason);await controls[task].settled();const page=await snapshot(task,'after-yield');statuses[task]='已让出操作';log({kind:'yield-complete',task,page});broadcast();return page;}
async function resume(task,reason){await controls[task].settled();const current=await snapshot(task,'before-explicit-continue');const ticket=controls[task].startNewExecution();statuses[task]='自动运行';log({kind:'resumed-after-observation',task,reason,generation:ticket.generation,current});broadcast();return ticket;}
async function action(task,ticket,operation,fn){return controls[task].dispatch(ticket,operation,fn);}
function handled(promise,label){return promise.then(value=>({ok:true,value}),error=>{log({kind:'action-ended',label,error:error.message});return {ok:false,error:error.message};});}
async function click(task,ticket,id){return action(task,ticket,'click:'+id,signal=>pages[task].locator('#'+id).click({signal,timeout:id==='late'?0:10000}));}
async function step(task,ticket){await click(task,ticket,'autoStep');await action(task,ticket,'observe-step-result',()=>pages[task].evaluate(()=>window.lab.wait()));}
function loop(task){const ticket=controls[task].ticket();const work=(async()=>{while(controls[task].active&&ticket.generation===controls[task].generation){await step(task,ticket);await sleep(900);}})();loops[task]=handled(work,'loop:'+task);return loops[task];}
async function resetA(reason){if(controls.A.active)stop('A',reason);await controls.A.settled();if(loops.A)await loops.A;return resume('A',reason);}
function onNative(event){
 try{
  const row=log({kind:'native-input',...event});nativeRows.push(row);
  const targets=['A','B'].includes(event.owner)?[event.owner]:event.owner==='unknown'?['A','B']:[];
  for(const task of targets){if(!controls[task]?.active)continue;
   const generation=controls[task].generation;
   // 这里同步使代次失效；testInjection 只标注证据，不参与分类规则。
   stop(task,'native-input:'+event.owner);
   if(mode==='human'&&!event.testInjection){humanStops[phase]={task,generation,nativeSeq:row.seq,event,counts:JSON.parse(JSON.stringify(counts)),at:row.at};save('human-stops.json',humanStops);}
   const finish=(async()=>{await controls[task].settled();await snapshot(task,'after-native-takeover');statuses[task]='已让出操作';broadcast();if(mode==='human'){
    if(phase==='observe')setGuide(state.phaseLabel,'本步网页已停止。请先回到 Codex 说明刚才的操作，暂不继续下一步。','查看步骤尚未完成；请回到 Codex 反馈。');
    else if(task==='A'){
     const instruction=phase==='ime'?'A 已让出。继续用中文输入法输入完整的“手动接管测试”；然后点右下角复制按钮，再发送“继续”。':phase==='paste'?'A 已让出。确认粘贴框内是“网页粘贴测试 2026”，再在右下角发送“继续”。':'A 已让出。观察 A 的自动进度停住、B 仍增加，然后在右下角发送“继续”。';
     setGuide(state.phaseLabel,instruction,'在这个对话框输入“继续”并发送，程序才会进入下一步。');
    }
    await capture('human-'+phase+'-yield');
   }})();handled(finish,'yield:'+task);
  }
 }catch(error){log({kind:'native-handler-error',error:error.message});for(const control of Object.values(controls))control.stop();}
}
async function fixture(method){log({kind:'fixture-control',method});return pages.A.evaluate(method=>window.lab[method](),method);}
async function autoChecks(){
 phase='source-separation';const before=nativeRows.length,ticket=controls.A.ticket();
 await step('A',ticket);
 await action('A',ticket,'fill:autoTyping',signal=>pages.A.locator('#autoTyping').fill('自动填入',{signal}));
 await action('A',ticket,'type:autoTyping',signal=>pages.A.locator('#autoTyping').pressSequentially('abc',{signal,delay:20}));
 await action('A',ticket,'CDP:insertText',async()=>{const session=await pages.A.context().newCDPSession(pages.A);await session.send('Input.insertText',{text:'自动中文'});await session.detach();});
 views.A.webContents.sendInputEvent({type:'keyDown',keyCode:'Z'});await sleep(100);
 check('five-automatic-input-paths-do-not-take-over',nativeRows.length===before&&controls.A.active,{nativeCount:nativeRows.length-before,domEvents:domRows.length});
 phase='waiting-click';await fixture('disableLate');const old=controls.A.ticket();const pending=handled(click('A',old,'late'),'waiting-click');
 await sleep(100);const countB=counts.B.auto;loop('B');
 const accepted=handled(click('A',old,'accepted'),'accepted-before-stop');await accepted;
 await until(()=>rows.some(r=>r.kind==='server-accepted'&&r.task==='A'&&r.operation==='accepted'),'accepted-request');
 native.injectProbe(100,170);
 check('native-A-invalidates-only-A-synchronously',!controls.A.active&&controls.B.active,{event:nativeRows.at(-1)});
 await controls.A.settled();const pendingResult=await pending;
 await fixture('enableLate');await sleep(150);
 check('waiting-click-canceled-before-enable',!pendingResult.ok&&counts.A.late===0,{pendingResult});
 await until(()=>counts.A.accepted===1&&counts.B.auto>countB,'accepted-result-and-B');
 check('accepted-request-can-finish-after-stop',rows.find(r=>r.kind==='server-committed'&&r.task==='A'&&r.operation==='accepted').seq>rows.find(r=>r.kind==='stop'&&r.task==='A').seq);
 check('B-continues-during-A-takeover',counts.B.auto>countB);
 const next=await resume('A','automatic-explicit-continue');
 await step('A',next);
 const oldWork=await handled(click('A',old,'autoStep'),'old-delayed-reply');
 check('old-reply-rejected-after-new-generation',!oldWork.ok);
 phase='continuous-typing';await action('A',next,'fill:autoTyping',signal=>pages.A.locator('#autoTyping').fill('',{signal}));
 const typing=handled(action('A',next,'type:slow',signal=>pages.A.locator('#autoTyping').pressSequentially('1234567890abcdefghijklmnop',{delay:80,signal})),'slow-typing');
 await until(()=>domRows.some(r=>r.phase==='continuous-typing'&&r.type==='input'&&r.target==='autoTyping'&&r.value==='12'),'two-automatic-characters-entered');
 views.A.webContents.focus();native.injectKeyProbe();
 check('native-keyboard-owner-is-A',nativeRows.at(-1).owner==='A'&&!controls.A.active,{event:nativeRows.at(-1)});
 await controls.A.settled();await typing;const frozen=(await snapshot('A','typing-settled')).typing;await sleep(300);const stable=(await snapshot('A','typing-stability')).typing;
 check('continuous-input-canceled-with-partial-result',frozen===stable&&stable.includes('12')&&!stable.includes('abcdefghijklmnop'),{frozen,stable});
 await resume('A','overlay-isolation');phase='overlay-isolation';
 native.injectProbe(1100,760);native.injectProbe(400,30);
 views.chat.webContents.focus();native.injectKeyProbe();
 check('native-overlay-and-shell-do-not-stop-tasks',nativeRows.slice(-3).map(r=>r.owner).join(',')==='chat,shell,chat'&&controls.A.active&&controls.B.active,{events:nativeRows.slice(-3)});
 for(const selected of ['A','B','split']){
  const label=selected==='split'?'同时查看':'只看 '+selected;
  await pages.shell.getByRole('button',{name:label,exact:true}).click({timeout:3000});
  await until(()=>viewMode===selected,'view-button:'+selected);
  const width=win.getContentSize()[0],actual={};
  for(const task of ['A','B'])actual[task]={visible:views[task].getVisible(),bounds:views[task].getBounds()};
  check('host-button-applies-layout:'+selected,['A','B'].every(task=>actual[task].visible===(selected==='split'||selected===task)&&actual[task].bounds.width===(selected==='split'?Math.floor(width/2):width)),{actual});
 }
 check('host-view-switch-does-not-stop-tasks',controls.A.active&&controls.B.active);
 await yieldTask('A','automatic-checks-complete');await yieldTask('B','automatic-checks-complete');await Promise.all(Object.values(loops));
 phase='reload-ownership';
 // 保存旧流程的反例：只重载页面却不更新原生登记。此时任务均已停止，注入只用于诊断。
 for(const task of ['A','B']){await pages[task].reload();await pages[task].waitForFunction(()=>Boolean(window.lab));}
 const beforeRebind=[];
 for(const [task,x] of [['A',100],['B',win.getContentSize()[0]/2+100]]){native.injectProbe(x,170);beforeRebind.push({expectedOwner:task,event:nativeRows.at(-1)});}
 save('reload-ownership-red.json',{legacyWouldPass:beforeRebind.every(sample=>sample.event.owner===sample.expectedOwner),samples:beforeRebind});
 // 走真人准备的同一重载入口，确认登记更新发生在恢复自动派发之前。
 await reloadTaskDocuments();
 await resume('A','reload-ownership-regression');await resume('B','reload-ownership-regression');
 native.injectProbe(100,170);
 check('reload-A-click-stops-only-A',nativeRows.at(-1).owner==='A'&&!controls.A.active&&controls.B.active,{event:nativeRows.at(-1)});
 await controls.A.settled();await resume('A','reload-keyboard-regression');
 await pages.A.locator('#ime').focus();views.A.webContents.focus();native.injectKeyProbe();
 check('reload-A-key-stops-only-A',nativeRows.at(-1).owner==='A'&&!controls.A.active&&controls.B.active,{event:nativeRows.at(-1)});
 await controls.A.settled();await resume('A','reload-B-regression');
 native.injectProbe(win.getContentSize()[0]/2+100,170);
 check('reload-B-click-stops-only-B',nativeRows.at(-1).owner==='B'&&controls.A.active&&!controls.B.active,{event:nativeRows.at(-1)});
 await controls.B.settled();await resume('B','reload-switch-regression');
 for(const selected of ['A','B','split']){await pages.shell.getByRole('button',{name:selected==='split'?'同时查看':'只看 '+selected,exact:true}).click({timeout:3000});await until(()=>viewMode===selected,'reload-view:'+selected);}
 native.injectProbe(100,170);
 check('reload-and-view-switch-preserve-A-ownership',nativeRows.at(-1).owner==='A'&&!controls.A.active&&controls.B.active,{event:nativeRows.at(-1)});
 await yieldTask('A','reload-checks-complete');await yieldTask('B','reload-checks-complete');
 save('automatic-summary.json',{pass:true,checks:checks.length,versions:process.versions,counts});
}
async function armHuman(nextPhase){
 phase=nextPhase;phaseStart=rows.length+1;viewMode='split';layout();
 await fixture('disableLate');
 const ticket=controls.A.ticket();
 handled(click('A',ticket,'late'),'human-pending:'+phase);
 if(phase==='click'){
  acceptedDelay=1600;await click('A',ticket,'accepted');loop('A');
  setGuide('2 / 4 · 点击','点一次左侧蓝色网页按钮。预期：A 的自动进度停住，右侧 B 继续增加。','观察两三秒后，在这里输入“继续”并发送。');
 }else{
  const target=phase==='ime'?'ime':'paste';
  await action('A',ticket,'focus:'+target,()=>pages.A.locator('#'+target).focus());views.A.webContents.focus();
  setGuide(phase==='ime'?'3 / 4 · 中文输入':'4 / 4 · 粘贴',phase==='ime'?'中文框已聚焦，不要先点网页。用中文输入法键入“手动接管测试”；预期 A 让出、B 继续。':'粘贴框已聚焦，不要先点网页。直接按 ⌘V；预期出现“网页粘贴测试 2026”，A 让出、B 继续。',phase==='ime'?'输入完成后，先点下方“复制粘贴样本文字”，再输入“继续”并发送。':'粘贴完成后在这里发送“继续”，程序会检查恢复后文字是否还在。');
 }
 log({kind:'human-phase-armed',generation:ticket.generation});await capture('human-'+phase+'-ready');
}
async function verifyHumanPhase(){
 const entry=humanStops[phase];if(!entry||entry.task!=='A'||entry.event.testInjection)return '尚未收到本步任务 A 的真实原生输入。';
 await controls.A.settled();if(loops.A)await loops.A;
 const current=await snapshot('A','human-continue-verification');
 const dom=domRows.filter(r=>r.mode==='human'&&r.phase===phase&&r.task==='A');
 if(phase==='click'&&!(entry.event.type==='mouseDown'&&current.counts.manual>=1))return '请实际点击左侧蓝色按钮后再继续。';
 if(phase==='ime'&&!(entry.event.type==='keyDown'&&current.ime==='手动接管测试'&&dom.some(r=>r.type==='compositionstart')&&dom.some(r=>r.type==='compositionend')))return '还需要通过中文输入法实际键入“手动接管测试”，当前记录不完整。';
 if(phase==='paste'&&!(entry.event.type==='keyDown'&&current.paste==='网页粘贴测试 2026'&&dom.some(r=>r.type==='paste')))return '还需要在左侧粘贴框实际按 ⌘V，粘贴“网页粘贴测试 2026”。';
 await until(()=>counts.B.auto>entry.counts.B.auto,'B-continues-for-human');
 await fixture('enableLate');await sleep(180);
 check('human-'+phase+'-pending-click-canceled',counts.A.late===0);
 const old={owner:controls.A,generation:entry.generation,signal:controls.A.abort.signal};
 const result=await handled(click('A',old,'autoStep'),'human-old-queued:'+phase);
 check('human-'+phase+'-queued-work-rejected',!result.ok);
 check('human-'+phase+'-B-continued',counts.B.auto>entry.counts.B.auto);
 humanStops[phase].verified={current,domCount:dom.length,bProgress:counts.B.auto-entry.counts.B.auto};save('human-stops.json',humanStops);
 return null;
}
async function command(event,name,value){
 if(![win.webContents.id,views.chat.webContents.id].includes(event.sender.id))throw Error('unowned-command-sender');
 log({kind:'host-command',name,value,sender:event.sender.id});
 if(name==='view'){if(!['A','B','split'].includes(value))return;viewMode=value;if(mode==='human')viewSamples.add(value);layout();broadcast();return {accepted:true};}
 if(name==='copy'){clipboard.writeText('网页粘贴测试 2026');return {accepted:true};}
 if(name!=='message'||mode!=='human')return {accepted:false,message:'实验尚未进入真人阶段。'};
 if(value.trim()==='对话测试'){
  chatted=controls.A.active&&controls.B.active;
  log({kind:'chat-observation',tasksStillActive:chatted});
  return {accepted:true,message:chatted?'对话输入未接管网页；查看和切换完成后发送“继续”。':'任务已让出；请在 Codex 说明发生了什么。'};
 }
 if(value.trim()!=='继续')return {accepted:true,message:'已记下。按上方指引操作，完成后发送“继续”。'};
 if(commandBusy)return {accepted:false,message:'正在核对上一项结果，请稍候。'};
 commandBusy=true;
 try{
  if(phase==='observe'){
   if(!chatted||!viewSamples.has('A')||!viewSamples.has('B')||!controls.A.active||!controls.B.active)return {accepted:false,message:'请先切换“只看 A / 只看 B”，并发送“对话测试”；两项任务应仍运行。'};
   check('human-view-and-chat-do-not-take-over',true,{viewSamples:[...viewSamples],nativeChat:nativeRows.filter(r=>r.mode==='human'&&r.owner==='chat').length});
   await resetA('human-explicit-continue-to-click');await armHuman('click');
  }else if(['click','ime','paste'].includes(phase)){
   const error=await verifyHumanPhase();if(error)return {accepted:false,message:error};
   const oldTicket=controls.A.ticket();await resume('A','human-explicit-continue');
   const oldReply=await handled(click('A',oldTicket,'autoStep'),'human-late-reply-after-resume');
   check('human-'+phase+'-old-reply-rejected-after-resume',!oldReply.ok);
   if(phase==='click')await armHuman('ime');
   else if(phase==='ime')await armHuman('paste');
   else{
    phase='finishing';setGuide('结果核对','已读取当前页面，正在续做并核对人工内容保留。','正在核对最后结果。');
    const ticket=controls.A.ticket();for(let i=0;i<3;i++)await step('A',ticket);
    const current=await snapshot('A','final-preserved-input');
    check('manual-content-preserved-after-explicit-continue',current.ime==='手动接管测试'&&current.paste==='网页粘贴测试 2026');
    await yieldTask('A','human-test-completed');await yieldTask('B','human-test-completed');await loops.B;
    phase='awaiting-feedback';statuses.A='核对完成';statuses.B='核对完成';
    setGuide('操作完成','请回到 Codex，确认显示、任务归属和继续行为是否符合观察。','原始输入与当前页面已保存；请在 Codex 反馈观察。');
    save('human-summary.json',{inputChecksPassed:true,requiresUserFeedback:true,humanStops,final:current,checks});await capture('human-complete');
    console.log(JSON.stringify({event:'HUMAN_INPUT_CHECKS_COMPLETE',out}));
   }
  }else return {accepted:false,message:'实验操作已完成，请回到 Codex 反馈。'};
  return {accepted:true,message:'已核对当前页面，请按上方新指引继续。'};
 }finally{commandBusy=false;}
}
async function prepareHuman(){
 mode='human-setup';phase='observe';
 chatted=false;viewSamples.clear();
 // 新文档清掉自动实验的字段值；仅在真人开始前执行。
 counts.A={auto:0,manual:0,late:0,accepted:0};counts.B={auto:0,manual:0,late:0,accepted:0};
 await reloadTaskDocuments();
 for(const task of ['A','B'])await resume(task,'begin-human-fixture');
 mode='human';
 viewMode='split';layout();loop('A');loop('B');
 setGuide('1 / 4 · 查看与对话','只操作顶部和右下角：切换“只看 A / B”，再回到“同时查看”；预期两个自动进度都继续增加。','先输入“对话测试”并发送，看到绿色回复后，再输入“继续”并发送。此步先不点网页按钮和输入框。');
 win.show();win.focus();views.chat.webContents.focus();broadcast();await capture('human-ready');
 save('live.json',{pid:process.pid,port:process.env.TAKEOVER_PORT,origin,out});
 const registryFile=path.join(__dirname,'artifacts/registration.json');
 const registry=JSON.parse(fs.readFileSync(registryFile));
 registry.preparationPausedAt=Date.now();registry.preparationRemainingMs=Math.max(0,registry.deadline-registry.preparationPausedAt);
 fs.writeFileSync(registryFile,JSON.stringify(registry,null,2)+'\n');
 log({kind:'ready-for-human',preparationRemainingMs:registry.preparationRemainingMs});
 console.log(JSON.stringify({event:'READY_FOR_HUMAN',out,origin}));
}
async function main(){
 const {ExecutionControl}=await import(pathToFileURL(path.join(__dirname,'../independent-stop/control.mjs')));
 for(const task of ['A','B'])controls[task]=new ExecutionControl(task,log);
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/status'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({phase,mode,statuses,checks,counts}));}
  if(req.method==='POST'&&url.pathname==='/commit'){
   let raw='';for await(const part of req){raw+=part;if(raw.length>2048){res.writeHead(413);return res.end();}}
   const {task,kind}=JSON.parse(raw);if(!counts[task]||!Object.hasOwn(counts[task],kind)){res.writeHead(400);return res.end();}
   log({kind:'server-accepted',task,operation:kind});const delay=kind==='accepted'?acceptedDelay:30;
   setTimeout(()=>{counts[task][kind]++;log({kind:'server-committed',task,operation:kind,count:counts[task][kind]});res.setHeader('content-type','application/json');res.end(JSON.stringify({count:counts[task][kind]}));},delay);return;
  }
  const file={'/fixture':'fixture.html','/shell':'shell.html','/chat':'chat.html'}[url.pathname];
  if(!file){res.writeHead(404);return res.end();}res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(__dirname,file)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 win=new BrowserWindow({width:1280,height:940,show:true,title:'helpr 人工接管核对',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.on('resize',layout);
 await win.loadURL(origin+'/shell');
 for(const label of ['A','B','chat']){
  const view=new WebContentsView({webPreferences:{preload:path.join(__dirname,label==='chat'?'preload.cjs':'page-preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});views[label]=view;win.contentView.addChildView(view);layout();
  await view.webContents.loadURL(origin+(label==='chat'?'/chat':'/fixture?task='+label));
 }
 layout();win.show();app.focus({steal:true});win.focus();const tags=registerNativeViews('initial-ready-documents');
 ipcMain.on('lab-dom',(event,row)=>{const task=['A','B'].find(t=>views[t].webContents.id===event.sender.id);if(task)domRows.push(log({kind:'dom-event',task,...row}));});
 ipcMain.handle('lab-command',command);
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.TAKEOVER_PORT,{noDefaults:true});
 for(const page of browser.contexts().flatMap(context=>context.pages())){const url=new URL(page.url());if(url.pathname==='/fixture')pages[url.searchParams.get('task')]=page;else if(url.pathname==='/shell')pages.shell=page;}
 if(!pages.A||!pages.B)throw Error('task-pages-not-bound');
 save('environment.json',{versions:process.versions,platform:process.platform,arch:process.arch,playwright:require('../visible-page-control/node_modules/playwright/package.json').version,tags,origin});
 const displayState={window:{visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused(),bounds:win.getBounds()},pages:{}};
 for(const task of ['A','B','shell'])displayState.pages[task]=await pages[task].evaluate(()=>new Promise(resolve=>{
  let done=false;const finish=raf=>{if(done)return;done=true;resolve({raf,hidden:document.hidden,visibility:document.visibilityState,size:[innerWidth,innerHeight],ready:document.readyState});};
  requestAnimationFrame(()=>finish(true));setTimeout(()=>finish(false),600);
 }));
 save('startup-state.json',displayState);log({kind:'startup-state',displayState});
 const timeout=setTimeout(()=>{fatal(Error('preparation-time-budget-exhausted'));},Math.max(1,Number(process.env.TAKEOVER_DEADLINE)-Date.now()));
 await autoChecks();clearTimeout(timeout);
 if(process.env.TAKEOVER_AUTOMATIC_ONLY==='1'){console.log(JSON.stringify({event:'AUTOMATIC_COMPLETE',out,checks:checks.length}));return app.quit();}
 await prepareHuman();
}
function fatal(error){log({kind:'fatal',error:error.message,stack:error.stack});save('failure.json',{error:error.message,stack:error.stack,phase});console.log(JSON.stringify({event:'FAILED',out,error:error.message}));app.exit(1);}
app.setPath('userData',path.join(out,'profiles/electron'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.TAKEOVER_PORT);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
// 与锁定的 Playwright Electron 启动器一致：可见任务不能因宿主被遮挡而停帧。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.whenReady().then(main).catch(fatal);
app.on('before-quit',()=>{if(stopping)return;stopping=true;for(const control of Object.values(controls))control.stop();log({kind:'window-closed',completion:phase==='awaiting-feedback'?'input-complete-feedback-pending':'interrupted'});native.stop();server?.close();});
app.on('window-all-closed',()=>app.quit());
process.on('unhandledRejection',fatal);
