// 生命周期诊断夹具；整轮来源为 automatic-native-probe，不冒充真人。
// 原始 testInjection 仅表示同步注入栈；系统重送同一键盘事件时可能为 false，不能据此认作真人。
const {app,BrowserWindow,WebContentsView}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const out=process.env.LIFECYCLE_OUT,mode=process.env.LIFECYCLE_MODE;
const native=mode==='baseline'?require('../human-input-takeover/build/input-monitor.node'):require('./build/input-monitor.node');
const {chromium}=require('../visible-page-control/node_modules/playwright');
const rows=[],checks=[],receipts=[],views={},controls={},pages={};let win,server,server2,browser,origin,origin2,closing=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=(name,value)=>fs.writeFileSync(out+'/'+name,JSON.stringify(value,null,2)+'\n');
function log(row){const value={seq:rows.length+1,at:Date.now(),source:'automatic-native-probe',...row};rows.push(value);fs.appendFileSync(out+'/events.jsonl',JSON.stringify(value)+'\n');return value;}
function check(name,pass,detail){checks.push({name,pass:!!pass,detail});save('checks.json',checks);console.log(JSON.stringify({name,pass:!!pass}));}
function beginCase(name){const p=process.env.LIFECYCLE_BUDGET,b=JSON.parse(fs.readFileSync(p));if(b.cases>=40||Date.now()-b.startedAt>3600000)throw Error('case-budget');b.cases++;fs.writeFileSync(p,JSON.stringify(b,null,2)+'\n');log({kind:'case-start',name});}
function onNative(event){log({kind:'native-input',...event});const tasks=['A','B'].includes(event.owner)?[event.owner]:event.owner==='unknown'?['A','B']:[];for(const task of tasks)if(controls[task]?.active)controls[task].stop();}
function register(){native.stop();native.install(win.getNativeWindowHandle(),onNative);const tags={A:native.tag('A',100,150),B:native.tag('B',650,150),chat:native.tag('chat',930,650),shell:native.tag('shell',200,20)};log({kind:'native-registered',tags});}
async function snapshot(task){return pages[task].evaluate(()=>window.lab.snapshot());}
async function tick(task){const c=controls[task];return c.dispatch(c.ticket(),'tick',signal=>pages[task].locator('#tick').click({signal,timeout:3000})).then(()=>pages[task].evaluate(()=>window.lab.wait()));}
async function restart(task){await controls[task].settled();if(!controls[task].active)controls[task].startNewExecution();}
async function main(){
 const {ExecutionControl}=await import(pathToFileURL(path.join(__dirname,'../independent-stop/control.mjs')));
 for(const task of ['A','B'])controls[task]=new ExecutionControl(task,log);
 const handler=async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/commit'){
   let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);
   const row={...data,count:receipts.filter(r=>r.task===data.task&&r.kind===data.kind).length+1,at:Date.now()};receipts.push(row);save('server.json',receipts);res.setHeader('content-type','application/json');res.end(JSON.stringify(row));return;
  }
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(url.pathname==='/fixture'?fs.readFileSync(path.join(__dirname,'fixture.html')):'<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;background:#eef4f6">helpr 页面变化自动核对<input aria-label="对话" value="工具核对"></body>');
 };server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 server2=http.createServer(handler);await new Promise(resolve=>server2.listen(0,'127.0.0.1',resolve));origin2='http://127.0.0.1:'+server2.address().port;
 win=new BrowserWindow({width:1100,height:800,show:true,title:'helpr 页面变化自动核对',webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await win.loadURL(origin+'/shell');
 for(const task of ['A','B','chat']){
  const view=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});views[task]=view;win.contentView.addChildView(view);
  view.setBounds(task==='chat'?{x:800,y:600,width:290,height:130}:{x:task==='A'?0:550,y:60,width:550,height:700});
  await view.webContents.loadURL(origin+(task==='chat'?'/chat':'/fixture?task='+task));
 }
 win.show();app.focus({steal:true});win.focus();
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.LIFECYCLE_PORT,{noDefaults:true});
 for(const page of browser.contexts().flatMap(c=>c.pages())){const url=new URL(page.url());if(url.pathname==='/fixture')pages[url.searchParams.get('task')]=page;}
 await Promise.all(['A','B'].map(t=>pages[t].waitForFunction(()=>Boolean(window.lab))));
 save('environment.json',{versions:process.versions,playwright:require('../visible-page-control/node_modules/playwright/package.json').version,origin,origin2,mode});
 if(mode==='candidate'){
  await require('./cases.cjs')({app,WebContentsView,native,win,views,controls,pages,chromium,ExecutionControl,origin,origin2,log,check,beginCase,save,pause,receipts,rows,checks,getBrowser:()=>browser,setBrowser:value=>browser=value});
  save('result.json',{mode,checks,pass:checks.every(c=>c.pass),receipts});await finish(checks.every(c=>c.pass)?0:1);return;
 }
 register();
 beginCase('baseline-owned-view-after-reload');
 await tick('A');await tick('B');
 native.injectProbe(100,150);await pause(70);
 check('initial-A-input-stops-only-A',rows.filter(r=>r.kind==='native-input').at(-1)?.owner==='A'&&!controls.A.active&&controls.B.active);
 await restart('A');const before=await snapshot('A'),nativeBefore=native.describe?.(100,150);
 await pages.A.evaluate(()=>setTimeout(()=>location.reload(),0));
 await pages.A.waitForFunction(previous=>window.lab&&window.lab.snapshot().documentId!==previous,before.documentId);
 const after=await snapshot('A'),nativeAfter=native.describe?.(100,150);
 native.injectProbe(100,150);await pause(70);
 const event=rows.filter(r=>r.kind==='native-input').at(-1);
 check('reloaded-A-input-stops-only-A',event?.owner==='A'&&!controls.A.active&&controls.B.active,{event,before,after,active:{A:controls.A.active,B:controls.B.active}});
 const bBefore=receipts.filter(r=>r.task==='B'&&r.kind==='auto').length;
 let bError;try{await tick('B');}catch(error){bError=error.message;}
 check('B-can-continue-after-A-reload-input',receipts.filter(r=>r.task==='B'&&r.kind==='auto').length>bBefore,{bError});
 if(mode==='diagnostic'){
  save('native-before-after.json',{before:nativeBefore,after:nativeAfter});
  await restart('A');await restart('B');
  await pages.A.locator('#text').focus();views.A.webContents.focus();const focus=native.describe();native.injectKeyProbe();await pause(70);
  check('restoring-focus-alone-does-not-fix-stale-tag',rows.filter(r=>r.kind==='native-input').at(-1)?.owner==='unknown'&&!controls.A.active&&!controls.B.active,{focus,event:rows.filter(r=>r.kind==='native-input').at(-1)});
  await pages.A.locator('#text').fill('当前控制页面仍可操作');
  check('current-page-handle-survives-reload',browser.isConnected()&&!pages.A.isClosed()&&(await snapshot('A')).text==='当前控制页面仍可操作');
  native.tag('A',100,150);await restart('A');await restart('B');native.injectProbe(100,150);await pause(70);
  check('retagging-A-alone-restores-independent-mouse-owner',rows.filter(r=>r.kind==='native-input').at(-1)?.owner==='A'&&!controls.A.active&&controls.B.active,{event:rows.filter(r=>r.kind==='native-input').at(-1),afterRetag:native.describe(100,150)});
  await tick('B');await restart('A');await pages.A.locator('#text').focus();views.A.webContents.focus();native.injectKeyProbe();await pause(70);
  check('retagging-A-restores-independent-keyboard-owner',rows.filter(r=>r.kind==='native-input').at(-1)?.owner==='A'&&!controls.A.active&&controls.B.active,{event:rows.filter(r=>r.kind==='native-input').at(-1)});
  await tick('B');
 }
 save('result.json',{mode,checks,pass:checks.every(c=>c.pass),receipts});
 await finish(checks.every(c=>c.pass)?0:1);
}
async function finish(code){if(closing)return;closing=true;for(const c of Object.values(controls))c.stop();native.stop();await browser?.close().catch(()=>{});for(const v of Object.values(views))if(!v.webContents.isDestroyed())v.webContents.close();win?.destroy();server?.close();server2?.close();app.exit(code);}
app.setPath('userData',path.join(out,'profiles/electron'));app.commandLine.appendSwitch('remote-debugging-port',process.env.LIFECYCLE_PORT);app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.whenReady().then(main).catch(async error=>{save('failure.json',{message:error.message,stack:error.stack});console.log(JSON.stringify({error:error.message}));await finish(2);});
app.on('window-all-closed',()=>app.quit());
