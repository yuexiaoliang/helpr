import { _electron, chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createLab } from './server.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
// 先完成 Electron 的首次下载，避免把下载耗时算进浏览器启动实验。
const electronPath=createRequire(import.meta.url)('electron');
const runId=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(root,'artifacts',runId);
await mkdir(out,{recursive:true});
await writeFile(path.join(root,'artifacts','latest.txt'),out+'\n');
const lab=await createLab(out);
const results=[];
const freePort=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
const electronPort=await freePort(), chromiumPort=await freePort();
const metadata={runId,os:{platform:os.platform(),release:os.release(),arch:os.arch()},node:process.version,playwright:'1.64.0',electron:'44.7.0',base:lab.base,electronPort,chromiumPort,startedAt:new Date().toISOString(),scope:'fixture-only; no real business or model calls'};
const save=async()=>{await lab.flush();await writeFile(path.join(out,'results.json'),JSON.stringify({metadata,results},null,2)+'\n');};
const check=async(name,fn)=>{
  lab.setPhase(name);
  try {const evidence=await fn();results.push({name,status:'passed',evidence});console.log('PASS '+name);}
  catch(error){results.push({name,status:'failed',error:String(error),stack:error.stack});console.log('FAIL '+name+' '+String(error).slice(0,250));}
  await save();
};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
async function waitUntil(fn,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('condition timeout');}
async function pageIdentity(page){const cdp=await page.context().newCDPSession(page);const {targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach();return {...await page.evaluate(()=>window.lab.snapshot()),targetId:targetInfo.targetId,openerId:targetInfo.openerId};}
async function tag(page,stage){await page.evaluate(s=>window.lab.stage(s),stage);lab.log({kind:'driver-stage',task:await page.evaluate(()=>window.lab.snapshot().task),stage});}
async function pulse(page,repeats=3){for(let i=0;i<repeats;i++){const n=await page.locator('#count').innerText();await page.locator('#increment').click({timeout:7000});await page.waitForFunction(n=>document.querySelector('#count').textContent!==n,n,{timeout:7000});}}
async function parallelEvidence(pages,stage){
  await Promise.all(pages.map(p=>tag(p,stage)));
  const start=lab.events.length;
  const before=await Promise.all(pages.map(p=>p.evaluate(()=>window.lab.snapshot())));
  await Promise.all(pages.map(p=>pulse(p)));
  const after=await Promise.all(pages.map(p=>p.evaluate(()=>window.lab.snapshot())));
  const starts=lab.events.slice(start).filter(e=>e.kind==='server-operation-start');
  const overlaps=starts.filter(e=>e.concurrent.some(task=>task!==e.task));
  assert(after.every((state,i)=>state.count===before[i].count+3),'page counters diverged');
  assert(overlaps.length>0,'no actual overlapping page operations');
  return {before,after,overlaps,operations:starts};
}
async function inputCases(page,prefix,host){
  for(const [name,action] of [
    ['playwright-click',()=>page.locator('#entry').click()],
    ['playwright-keyboard',()=>page.keyboard.type('autoASCII')],
    ['cdp-insert-chinese',()=>page.keyboard.insertText('自动输入')],
    ['playwright-fill',()=>page.locator('#entry').fill('自动填充')],
    ['script-click',()=>page.locator('#entry').evaluate(el=>el.click())],
    ['script-dispatch',()=>page.locator('#entry').dispatchEvent('click')],
    ['playwright-wheel',()=>page.mouse.wheel(0,130)],
    ['automatic-scroll',()=>page.locator('#bottom').click()]
  ]){
    await tag(page,prefix+'-'+name);
    if(host)await host('marker',{stage:prefix+'-'+name,label:'A'});
    await action();
  }
  await page.locator('#entry').scrollIntoViewIfNeeded();
  await page.evaluate(()=>window.lab.flush());
  return page.evaluate(()=>window.lab.events.filter(e=>e.stage.startsWith('electron-input')||e.stage.startsWith('chromium-input')));
}

let electron, electronControl, context, worker;
try {
  electron=await _electron.launch({executablePath:electronPath,args:[path.join(root,'electron-main.cjs')],env:{...process.env,LAB_BASE:lab.base,LAB_DIR:out,LAB_CDP_PORT:String(electronPort)},timeout:40000});
  electron.context().setDefaultTimeout(7000);
  await waitUntil(()=>electron.evaluate(()=>!!global.labHost));
  await waitUntil(()=>electron.evaluate(()=>[...global.labHost.map.values()].filter(w=>!w.isDestroyed()&&w.getURL().includes('/fixture')).length===2));
  const windows=electron.windows();
  metadata.electronDiscoveredPages=await Promise.all(windows.map(async p=>({url:p.url(),task:await p.evaluate(()=>window.lab?.snapshot().task).catch(()=>null)})));
  metadata.electronRawTargets=await fetch('http://127.0.0.1:'+electronPort+'/json/list').then(r=>r.json());
  metadata.electronAllContents=await electron.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType(),url:w.getURL()})));
  metadata.electronSession='default session in isolated userData directory';
  await save();
  electronControl=await chromium.connectOverCDP('http://127.0.0.1:'+electronPort,{noDefaults:true});
  metadata.electronPageControl='external CDP, noDefaults=true; _electron API retained for host controls';
  const browserSession=await electronControl.newBrowserCDPSession();
  metadata.electronTargetDetails=await browserSession.send('Target.getTargets');await browserSession.detach();
  metadata.electronSessionMatch=await electron.evaluate(({session})=>[...global.labHost.map].map(([label,wc])=>({label,isDefault:wc.session===session.defaultSession})));
  const electronPages=()=>electronControl.contexts().flatMap(c=>c.pages());
  const ePages=[];
  for(const name of ['electron-A','electron-B']) ePages.push(await waitUntil(async()=>{
    for(const p of electronPages()) {try{if(await p.evaluate(()=>window.lab?.snapshot().task)===name)return p;}catch{}}
  }));
  await check('electron-launch-page-discovery',async()=>{
    const discovered=await Promise.all(electron.windows().map(async p=>({url:p.url(),task:await p.evaluate(()=>window.lab?.snapshot().task).catch(()=>null)})));
    metadata.electronLaunchDiscoveryAfterCDP=discovered;
    assert(discovered.some(x=>x.task==='electron-A')&&discovered.some(x=>x.task==='electron-B'),'_electron.windows() missed fixture views; external CDP enumerated them');
    return discovered;
  });
  const host=(name,value)=>electron.evaluate((_e,{name,value})=>global.labHost.command(name,value),{name,value});
  await check('electron-page-identity',async()=>{
    const identities=await Promise.all(ePages.map(pageIdentity));
    assert(identities[0].url===identities[1].url,'expected identical URLs');
    assert(identities[0].targetId!==identities[1].targetId,'target identities collided');
    const bindings=await electron.evaluate(({webContents},ids)=>ids.map(i=>({...i,wcId:webContents.fromDevToolsTargetId(i.targetId)?.id})),identities);
    assert(bindings.every(x=>Number.isInteger(x.wcId)),'target not mapped to WebContents');
    return {bindings,host:await host('status'),discoveredWindows:windows.length};
  });
  await check('electron-parallel-visible',()=>parallelEvidence(ePages,'electron-visible'));
  await check('electron-parallel-background',async()=>{await host('show','A');const beforeHost=await host('status');const evidence=await parallelEvidence(ePages,'electron-background');const afterHost=await host('status');assert(beforeHost.mode===afterHost.mode,'background operations switched visible view');return {beforeHost,afterHost,...evidence};});
  await check('electron-parallel-covered',async()=>{await host('cover');try{return await parallelEvidence(ePages,'electron-covered');}finally{await host('uncover');}});
  await check('electron-parallel-minimized',async()=>{await host('minimize');try{return {host:await host('status'),...await parallelEvidence(ePages,'electron-minimized')};}finally{await host('restore');}});
  await check('electron-native-and-dom-input',async()=>{await host('show','A');await host('focus','A');return inputCases(ePages[0],'electron-input',host);});
  await check('electron-sendInputEvent',async()=>{
    const p=ePages[0];await p.locator('#entry').scrollIntoViewIfNeeded();await host('focus','A');
    const rect=await p.locator('#entry').boundingBox();
    await tag(p,'electron-sendInputEvent');await host('marker',{stage:'electron-sendInputEvent',label:'A'});
    for(const type of ['mouseDown','mouseUp']) await host('input',{label:'A',input:{type,x:Math.round(rect.x+25),y:Math.round(rect.y+18),button:'left',clickCount:1}});
    for(const type of ['keyDown','char','keyUp'])await host('input',{label:'A',input:{type,keyCode:'x'}});
    await host('insertText',{label:'A',text:'程序插入'});
    return p.evaluate(()=>window.lab.events.filter(e=>e.stage==='electron-sendInputEvent'));
  });
  await check('electron-popup-navigation',async()=>{
    const p=ePages[0], before=await pageIdentity(p);
    const popupPromise=p.waitForEvent('popup');await p.locator('#popup').click();const popup=await popupPromise;
    await popup.waitForLoadState();await popup.evaluate(()=>window.lab.bind('electron-A-popup'));
    const child=await pageIdentity(popup);assert(child.openerId===before.targetId,'popup owner mismatch');await pulse(popup,1);await popup.close();
    await p.locator('#navigate').click();await p.waitForURL('**/next');await p.evaluate(()=>window.lab.bind('electron-A'));
    const after=await pageIdentity(p);assert(before.targetId===after.targetId,'navigation changed target unexpectedly');
    await p.goto(lab.base.replace('127.0.0.1','localhost')+'/fixture');await p.evaluate(()=>window.lab.bind('electron-A'));
    const crossOrigin=await pageIdentity(p);assert(before.targetId===crossOrigin.targetId,'cross-origin target changed');
    return {before,child,after,crossOrigin};
  });
  await check('electron-external-cdp',async()=>{
    const external=await chromium.connectOverCDP('http://127.0.0.1:'+electronPort,{noDefaults:true});
    try {const pages=external.contexts().flatMap(c=>c.pages());const identities=[];for(const p of pages){try{if(await p.evaluate(()=>!!window.lab))identities.push(await pageIdentity(p));}catch{}}
      const target=identities.find(x=>x.task==='electron-B');assert(target,'external connection missed B');
      const page=await waitUntil(async()=>{for(const p of pages){try{if(await p.evaluate(()=>window.lab?.snapshot().task)==='electron-B')return p;}catch{}}});
      await page.locator('#entry').fill('外部 CDP 读取同页');assert(await ePages[1].locator('#entry').inputValue()==='外部 CDP 读取同页','connections saw different pages');
      return {identities,sharedValue:await ePages[1].locator('#entry').inputValue()};
    }finally{await external.close();}
  });
  await check('electron-overlay-target-separation',async()=>{
    await host('show','A');await host('overlay');
    const overlay=electronPages().find(p=>p.url().endsWith('/overlay.html'));assert(overlay,'overlay target missing');
    const before=await ePages[0].locator('#entry').inputValue();await overlay.locator('#chat').fill('浮窗输入样本');
    assert(await ePages[0].locator('#entry').inputValue()===before,'overlay input leaked into business page');
    const evidence={overlayValue:await overlay.locator('#chat').inputValue(),businessValue:before,host:await host('status')};
    await host('overlay');return evidence;
  });
  await host('show','split');
  for(const [i,p]of ePages.entries()){await p.goto(lab.base+'/fixture');await p.evaluate(label=>{window.lab.bind(label);window.lab.manual();},'electron-'+['A','B'][i]);await p.screenshot({path:path.join(out,'electron-'+['A','B'][i]+'.png')});}

  const extension=path.join(root,'extension');
  context=await chromium.launchPersistentContext(path.join(out,'profiles','chromium'),{headless:false,channel:'chromium',viewport:{width:1120,height:780},args:[`--remote-debugging-port=${chromiumPort}`,'--remote-debugging-address=127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  context.setDefaultTimeout(7000);
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const cPages=[context.pages()[0]||await context.newPage(),await context.newPage()];
  for(const [i,p]of cPages.entries()){await p.goto(lab.base+'/fixture');await p.evaluate(name=>window.lab.bind(name),'chromium-'+['A','B'][i]);}
  await check('chromium-extension-target-identity',async()=>{
    await Promise.all(cPages.map(p=>p.waitForFunction(()=>document.documentElement.dataset.labTabId)));
    const identities=await Promise.all(cPages.map(pageIdentity));const extensionMap=await worker.evaluate(()=>globalThis.labTargets());
    const bindings=[];
    for(const [i,p]of cPages.entries()){const tabId=Number(await p.evaluate(()=>document.documentElement.dataset.labTabId));const target=extensionMap.targets.find(t=>t.tabId===tabId);assert(target?.id===identities[i].targetId,'extension/CDP identity mismatch');bindings.push({...identities[i],tabId});}
    assert(bindings[0].url===bindings[1].url&&bindings[0].targetId!==bindings[1].targetId,'same-URL pages not distinct');
    return {bindings,extensionMap};
  });
  await check('chromium-parallel-background',async()=>{
    const tabsBefore=await worker.evaluate(()=>chrome.tabs.query({active:true}));
    const evidence=await parallelEvidence(cPages,'chromium-background');
    const tabsAfter=await worker.evaluate(()=>chrome.tabs.query({active:true}));
    assert(tabsBefore[0].id===tabsAfter[0].id,'background operations switched active tab');return {...evidence,activeBefore:tabsBefore[0].id,activeAfter:tabsAfter[0].id};
  });
  await check('chromium-parallel-minimized',async()=>{
    const cdp=await context.newCDPSession(cPages[1]);
    const {windowId,bounds}=await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
    const minimized=await waitUntil(async()=>{const {bounds:current}=await cdp.send('Browser.getWindowBounds',{windowId});return current.windowState==='minimized'&&current;});
    try{return {windowId,bounds,minimized,...await parallelEvidence(cPages,'chromium-minimized')};}
    finally{await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});await cdp.detach();}
  });
  await check('chromium-parallel-covered',async()=>{
    const cdp=await context.newCDPSession(cPages[1]);const {bounds}=await cdp.send('Browser.getWindowForTarget');await cdp.detach();
    await host('cover',{x:bounds.left,y:bounds.top,width:bounds.width,height:bounds.height});
    try{return {bounds,...await parallelEvidence(cPages,'chromium-covered')};}finally{await host('uncover');}
  });
  await check('chromium-extension-input',()=>inputCases(cPages[0],'chromium-input'));
  await check('chromium-popup-navigation',async()=>{
    const p=cPages[0],before=await pageIdentity(p);const popupPromise=p.waitForEvent('popup');await p.locator('#popup').click();const popup=await popupPromise;await popup.waitForLoadState();await popup.evaluate(()=>window.lab.bind('chromium-A-popup'));const child=await pageIdentity(popup);assert(child.openerId===before.targetId,'popup owner mismatch');await pulse(popup,1);await popup.close();
    await p.locator('#navigate').click();await p.waitForURL('**/next');await p.evaluate(()=>window.lab.bind('chromium-A'));const after=await pageIdentity(p);assert(before.targetId===after.targetId,'navigation target changed');
    await p.goto(lab.base.replace('127.0.0.1','localhost')+'/fixture');await p.evaluate(()=>window.lab.bind('chromium-A'));await p.waitForFunction(()=>document.documentElement.dataset.labTabId);const crossOrigin=await pageIdentity(p);assert(crossOrigin.targetId===before.targetId,'cross origin target changed');return {before,child,after,crossOrigin,tabId:await p.evaluate(()=>document.documentElement.dataset.labTabId)};
  });
  await check('chromium-overlay-event-separation',async()=>{
    const p=cPages[0];await tag(p,'chromium-overlay');const businessValue=await p.locator('#entry').inputValue();await p.locator('#extension-chat').fill('浮窗输入样本');assert(await p.locator('#entry').inputValue()===businessValue,'overlay modified business input');return {businessValue,overlayValue:await p.locator('#extension-chat').inputValue(),events:await p.evaluate(()=>window.lab.events.filter(e=>e.stage==='chromium-overlay'))};
  });
  for(const [i,p]of cPages.entries()){await p.goto(lab.base+'/fixture');await p.evaluate(label=>{window.lab.bind(label);window.lab.manual();},'chromium-'+['A','B'][i]);await p.screenshot({path:path.join(out,'chromium-'+['A','B'][i]+'.png')});}
  metadata.chromium=await context.browser()?.version();
  metadata.manualStatus='awaiting-real-user';lab.setPhase('human-awaiting');
  await host('marker',{stage:'human-awaiting',label:'all'});
  await save();
  await writeFile(path.join(out,'live.json'),JSON.stringify({pid:process.pid,base:lab.base,electronPort,chromiumPort,out,manualPages:['electron-A','electron-B','chromium-A','chromium-B']},null,2)+'\n');
  console.log('READY_FOR_HUMAN '+out);
  console.log('LIVE '+JSON.stringify({base:lab.base,electronPort,chromiumPort}));
  const shutdown=async()=>{await save();await context?.close().catch(()=>{});await electronControl?.close().catch(()=>{});await electron?.close().catch(()=>{});await lab.close();process.exit();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  await new Promise(()=>{});
}catch(error){metadata.fatal=String(error);await save();console.error(error);await context?.close().catch(()=>{});await electronControl?.close().catch(()=>{});await electron?.close().catch(()=>{});await lab.close();process.exitCode=1;}
