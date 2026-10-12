const {app,BrowserWindow,WebContentsView,session,protocol,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const out=process.argv[2], base=process.argv[3], cross=base.replace('127.0.0.1','localhost');
const log=e=>fs.appendFileSync(path.join(out,'host-events.jsonl'),JSON.stringify({time:Date.now(),...e})+'\n');
app.setPath('userData',path.join(out,'profile'));app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'helpr',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const prefs={sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false};
const owned=new Map();let ui,win;
const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'||[base,cross].includes(u.origin);}catch{return false;}};
function guardSession(ses){
  ses.setPermissionRequestHandler((wc,permission,cb)=>{log({kind:'permission-request-denied',permission,task:owned.get(wc?.id)});cb(false);});
  ses.setPermissionCheckHandler((_wc,permission)=>{log({kind:'permission-check-denied',permission});return false;});
  ses.on('will-download',(event,item,wc)=>{event.preventDefault();log({kind:'download-denied',url:item.getURL(),task:owned.get(wc?.id)});});
  // The fixture confinement separately prevents accidental real website traffic.
  ses.webRequest.onBeforeRequest((d,cb)=>{
    const u=d.url;const ok=u.startsWith(base+'/')||u.startsWith(cross+'/')||u==='about:blank'||u.startsWith('helpr://ui/');
    if(!ok)log({kind:'fixture-network-denied',url:u,resourceType:d.resourceType});cb({cancel:!ok});
  });
}
function register(wc,task){
  owned.set(wc.id,task);const targetId=wc.getOrCreateDevToolsTargetId();process.send({registration:{targetId,task,webContentsId:wc.id}});
  wc.on('destroyed',()=>{owned.delete(wc.id);process.send?.({unregistration:targetId});});
  wc.on('will-frame-navigate',event=>{if(!allowed(event.url)){event.preventDefault();log({kind:'navigation-denied',task,url:event.url,main:event.isMainFrame});}});
  wc.on('will-redirect',(event,url)=>{if(!allowed(url)){event.preventDefault();log({kind:'redirect-denied',task,url});}});
  wc.on('will-attach-webview',event=>event.preventDefault());
  wc.setWindowOpenHandler(details=>{
    if(!allowed(details.url)){log({kind:'popup-denied',task,url:details.url});return {action:'deny'};}
    log({kind:'popup-allowed',task,url:details.url});
    return {action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{...prefs,session:wc.session,preload:undefined}},createWindow:options=>{
      const popup=new BrowserWindow({...options,show:false,webPreferences:{...prefs,session:wc.session}});register(popup.webContents,task);return popup.webContents;
    }};
  });
}
app.whenReady().then(async()=>{
  const remote=session.fromPartition('remote-fixture'),local=session.fromPartition('host-dialog');guardSession(remote);guardSession(local);
  local.protocol.handle('helpr',()=>new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><h1>helpr 控制隔离实验</h1><p>此窗口仅使用本机虚构页面。</p>'));
  win=new BrowserWindow({width:1050,height:760,show:false,title:'helpr 浏览器控制隔离实验',webPreferences:{...prefs,session:local,preload:path.join(__dirname,'ui-preload.cjs')}});ui=win.webContents;
  ui.on('will-navigate',e=>e.preventDefault());ui.setWindowOpenHandler(()=>({action:'deny'}));await ui.loadURL('helpr://ui/index');
  for(const [i,task] of ['A','B'].entries()){
    const view=new WebContentsView({webPreferences:{...prefs,session:remote}});register(view.webContents,task);win.contentView.addChildView(view);view.setBounds({x:i*525,y:90,width:525,height:660});await view.webContents.loadURL(`${base}/page?task=${task}`);
  }
  win.showInactive();
  log({kind:'ready',versions:process.versions,argv:process.argv,switches:{pipe:app.commandLine.hasSwitch('remote-debugging-pipe'),port:app.commandLine.hasSwitch('remote-debugging-port'),inspect:app.commandLine.hasSwitch('inspect')},preferences:prefs});
  process.send({ready:true,pid:process.pid,uiTarget:ui.getOrCreateDevToolsTargetId(),versions:process.versions});
});
ipcMain.handle('helpr:request',(event,request)=>{
  const accepted=event.sender===ui&&event.senderFrame===ui.mainFrame&&event.senderFrame.url==='helpr://ui/index'&&request?.kind==='status'&&Object.keys(request).length===1;
  log({kind:'ipc-request',accepted,source:event.senderFrame?.url,request:request?.kind});if(!accepted)throw new Error('HOST_REQUEST_DENIED');return {running:true};
});
process.on('message',async m=>{
  if(m.uiProbe){const result=await ui.executeJavaScript(`Promise.all([window.helpr.status(),window.helpr.invalid().catch(e=>({denied:true}))])`);process.send({uiProbeResult:result});}
  if(m.close)app.quit();
});
app.on('window-all-closed',()=>app.quit());
