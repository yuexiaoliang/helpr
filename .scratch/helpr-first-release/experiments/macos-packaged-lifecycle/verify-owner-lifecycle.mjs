// Replay native quit before IPC disconnect against the complete host source.
// Electron/process effects are replaced: this is not evidence of OS process cleanup.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourceFile=path.resolve(process.argv[2]||path.join(root,'src/host.cjs'));
const source=fs.readFileSync(sourceFile,'utf8');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

function fixture({holdPage=false,parent=1234,invalidateClosedViews=false}={}){
  const messages=[],logs=[],views=[],timers=new Set();
  let ready,releasePage,acceptedQuits=0,stopCount=0,windowCount=0,trayDestroyed=false;
  const app=new EventEmitter();
  app.whenReady=()=>new Promise(resolve=>ready=resolve);
  app.quit=()=>{
    const event={prevented:false,preventDefault(){this.prevented=true;}};
    app.emit('before-quit',event);
    if(!event.prevented){acceptedQuits++;app.emit('will-quit');app.emit('quit');}
  };
  const child=new EventEmitter();
  Object.assign(child,{connected:true,ppid:parent,pid:2345,argv:['lab','--lab-owner-pid=1234','--lab-data=/virtual/data','--lab-out=/virtual/out','--lab-origin=http://127.0.0.1:1234']});
  child.send=(message,callback)=>{messages.push(message);callback?.(null);};
  class Contents extends EventEmitter{
    setWindowOpenHandler(){}getOrCreateDevToolsTargetId(){return 'target';}
    loadURL(){return holdPage?new Promise(resolve=>releasePage=resolve):Promise.resolve();}
    send(){}isDestroyed(){return this.closed===true;}close(){this.closed=true;this.onClosed?.();}
  }
  class Window extends EventEmitter{
    constructor(){super();windowCount++;this.webContents=new Contents();this.contentView={addChildView(){}};}
    isDestroyed(){return false;}loadFile(){return Promise.resolve();}show(){}focus(){}hide(){}
    isVisible(){return true;}isFocused(){return true;}getBounds(){return {};}
    getContentSize(){return [1120,780];}getNativeWindowHandle(){return Buffer.alloc(8);}
  }
  class View{constructor(){this.webContents=new Contents();this.originalContents=this.webContents;if(invalidateClosedViews)this.webContents.onClosed=()=>{this.webContents=undefined;};views.push(this);}setBounds(){}}
  class Tray{setToolTip(){}setContextMenu(){}destroy(){trayDestroyed=true;}}
  const remote=new EventEmitter();
  remote.setPermissionRequestHandler=()=>{};remote.setPermissionCheckHandler=()=>{};remote.webRequest={onBeforeRequest(){}};
  const electron={app,BrowserWindow:Window,WebContentsView:View,session:{fromPartition:()=>remote},safeStorage:{},powerMonitor:new EventEmitter(),ipcMain:{handle(){}},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},Tray,nativeImage:{createFromBuffer:()=>({setTemplateImage(){}})}};
  const native={install(){},tagRegion(){},stop(){stopCount++;}};
  vm.runInNewContext(source,{
    require:name=>{
      if(name==='electron')return electron;
      if(name==='node:fs')return {appendFileSync:(_p,line)=>logs.push(JSON.parse(line))};
      if(name==='node:path')return path;
      if(name==='./native/input-monitor.node')return native;
      throw Error('unexpected require '+name);
    },
    __dirname:'/virtual/source',process:child,Buffer,
    setInterval:callback=>{const timer={callback,unref(){}};timers.add(timer);return timer;},
    clearInterval:timer=>timers.delete(timer)
  },{timeout:1000,filename:sourceFile});
  return {
    child,messages,logs,views,
    ready:async()=>{ready();await flush();},
    releasePage:async()=>{holdPage=false;releasePage?.();await flush();},
    nativeQuit:()=>app.quit(),
    orphan:()=>{child.ppid=1;},
    disconnect:()=>{child.connected=false;child.emit('disconnect');},
    close:()=>child.emit('message',{close:true}),
    poll:()=>{for(const timer of [...timers])timer.callback();},
    snapshot:()=>({acceptedQuits,stopCount,trayDestroyed,windowCount,timers:timers.size})
  };
}
function closed(f){
  assert.equal(f.snapshot().acceptedQuits,1,'quit remains blocked');
  assert(f.views.every(view=>view.originalContents.isDestroyed()),'an owned view remains live');
  if(f.views.length===2){assert.equal(f.snapshot().stopCount,1);assert(f.snapshot().trayDestroyed);}
  assert.equal(f.snapshot().timers,0,'owner observer remains armed after close');
}
const checks=[];
async function check(name,fn){try{await fn();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:error.message});}}

await check('native quit after owner death must not wait for IPC disconnect',async()=>{
  const f=fixture();await f.ready();f.orphan();f.nativeQuit();closed(f);
  assert(!f.messages.some(m=>m.request?.kind==='quit'),'asked the dead owner to save');
});
await check('closed control channel with unchanged parent also permits native quit',async()=>{
  const f=fixture();await f.ready();f.child.connected=false;f.nativeQuit();closed(f);
});
await check('missing native and IPC notifications still closes on changed parent',async()=>{
  const f=fixture();await f.ready();f.orphan();f.poll();closed(f);
});
await check('live owner gets save request and views remain until acknowledgement',async()=>{
  const f=fixture();await f.ready();f.nativeQuit();
  assert.equal(f.snapshot().acceptedQuits,0);assert(f.views.every(v=>!v.webContents.isDestroyed()));
  assert.equal(f.messages.filter(m=>m.request?.kind==='quit').length,1);
  f.close();closed(f);
});
await check('live owner polling does not interpret idle or waiting as failure',async()=>{
  const f=fixture();await f.ready();for(let i=0;i<20;i++)f.poll();
  assert.equal(f.snapshot().acceptedQuits,0);assert(f.views.every(v=>!v.webContents.isDestroyed()));
  f.close();closed(f);
});
await check('already orphaned at initialization creates no window',async()=>{
  const f=fixture({parent:1});await f.ready();closed(f);assert.equal(f.snapshot().windowCount,0);
  assert(!f.messages.some(m=>m.ready));
});
await check('owner death during page load cannot create a late view or ready',async()=>{
  const f=fixture({holdPage:true});await f.ready();assert.equal(f.views.length,1);
  f.orphan();f.nativeQuit();await f.releasePage();closed(f);assert.equal(f.views.length,1);
  assert(!f.messages.some(m=>m.ready));
});
await check('IPC close followed by late close message cleans resources only once',async()=>{
  const f=fixture();await f.ready();f.disconnect();f.close();f.poll();closed(f);
});
await check('destroyed native views may lose webContents before will-quit; diagnostic must not throw',async()=>{
  const f=fixture({invalidateClosedViews:true});await f.ready();f.disconnect();closed(f);
  assert(f.logs.some(row=>row.kind==='host-will-quit'),'will-quit was interrupted');
});
console.log(JSON.stringify({scope:'whole host source with native quit/parent order replayed; Electron effects replaced; real packaged verification still required',source:sourceFile,sha256:createHash('sha256').update(source).digest('hex'),checks},null,2));
if(checks.some(c=>!c.pass))process.exitCode=1;
