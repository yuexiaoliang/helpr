const {app,BrowserWindow,WebContentsView,session,ipcMain,Tray,Menu,nativeImage,powerMonitor,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const flag=name=>process.argv.find(v=>v.startsWith('--lab-'+name+'='))?.split('=').slice(1).join('=');
const data=flag('data'),out=flag('out'),origin=flag('origin'),ownerPid=Number(flag('owner-pid')),owned=new Map();let win,tray,native,remote,closing=false,cleaned=false;
const log=row=>fs.appendFileSync(path.join(out,'host-events.jsonl'),JSON.stringify({at:Date.now(),...row})+'\n');
// Diagnostic-only lifecycle probes in this throwaway experiment. No page content.
const ownerState=()=>({ownerPid,parentPid:process.ppid,connected:process.connected===true,closing});
const trace=(kind,extra={})=>log({kind,diagnostic:'[DEBUG-owner-exit-20261013]',...ownerState(),...extra});
const ownerPresent=()=>Number.isSafeInteger(ownerPid)&&ownerPid>1&&process.ppid===ownerPid&&process.connected===true;
const send=m=>{if(!process.connected)return false;process.send(m,error=>{if(error)closeHost('owner-channel-error');});return true;};
function markClosing(reason){if(closing)return false;closing=true;clearInterval(ownerObserver);trace('host-close-requested',{reason});return true;}
function closeHost(reason){if(markClosing(reason))app.quit();}
function cleanOwnedResources(){
  if(cleaned)return;cleaned=true;
  const clean=(resource,action)=>{try{action();}catch(error){trace('host-close-resource-error',{resource,error:error.message});}};
  clean('native-input',()=>native?.stop());
  for(const [task,view] of owned)clean('view-'+task,()=>{if(!view.webContents.isDestroyed())view.webContents.close({waitForBeforeUnload:false});});
  clean('tray',()=>tray?.destroy());
  log({kind:'host-quit'});
}
// Parent identity changes on actual owner death; no timeout on ordinary idle/sleep.
const ownerObserver=setInterval(()=>{if(!closing&&!ownerPresent()){trace('host-owner-observed-lost');closeHost('owner-no-longer-present');}},250);
ownerObserver.unref();
trace('host-owner-bound');
process.once('disconnect',()=>{trace('host-ipc-disconnected');closeHost('owner-disconnected');});
const prefs={sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false};
function bind(){if(!win||win.isDestroyed())return;const [w,h]=win.getContentSize();let i=0;for(const [id,view] of owned){const bounds={x:i++*Math.floor(w/2),y:82,width:Math.floor(w/2),height:h-186};view.setBounds(bounds);native.tagRegion(id,bounds.x,bounds.y,bounds.width,bounds.height,bounds.x+20,bounds.y+20);}native.tagRegion('dialog',0,0,w,h,20,20);}
app.whenReady().then(async()=>{
  if(closing)return;
  if(!ownerPresent()){closeHost('owner-missing-before-ready');return;}
  remote=session.fromPartition('persist:lab-website');remote.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));remote.setPermissionCheckHandler(()=>false);remote.webRequest.onBeforeRequest((r,cb)=>cb({cancel:!r.url.startsWith(origin+'/')&&r.url!=='about:blank'}));
  remote.on('will-download',e=>e.preventDefault());
  win=new BrowserWindow({width:1120,height:780,show:false,title:'helpr 封装与恢复核对',webPreferences:{...prefs,preload:path.join(__dirname,'ui-preload.cjs')}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());await win.loadFile(path.join(__dirname,'ui.html'));if(closing)return;win.show();win.focus();log({kind:'shell-shown-before-credential-initialization'});
  for(const task of ['A','B']){if(closing)return;const view=new WebContentsView({webPreferences:{...prefs,session:remote}});owned.set(task,view);win.contentView.addChildView(view);const wc=view.webContents;wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',(e,url)=>{if(!url.startsWith(origin+'/'))e.preventDefault();});send({registration:{task,targetId:wc.getOrCreateDevToolsTargetId(),webContentsId:wc.id}});await wc.loadURL(origin+'/page?task='+task);if(closing)return;log({kind:'page-loaded',task,visible:wc.isDestroyed()?false:true});}
  win.show();win.focus();log({kind:'window-shown',visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds()});native=require('./native/input-monitor.node');native.install(win.getNativeWindowHandle(),event=>send({input:event}));bind();win.on('resize',()=>{try{bind();}catch(error){send({input:{owner:'unknown',reason:error.message}});}});
  win.on('close',event=>{if(!closing){event.preventDefault();win.hide();log({kind:'window-hidden'});}});
  const icon=nativeImage.createFromBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><text x="3" y="17" font-size="20">h</text></svg>'));icon.setTemplateImage(true);tray=new Tray(icon);tray.setToolTip('helpr Lifecycle Lab');tray.setContextMenu(Menu.buildFromTemplate([{label:'返回核对窗口',click:()=>win.show()},{label:'退出实验',click:()=>send({request:{kind:'quit'}})}]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'helpr Lifecycle Lab',submenu:[{label:'显示窗口',click:()=>win.show()},{label:'退出实验',accelerator:'Command+Q',click:()=>send({request:{kind:'quit'}})}]}]));
  for(const event of ['suspend','resume','lock-screen','unlock-screen'])powerMonitor.on(event,()=>send({power:event}));
  log({kind:'ready',versions:process.versions,packaged:app.isPackaged,nativeLoaded:true});send({ready:{versions:process.versions,packaged:app.isPackaged,nativeLoaded:true}});
});
ipcMain.handle('lab-request',(event,r)=>{
  if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||!['stop','continue','hide','quit','credential'].includes(r?.kind)||Object.keys(r).some(k=>!['kind','task'].includes(k)))throw Error('host-request-denied');
  if(r.kind==='hide'){win.hide();log({kind:'window-hidden'});return;}
  if(r.kind==='credential')return probe('credential');
  send({request:r});return {accepted:true};
});
process.on('message',async m=>{if(m.probe){try{send({reply:{id:m.probe.id,value:await probe(m.probe.kind)}});}catch(error){send({reply:{id:m.probe.id,error:error.message}});}}if(m.status)win?.webContents.send('lab-status',m.status);if(m.notice)win?.webContents.send('lab-notice',m.notice);if(m.show){win?.show();win?.focus();log({kind:'window-shown-again'});}if(m.close)closeHost('owner-requested');});
app.on('before-quit',e=>{
  trace('host-before-quit');
  if(!closing&&ownerPresent()){e.preventDefault();trace('host-waiting-for-owner-save');send({request:{kind:'quit'}});return;}
  // Native pipe loss may enter here before Node's disconnect notification.
  // Finish this quit directly; do not ask a missing owner or recurse into quit.
  markClosing('native-quit-without-owner');cleanOwnedResources();
});
app.on('will-quit',()=>trace('host-will-quit',{liveViews:[...owned.values()].filter(v=>!v.webContents.isDestroyed()).length}));
app.on('quit',()=>trace('host-quit-complete'));
app.on('window-all-closed',()=>{});

