// 场景及预期属于独立实验夹具。explicit:true 是测试注入的继续指令，不是真人消息。
module.exports=async function candidateChecks(env){
 const {app,WebContentsView,native,win,views,controls,pages,chromium,ExecutionControl,origin,origin2,log,check,beginCase,save,pause,receipts,getBrowser,setBrowser}=env;
 const {TaskOwnership}=require('./ownership.cjs');
 let observationHook,heartbeatBusy=false;
 const selectedCases=new Set((process.env.LIFECYCLE_CASES||'').split(',').filter(Boolean));
 const own=new TaskOwnership({native,win,ExecutionControl,log,observe:async(page,task)=>{
  const current=await page.evaluate(()=>window.lab?.snapshot());if(!current?.documentId)throw Error('current-page-unverified');
  if(observationHook)await observationHook(task);return current;
 }});
 for(const task of ['A','B']){const r=own.add(task,views[task]);controls[task]=r.control;}
 native.stop();native.install(win.getNativeWindowHandle(),event=>own.input(event));
 const bindNonTasks=()=>{
  const b=views.chat.getBounds();native.tagRegion('chat',b.x,b.y,b.width,b.height,b.x+30,b.y+30);
  const [width,height]=win.getContentSize();native.tagRegion('shell',0,0,width,height,200,20);
 };
 const layout=(selected='split')=>{
  for(const task of ['A','B']){
   const view=views[task];view.setVisible(selected==='split'||selected===task);
   view.setBounds({x:selected==='split'&&task==='B'?550:0,y:60,width:selected==='split'?550:1100,height:700});
   own.bindNative(task);
  }
  const before=native.describe(830,630);
  win.contentView.addChildView(views.chat);
  bindNonTasks();log({kind:'fixture-layout',selected,chatBefore:before,chatAfter:native.describe(830,630)});
 };
 await own.connect(getBrowser());layout();for(const task of ['A','B'])await own.refresh(task);
 const count=(task,kind='auto')=>receipts.filter(r=>r.task===task&&r.kind===kind).length;
 const direct=task=>views[task].webContents.executeJavaScript('window.lab?.snapshot()');
 async function until(predicate,label,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(15);}throw Error('timeout:'+label);}
 async function tick(task,token=own.token(task)){
  await own.dispatch(token,'auto-tick',(page,signal)=>page.locator('#tick').click({signal,timeout:2500}));
  return own.dispatch(token,'read-commit-result',page=>page.evaluate(()=>window.lab.wait()));
 }
 async function waitB(before){await until(()=>count('B')>before,'B-progress');return count('B')-before;}
 const nativeLast=()=>env.rows.filter(row=>row.kind==='native-input').at(-1);
 async function refused(operation){try{await operation();return {rejected:false};}catch(error){return {rejected:true,error:error.message};}}
 async function navigate(task,url){
  const before=await direct(task);await views[task].webContents.executeJavaScript(`setTimeout(()=>location.href=${JSON.stringify(url)},0)`);
  await until(async()=>{try{const now=await direct(task);return now&&now.documentId!==before.documentId;}catch{return false;}},'new-document:'+task);
  return {before,after:await direct(task)};
 }
 async function reload(task){
  const before=await direct(task);await views[task].webContents.executeJavaScript('setTimeout(()=>location.reload(),0)');
  await until(async()=>{try{const now=await direct(task);return now&&now.documentId!==before.documentId;}catch{return false;}},'reload:'+task);
  return {before,after:await direct(task)};
 }
 async function activeBoth(){
  observationHook=null;layout();
  for(const task of ['A','B']){await own.continueTask(task,{explicit:true});pages[task]=own.tasks.get(task).binding.page;}
 }
 const cases=[];
 async function scenario(name,fn){
  if(selectedCases.size&&!selectedCases.has(name))return;
  await activeBoth();beginCase(name);const start=env.checks.length;
  try{await fn();}catch(error){check(name+':completed',false,{message:error.message,stack:error.stack});}
  const result={name,checks:env.checks.slice(start),states:{A:own.state('A'),B:own.state('B')},server:{A:count('A'),B:count('B')},snapshots:{}};
  for(const task of ['A','B'])try{result.snapshots[task]=await direct(task);}catch(error){result.snapshots[task]={error:error.message};}
  cases.push(result);save('cases.json',cases);
 }
 const heartbeat=setInterval(()=>{
  if(heartbeatBusy||!own.state('B').active||!own.state('B').ready)return;
  heartbeatBusy=true;tick('B').catch(error=>log({kind:'B-tick-ended',error:error.message})).finally(()=>{heartbeatBusy=false;});
 },90);
 try{
  await scenario('self-reload-mouse-and-explicit-continue',async()=>{
   const old=own.token('A'),nativeBefore=native.describe(100,150),beforeB=count('B');
   const changed=await reload('A'),nativeAfter=native.describe(100,150);
   check('reload-invalidates-old-operation',!own.state('A').active&&!own.state('A').ready&&(await refused(()=>tick('A',old))).rejected,{changed});
   check('reload-keeps-owned-outer-subtree',nativeAfter.owner==='A'&&nativeBefore.chain[0].identity!==nativeAfter.chain[0].identity&&nativeBefore.chain[1].identity===nativeAfter.chain[1].identity,{nativeBefore,nativeAfter});
   await own.continueTask('A');await own.dispatch(own.token('A'),'seed-current-text',page=>page.locator('#text').fill('当前页面文字'));
   native.injectProbe(100,150);await controls.A.settled();
   check('self-reload-A-input-stops-only-A',nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active);
   const held=await refused(()=>own.continueTask('A'));check('takeover-requires-explicit-continue',held.rejected&&held.error==='explicit-continue-required');
   const snapshotBeforeContinue=await direct('A');await own.continueTask('A',{explicit:true});await tick('A');await waitB(beforeB);
   check('explicit-continue-keeps-current-text-and-B-progress',(await direct('A')).text===snapshotBeforeContinue.text&&count('B')>beforeB);
  });
  await scenario('reload-keyboard-owner',async()=>{
   await reload('A');await own.continueTask('A');const page=own.tasks.get('A').binding.page;await page.locator('#text').focus();views.A.webContents.focus();
   const before=await direct('A'),beforeB=count('B');native.injectKeyProbe();await controls.A.settled();await pause(80);await waitB(beforeB);
   check('keyboard-after-reload-only-yields-A',nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active,{event:nativeLast()});
   check('native-key-actually-edits-current-document',(await direct('A')).text!==before.text,{before,after:await direct('A')});
  });
  await scenario('same-origin-navigation',async()=>{
   const token=own.token('A'),beforeB=count('B');const changed=await navigate('A',origin+'/fixture?task=A&revision=2');native.injectProbe(100,150);
   check('navigation-input-owned-before-control-rebind',nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active,{changed});
   check('previous-navigation-token-rejected',(await refused(()=>tick('A',token))).rejected);
   await own.continueTask('A',{explicit:true});await tick('A');await waitB(beforeB);
  });
  await scenario('second-loopback-origin-navigation',async()=>{
   const token=own.token('A'),beforeB=count('B');const changed=await navigate('A',origin2+'/fixture?task=A');
   await own.continueTask('A');native.injectProbe(100,150);await waitB(beforeB);
   check('second-origin-rebind-preserves-task-owner',nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active,{changed});
   check('second-origin-does-not-reuse-old-operation',(await refused(()=>tick('A',token))).rejected);
  });
  await scenario('webcontents-view-replacement',async()=>{
   const oldView=views.A,oldPage=own.tasks.get('A').binding.page,old=own.token('A'),oldId=oldView.webContents.id,beforeB=count('B');
   const next=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
   own.replace('A',next);win.contentView.removeChildView(oldView);oldView.webContents.close();views.A=next;win.contentView.addChildView(next);next.setBounds({x:0,y:60,width:550,height:700});
   await next.webContents.loadURL(origin+'/fixture?task=A');await own.continueTask('A');native.injectProbe(100,150);await waitB(beforeB);
   check('replacement-has-new-target-and-correct-input-owner',next.webContents.id!==oldId&&nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active,{oldId,newId:next.webContents.id});
   check('replaced-view-old-page-actually-closed',oldPage.isClosed()&&(await refused(()=>oldPage.evaluate(()=>1))).rejected);
   check('replacement-rejects-old-task-token',(await refused(()=>tick('A',old))).rejected);
  });
  await scenario('duplicate-url-does-not-claim-task',async()=>{
   const registeredId=views.A.webContents.id,expectedDoc=(await direct('A')).documentId;
   const decoy=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
   try{
    await decoy.webContents.loadURL(views.A.webContents.getURL());const decoyDoc=await decoy.webContents.executeJavaScript('window.lab.snapshot().documentId');
    await own.refresh('A');await tick('A');
    check('binding-uses-registered-target-not-url',own.tasks.get('A').binding.wcId===registeredId&&registeredId!==decoy.webContents.id&&receipts.filter(r=>r.task==='A').at(-1).documentId===expectedDoc&&!receipts.some(r=>r.documentId===decoyDoc),{registeredId,decoyId:decoy.webContents.id,expectedDoc,decoyDoc});
   }finally{decoy.webContents.close();}
  });
  await scenario('pending-click-during-navigation',async()=>{
   const token=own.token('A'),start=receipts.length;
   const pending=own.dispatch(token,'wait-disabled',(page,signal)=>page.locator('#pending').click({signal,timeout:6000})).then(()=>({resolved:true}),error=>({resolved:false,error:error.message}));
   await pause(100);await reload('A');const pendingResult=await pending;
   await views.A.webContents.executeJavaScript("document.querySelector('#pending').disabled=false");
   const oldAttempt=await refused(()=>own.dispatch(token,'old-queued-click',(page,signal)=>page.locator('#pending').click({signal,timeout:1000})));
   await own.continueTask('A');await tick('A');
   check('navigation-cancels-wait-and-rejects-old-queue',!pendingResult.resolved&&oldAttempt.rejected,{pendingResult,oldAttempt});
   check('old-pending-click-never-reaches-server',!receipts.slice(start).some(r=>r.kind==='late'));
  });
  await scenario('reload-after-user-stop',async()=>{
   own.stop('A','user-stop');own.stop('B','user-stop');await controls.B.settled();const b=count('B');
   await reload('A');await own.refresh('A');await pause(130);
   const automatic=await refused(()=>own.continueTask('A'));
   check('reload-and-rebind-do-not-clear-user-stop',!own.state('A').active&&!own.state('B').active&&automatic.rejected&&own.state('A').reasons.includes('user-stop'));
   await own.continueTask('A',{explicit:true});await tick('A');await pause(150);
   check('explicit-A-continue-leaves-user-stopped-B-stopped',own.state('A').active&&!own.state('B').active&&count('B')===b);
  });
  await scenario('control-disconnect-and-explicit-continue',async()=>{
   await own.dispatch(own.token('A'),'seed-reconnect-text',page=>page.locator('#text').fill('连接恢复后保留'));
   const old=own.token('A'),oldPage=old.binding.page;own.stop('B','user-stop');await controls.B.settled();const beforeB=count('B');
   await getBrowser().close();await until(()=>!own.state('A').active,'disconnect-invalidated');
   check('disconnected-control-rejects-old-operation',(await refused(()=>tick('A',old))).rejected&&oldPage.isClosed());
   const connection=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.LIFECYCLE_PORT,{noDefaults:true});setBrowser(connection);await own.connect(connection);
   await own.refresh('A');await own.refresh('B');check('reconnect-only-does-not-resume-stopped-work',!own.state('A').active&&!own.state('B').active);
   await own.continueTask('A',{explicit:true});await tick('A');await pause(150);
   check('reconnect-continue-reads-current-page-and-preserves-text',(await direct('A')).text==='连接恢复后保留'&&own.tasks.get('A').binding.page!==oldPage);
   check('reconnect-does-not-restart-user-stopped-B',!own.state('B').active&&own.state('B').reasons.includes('user-stop')&&count('B')===beforeB);
   check('old-control-token-stays-invalid-after-reconnect',(await refused(()=>tick('A',old))).rejected);
  });
  await scenario('host-view-switch-and-chat',async()=>{
   // 重现替换视图后子视图排到最上的条件；布局必须恢复对话覆盖层。
   win.contentView.addChildView(views.A);
   const beforeB=count('B');for(const selected of ['A','B','split']){layout(selected);await pause(40);}
   const switched=env.rows.filter(row=>row.kind==='fixture-layout'&&row.selected==='A').at(-1);
   check('host-layout-restores-chat-above-replaced-view',switched.chatBefore.owner==='A'&&switched.chatAfter.owner==='chat',{before:switched.chatBefore,after:switched.chatAfter});
   native.injectProbe(930,650);const chat=nativeLast();native.injectProbe(200,20);const shell=nativeLast();await waitB(beforeB);
   check('view-switch-chat-shell-do-not-take-over',own.state('A').active&&own.state('B').active&&chat.owner==='chat'&&shell.owner==='shell',{chat,shell});
   native.injectProbe(100,150);check('post-switch-A-input-keeps-B-active',nativeLast().owner==='A'&&!own.state('A').active&&own.state('B').active);
  });
  await scenario('unknown-owner-stays-unknown',async()=>{
   native.untag('A');native.injectProbe(100,150);await controls.A.settled();await controls.B.settled();const beforeB=count('B');
   check('unknown-not-relabelled-as-A',nativeLast().owner==='unknown'&&!own.state('A').active&&!own.state('B').active,{event:nativeLast(),states:{A:own.state('A'),B:own.state('B')}});
   check('unknown-does-not-auto-resume',(await refused(()=>own.continueTask('A'))).rejected);
   await own.continueTask('A',{explicit:true});await tick('A');await pause(150);
   check('continue-rechecks-owner-and-keeps-other-unknown-task-paused',native.describe(100,150).owner==='A'&&own.state('A').active&&!own.state('B').active&&count('B')===beforeB);
  });
  await scenario('navigation-during-page-verification',async()=>{
   let fired=false;observationHook=async task=>{if(task==='A'&&!fired){fired=true;await reload('A');}};
   const result=await refused(()=>own.refresh('A'));observationHook=null;
   check('verification-result-from-old-document-rejected',result.rejected&&result.error==='binding-changed-during-observation'&&!own.state('A').ready&&!own.state('A').active,{result});
   await own.continueTask('A');await tick('A');check('fresh-verification-can-resume-after-race',own.state('A').active&&own.state('A').ready);
  });
  await scenario('new-stop-during-page-verification',async()=>{
   let fired=false;observationHook=async task=>{if(task==='A'&&!fired){fired=true;own.stop('A','user-stop');}};
   const result=await refused(()=>own.continueTask('A',{explicit:true}));observationHook=null;
   check('new-user-stop-wins-over-earlier-continue',result.rejected&&result.error==='new-stop-during-verification'&&!own.state('A').active&&own.state('A').reasons.includes('user-stop'),{result,state:own.state('A')});
   const beforeB=count('B');await own.continueTask('A',{explicit:true});await tick('A');await waitB(beforeB);
   check('later-explicit-continue-can-follow-new-stop',own.state('A').active&&own.state('B').active);
  });
  await scenario('unverifiable-page-does-not-resume',async()=>{
   await views.A.webContents.loadURL(origin+'/unverified');const result=await refused(()=>own.continueTask('A',{explicit:true}));
   check('explicit-continue-cannot-skip-page-verification',result.rejected&&result.error==='current-page-unverified'&&!own.state('A').ready&&!own.state('A').active&&own.state('B').active,{result});
   await views.A.webContents.loadURL(origin+'/fixture?task=A');
  });
  if(selectedCases.size&&[...selectedCases].some(name=>!cases.some(c=>c.name===name)))throw Error('unknown-case-filter');
  save('candidate-summary.json',{cases,pass:env.checks.every(c=>c.pass),selectedCases:[...selectedCases],guarantee:'controlled macOS Electron lifecycle only',operatorSource:'automatic-native-probe'});
 }finally{clearInterval(heartbeat);for(const task of ['A','B'])own.stop(task,'experiment-complete');await Promise.all(['A','B'].map(task=>controls[task].settled()));}
 return own;
};
