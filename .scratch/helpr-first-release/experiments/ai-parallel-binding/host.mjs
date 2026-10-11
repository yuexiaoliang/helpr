import { chromium,_electron } from '../independent-stop/node_modules/playwright/index.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { until } from './lab.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(new URL('../independent-stop/package.json',import.meta.url));
export async function pageIdentity(page){const c=await page.context().newCDPSession(page);try{return (await c.send('Target.getTargetInfo')).targetInfo;}finally{await c.detach();}}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function openHost(kind,base,out){
  const port=await freePort(),endpoint='http://127.0.0.1:'+port;let app,context,control,worker;
  try{
    if(kind==='electron-cdp'){
      app=await _electron.launch({executablePath:require('electron'),args:[root+'/electron.cjs'],env:{...process.env,AI_LAB_OUT:out,AI_LAB_BASE:base,AI_LAB_PORT:String(port)},timeout:40000});
      await until(()=>app.evaluate(()=>global.aiLab?.ready));
    }else{
      context=await chromium.launchPersistentContext(out+'/profiles/chromium',{channel:'chromium',headless:false,viewport:{width:1100,height:750},args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
      worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
      const init=[context.pages()[0],await context.newPage()];
      await Promise.all(init.map((p,i)=>p.goto(base+'/boot?task='+['A','B'][i])));
    }
    control=await chromium.connectOverCDP(endpoint,{noDefaults:true});
    const pages=['A','B'].map(task=>control.contexts().flatMap(c=>c.pages()).find(p=>p.url().endsWith('task='+task)));
    if(pages.some(p=>!p))throw new Error('host-page-discovery');
    const ids=await Promise.all(pages.map(pageIdentity));
    async function mappings(targets=ids){
      if(app)return app.evaluate(({webContents},list)=>list.map(id=>({targetId:id.targetId,webContentsId:webContents.fromDevToolsTargetId(id.targetId)?.id})),targets);
      const all=await worker.evaluate(()=>globalThis.identities());
      return targets.map(id=>({targetId:id.targetId,tabId:all.targets.find(t=>t.id===id.targetId)?.tabId}));
    }
    return {kind,endpoint,pages,ids,mappings,control,app,versions:app?await app.evaluate(()=>process.versions):{chromium:control.version()},
      async show(label){if(app)return app.evaluate((_e,label)=>global.aiLab.show(label),label);await pages[['A','B'].indexOf(label)].bringToFront();return {active:(await worker.evaluate(()=>chrome.tabs.query({active:true}))).map(t=>({id:t.id,url:t.url}))};},
      async close(){await control.close();if(app)await app.close();if(context)await context.close();}};
  }catch(e){await control?.close().catch(()=>{});await app?.close().catch(()=>{});await context?.close().catch(()=>{});throw e;}
}