async function probe(kind){
  if(kind==='hide'){win.close();return {visible:win.isVisible()};}
  if(kind==='show'){win.show();win.focus();log({kind:'window-shown-again'});return {visible:win.isVisible()};}
  if(kind==='view')return {visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds(),views:[...owned].map(([task,v])=>({task,bounds:v.getBounds(),url:v.webContents.getURL()}))};
  if(kind==='credential'){
    if(!safeStorage.isEncryptionAvailable())throw Error('protected-storage-unavailable');
    const file=path.join(data,'model-sample.encrypted'),sample='HELPR-VIRTUAL-KEY-ONLY-20261012',created=!fs.existsSync(file);
    if(created)fs.writeFileSync(file,safeStorage.encryptString(sample),{mode:0o600});
    const ok=safeStorage.decryptString(fs.readFileSync(file))===sample;const result={ok,created,plaintextOnDisk:fs.readFileSync(file).includes(Buffer.from(sample))};log({kind:'sample-credential-verified',...result});return result;
  }
  if(kind==='cookie'){
    const name='helpr-lab-login',sample='VIRTUAL-SESSION-ONLY-20261012';
    const existing=await remote.cookies.get({name});if(!existing.length)await remote.cookies.set({url:origin,name,value:sample,expirationDate:Math.floor(Date.now()/1000)+3600,httpOnly:true,sameSite:'strict'});
    await remote.cookies.flushStore();const cookies=await remote.cookies.get({name});const result={ok:cookies.length===1&&cookies[0].value===sample,created:existing.length===0};log({kind:'sample-cookie-verified',...result});return result;
  }
  throw Error('host-probe-not-allowed');
}
