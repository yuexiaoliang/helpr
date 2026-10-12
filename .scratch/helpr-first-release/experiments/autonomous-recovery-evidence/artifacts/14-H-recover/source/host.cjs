const {app,BrowserWindow,WebContentsView,webContents,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const [out,origin,proxy,authFile,task]=process.argv.slice(2);
const log=e=>fs.appendFileSync(path.join(out,'host-events.jsonl'),JSON.stringify({time:Date.now(),...e})+'\n');
const notify=m=>process.connected&&process.send(m,()=>{});
app.setPath('userData',path.join(out,'profile'));app.enableSandbox();
const prefs={sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false};
const owned=new Set();let win;
const allowed=url=>{try{return new URL(url).origin===origin;}catch{return false;}};
function register(wc){owned.add(wc.id);const targetId=wc.getOrCreateDevToolsTargetId();notify({registration:{targetId,task,webContentsId:wc.id}});wc.on('destroyed',()=>{owned.delete(wc.id);notify({unregistration:targetId});});wc.on('will-frame-navigate',e=>{if(!allowed(e.url))e.preventDefault();});wc.on('will-redirect',(e,url)=>{if(!allowed(url))e.preventDefault();});wc.on('will-attach-webview',e=>e.preventDefault());wc.setWindowOpenHandler(()=>({action:'deny'}));}
app.whenReady().then(async()=>{
  const remote=session.fromPartition('remote-task');await remote.setProxy({proxyRules:proxy,proxyBypassRules:'<-loopback>'});
  remote.setPermissionRequestHandler((_w,_p,cb)=>cb(false));remote.setPermissionCheckHandler(()=>false);remote.on('will-download',e=>e.preventDefault());
  remote.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!allowed(d.url)&&d.url!=='about:blank'&&!d.url.startsWith('blob:')}));
  for(const c of JSON.parse(fs.readFileSync(authFile,'utf8')).cookies){const cookie={url:origin+c.path,name:c.name,value:c.value,path:c.path,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite.toLowerCase()};if(c.expires>0)cookie.expirationDate=c.expires;await remote.cookies.set(cookie);}
  win=new BrowserWindow({width:1440,height:1000,show:false,title:'helpr 恢复依据核对实验',webPreferences:{...prefs,partition:'host-ui'}});await win.loadURL('data:text/html,<h3>helpr 恢复依据核对实验</h3>');
  const view=new WebContentsView({webPreferences:{...prefs,session:remote}});register(view.webContents);win.contentView.addChildView(view);view.setBounds({x:0,y:42,width:1440,height:930});await view.webContents.loadURL('about:blank');win.showInactive();
  log({kind:'ready',versions:process.versions,preferences:prefs,debugPort:app.commandLine.hasSwitch('remote-debugging-port')});notify({ready:true,pid:process.pid,versions:process.versions});
}).catch(e=>{log({kind:'host-error',message:e.message});app.exit(1);});
process.on('message',m=>{if(m.close)app.quit();});
process.on('disconnect',()=>log({kind:'owner-disconnected'}));
app.on('before-quit',()=>{for(const id of [...owned]){const wc=webContents.fromId(id);if(wc&&!wc.isDestroyed())wc.close({waitForBeforeUnload:false});}log({kind:'before-quit'});});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>log({kind:'will-quit'}));
