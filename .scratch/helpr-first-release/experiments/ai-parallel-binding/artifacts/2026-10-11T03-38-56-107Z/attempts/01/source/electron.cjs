const {app,BrowserWindow,WebContentsView,webContents}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(process.env.AI_LAB_OUT,'profiles','electron'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.AI_LAB_PORT);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1180,height:800,title:'helpr AI 双页归属实验'});
  await window.loadURL('data:text/html,<body style="font:16px system-ui;background:%23142d48;color:white">helpr AI 双页自动实验</body>');
  const views={};let visible='split';
  const arrange=()=>{const [w,h]=window.getContentSize();for(const [task,v] of Object.entries(views)){v.setVisible(visible==='split'||visible===task);v.setBounds(visible==='split'?{x:task==='A'?0:Math.floor(w/2),y:36,width:Math.floor(w/2),height:h-36}:{x:0,y:36,width:w,height:h-36});}};
  for(const task of ['A','B']){
    const v=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    views[task]=v;window.contentView.addChildView(v);
    v.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}}));
    await v.webContents.loadURL(process.env.AI_LAB_BASE+'/boot?task='+task);
  }
  window.on('resize',arrange);arrange();
  global.aiLab={views,window,ready:true,show(task){visible=task;arrange();return {visible,focused:webContents.getFocusedWebContents()?.id};}};
  window.on('closed',()=>{for(const v of Object.values(views))if(!v.webContents.isDestroyed())v.webContents.close();app.quit();});
});
app.on('window-all-closed',()=>app.quit());
