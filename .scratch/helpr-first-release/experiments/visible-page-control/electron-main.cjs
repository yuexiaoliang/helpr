const { app, BrowserWindow, WebContentsView, ipcMain, webContents, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.LAB_BASE;
const output = process.env.LAB_DIR;
app.setPath('userData', path.join(output, 'profiles', 'electron'));
app.commandLine.appendSwitch('remote-debugging-port', process.env.LAB_CDP_PORT);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
let sequence = 0, mode = 'split', overlayVisible = false, cover;
const nativeLog = entry => fs.appendFileSync(path.join(output,'electron-native.jsonl'), JSON.stringify({sequence:++sequence,at:Date.now(),...entry})+'\n');
const map = new Map();
function instrument(wc, label) {
  map.set(label, wc);
  wc.on('before-input-event', (_event, input)=>nativeLog({kind:'before-input-event',label,wcId:wc.id,input}));
  wc.on('before-mouse-event', (_event, input)=>nativeLog({kind:'before-mouse-event',label,wcId:wc.id,input}));
  wc.on('input-event', (_event, input)=>nativeLog({kind:'input-event',label,wcId:wc.id,input}));
  for (const type of ['focus','blur','did-finish-load','destroyed']) wc.on(type,()=>nativeLog({kind:type,label,wcId:wc.id}));
  wc.on('did-navigate',(_event,url)=>nativeLog({kind:'did-navigate',label,wcId:wc.id,url}));
  wc.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{backgroundThrottling:false}}}));
  wc.on('did-create-window',(win,details)=>{instrument(win.webContents,label+'-popup');nativeLog({kind:'popup-owned',label,wcId:wc.id,popupId:win.webContents.id,url:details.url});});
}
app.whenReady().then(async()=>{
  const main = new BrowserWindow({width:1280,height:880,title:'helpr 页面控制实验',show:process.env.LAB_START_HIDDEN!=='1',webPreferences:{preload:path.join(__dirname,'electron-preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  const views = {};
  for (const label of ['A','B']) {
    const view = new WebContentsView({webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
    main.contentView.addChildView(view); views[label]=view;
    instrument(view.webContents,label);
  }
  const overlay = new WebContentsView({webPreferences:{preload:path.join(__dirname,'electron-preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  main.contentView.addChildView(overlay); instrument(overlay.webContents,'overlay');
  const arrange = ()=>{
    const [width,height]=main.getContentSize();
    for (const [label,view] of Object.entries(views)) {
      view.setVisible(mode==='split'||mode===label);
      view.setBounds(mode==='split'?{x:label==='A'?0:Math.floor(width/2),y:58,width:Math.floor(width/2),height:height-58}:{x:0,y:58,width,height:height-58});
    }
    overlay.setBounds({x:width-335,y:height-240,width:320,height:225});overlay.setVisible(overlayVisible);
  };
  const status = ()=>({mode,overlayVisible,minimized:main.isMinimized(),windowFocused:main.isFocused(),focusedWc:webContents.getFocusedWebContents()?.id,cursor:screen.getCursorScreenPoint(),pages:[...map].filter(([,wc])=>!wc.isDestroyed()).map(([label,wc])=>({label,wcId:wc.id,url:wc.getURL(),focused:wc.isFocused()}))});
  const command = async(name,value)=>{
    if(name==='show'){mode=value;arrange();}
    if(name==='overlay'){overlayVisible=!overlayVisible;arrange();}
    if(name==='minimize') main.minimize();
    if(name==='restore'){main.restore();main.show();}
    if(name==='focus'){main.show();main.focus();views[value].webContents.focus();}
    if(name==='cover'){
      cover=new BrowserWindow({x:main.getBounds().x,y:main.getBounds().y,width:1280,height:880,...value,show:true});
      await cover.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="font:24px system-ui;padding:70px;background:#253753;color:white">遮挡实验进行中，测试网页在此窗口后运行。</body>'));
    }
    if(name==='uncover'&&cover){cover.close();cover=undefined;}
    if(name==='input') map.get(value.label).sendInputEvent(value.input);
    if(name==='insertText') await map.get(value.label).insertText(value.text);
    if(name==='marker') nativeLog({kind:'marker',...value});
    if(name==='quit') app.quit();
    return status();
  };
  global.labHost={status,command,views,main,map};
  ipcMain.handle('lab-status',()=>status());
  ipcMain.handle('lab-command',(event,name,value)=>{
    if(event.sender!==main.webContents&&event.sender!==overlay.webContents) throw new Error('control sender not allowed');
    return command(name,value);
  });
  main.on('resize',arrange);
  main.on('closed',()=>{for(const wc of map.values())if(!wc.isDestroyed())wc.close();app.quit();});
  await main.loadFile(path.join(__dirname,'shell.html'));
  await overlay.webContents.loadFile(path.join(__dirname,'overlay.html'));
  await Promise.all(Object.entries(views).map(async([label,view])=>{await view.webContents.loadURL(base+'/fixture');await view.webContents.executeJavaScript(`window.lab.bind(${JSON.stringify('electron-'+label)})`);}));
  arrange();nativeLog({kind:'ready',versions:process.versions,status:status()});
});
app.on('window-all-closed',()=>app.quit());
