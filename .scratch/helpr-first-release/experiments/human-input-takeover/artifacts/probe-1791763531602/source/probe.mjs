import {_electron,chromium} from '../visible-page-control/node_modules/playwright/index.mjs';
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
const root=path.dirname(fileURLToPath(import.meta.url)),out=root+'/artifacts/probe-'+Date.now();await mkdir(out,{recursive:true});
const registryFile=root+'/artifacts/registration.json';let registry;try{registry=JSON.parse(await readFile(registryFile));}catch(e){if(e.code!=='ENOENT')throw e;registry={startedAt:new Date((await stat(root+'/PLAN.md')).mtimeMs).toISOString(),deadline:(await stat(root+'/PLAN.md')).mtimeMs+3600000,attempts:0,limit:6,modelCalls:0};}
if(Date.now()>=registry.deadline||registry.attempts>=registry.limit)throw Error('preparation-budget');registry.attempts++;await writeFile(registryFile,JSON.stringify(registry,null,2)+'\n');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const executablePath=createRequire(new URL('../visible-page-control/package.json',import.meta.url))('electron');
let app,browser;const results=[];
try{
 app=await _electron.launch({executablePath,args:[root+'/probe.cjs'],env:{...process.env,TAKEOVER_OUT:out,TAKEOVER_PORT:String(port)},timeout:30000});
 for(let i=0;i<200;i++){if(await app.evaluate(()=>global.probe?.ready))break;await new Promise(r=>setTimeout(r,25));}
 const ready=await app.evaluate(()=>({ready:global.probe?.ready,tags:global.probe?.tags,versions:process.versions}));if(!ready.ready)throw Error('not-ready');
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
 const pages={};for(const p of browser.contexts().flatMap(c=>c.pages())){const title=await p.title();if(title.startsWith('probe-'))pages[title.slice(6)]=p;}
 const sample=async(name,operation)=>{await app.evaluate(()=>global.probe.events.length=0);await pages.A.evaluate(()=>window.events.length=0);await operation();await new Promise(r=>setTimeout(r,100));results.push({name,native:await app.evaluate(()=>global.probe.events.slice()),dom:await pages.A.evaluate(()=>window.events.slice())});};
 await sample('Playwright click',()=>pages.A.locator('#click').click());
 await sample('Playwright fill',()=>pages.A.locator('#text').fill('automation'));
 await sample('Playwright keyboard',()=>pages.A.locator('#text').pressSequentially('abc'));
 await sample('CDP insertText',async()=>{const c=await pages.A.context().newCDPSession(pages.A);await c.send('Input.insertText',{text:'自动中文'});await c.detach();});
 await sample('Electron sendInputEvent',()=>app.evaluate(()=>global.probe.views.A.webContents.sendInputEvent({type:'keyDown',keyCode:'Z'})));
 await sample('native injected A',()=>app.evaluate(()=>global.probe.monitor.injectProbe(100,150)));
 await sample('native injected chat',()=>app.evaluate(()=>global.probe.monitor.injectProbe(800,560)));
 await sample('native injected shell',()=>app.evaluate(()=>global.probe.monitor.injectProbe(200,20)));
 await writeFile(out+'/results.json',JSON.stringify({ready,results},null,2)+'\n');
 console.log(JSON.stringify({out,tags:ready.tags,results:results.map(r=>({name:r.name,native:r.native,domCount:r.dom.length}))},null,2));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({error:e.message,stack:e.stack},null,2));throw e;}
finally{await browser?.close().catch(()=>{});await app?.close().catch(()=>{});}
