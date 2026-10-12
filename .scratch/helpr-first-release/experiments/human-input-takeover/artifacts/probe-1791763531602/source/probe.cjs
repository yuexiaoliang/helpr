const {app,BrowserWindow,WebContentsView}=require('electron');
const path=require('node:path');
const monitor=require('./build/input-monitor.node');
app.setPath('userData',path.join(process.env.TAKEOVER_OUT,'profiles/probe'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.TAKEOVER_PORT);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:740,show:false,title:'helpr 输入来源自动探针'}),views={},events=[];
 await win.loadURL('data:text/html,<body>shell</body>');
 for(const label of ['A','B','chat']){
  const view=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});views[label]=view;win.contentView.addChildView(view);
  view.setBounds(label==='chat'?{x:680,y:490,width:300,height:200}:{x:label==='A'?0:500,y:60,width:500,height:620});
  await view.webContents.loadURL('data:text/html,'+encodeURIComponent(`<title>probe-${label}</title><body style="padding:20px"><button id="click">Click ${label}</button><input id="text"><script>window.events=[];for(const type of ['click','keydown','beforeinput','input','compositionstart','paste'])document.addEventListener(type,e=>window.events.push({type,trusted:e.isTrusted,target:e.target.id}));</script></body>`));
 }
 monitor.install(win.getNativeWindowHandle(),e=>events.push(e));
 const tags={A:monitor.tag('A',100,150),B:monitor.tag('B',600,150),chat:monitor.tag('chat',800,560),shell:monitor.tag('shell',200,20)};
 global.probe={win,views,events,tags,monitor,ready:true};
});
app.on('will-quit',()=>monitor.stop());
app.on('window-all-closed',()=>app.quit());
