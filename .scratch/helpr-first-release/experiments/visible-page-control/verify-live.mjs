import { chromium } from 'playwright';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir=String(await readFile(new URL('./artifacts/latest.txt',import.meta.url))).trim();
const live=JSON.parse(await readFile(path.join(dir,'live.json')));
const e=await chromium.connectOverCDP('http://127.0.0.1:'+live.electronPort,{noDefaults:true});
const c=await chromium.connectOverCDP('http://127.0.0.1:'+live.chromiumPort,{noDefaults:true});
const ePages=e.contexts().flatMap(x=>x.pages());
const shell=ePages.find(p=>p.url().endsWith('/shell.html'));
const host=(name,value)=>shell.evaluate(({name,value})=>window.hostLab.command(name,value),{name,value});
const findTask=async(pages,name)=>{for(const p of pages){if(await p.evaluate(()=>window.lab?.snapshot().task).catch(()=>null)===name)return p;}throw Error('missing '+name);};
const a=await findTask(ePages,'electron-A');
const out={recordedAt:new Date().toISOString(),correction:'浮窗复核改用已经验证的外部 CDP 页面集合；原始失败保留。',results:[]};
await host('marker',{stage:'follow-up-overlay',label:'all'});
try{
  const overlay=ePages.find(p=>p.url().endsWith('/overlay.html'));
  if(!(await host('status')).overlayVisible)await host('overlay');
  const before=await a.locator('#entry').inputValue();
  await overlay.locator('#chat').fill('自动浮窗复核');
  const after=await a.locator('#entry').inputValue();
  if(before!==after)throw Error('business input changed');
  out.results.push({name:'electron-overlay-target-separation-recheck',status:'passed',businessBefore:before,businessAfter:after,overlayValue:await overlay.locator('#chat').inputValue()});
  await overlay.locator('#chat').fill('');await host('overlay');
  const cPages=[];for(const name of ['chromium-A','chromium-B'])cPages.push(await findTask(c.contexts().flatMap(x=>x.pages()),name));
  const session=await cPages[1].context().newCDPSession(cPages[1]);const {windowId}=await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
  let state;
  for(let n=0;n<30;n++){state=(await session.send('Browser.getWindowBounds',{windowId})).bounds;if(state.windowState==='minimized')break;await new Promise(r=>setTimeout(r,50));}
  if(state.windowState!=='minimized')throw Error('window was not minimized');
  await Promise.all(cPages.map(p=>p.evaluate(()=>window.lab.stage('follow-up-minimized'))));
  const beforeMinimized=await Promise.all(cPages.map(p=>p.evaluate(()=>window.lab.snapshot())));
  await Promise.all(cPages.map(async p=>{const n=await p.locator('#count').innerText();await p.locator('#increment').click({timeout:7000});await p.waitForFunction(n=>document.querySelector('#count').textContent!==n,n);}));
  const afterMinimized=await Promise.all(cPages.map(p=>p.evaluate(()=>window.lab.snapshot())));
  out.results.push({name:'chromium-confirmed-minimized',status:'passed',windowId,state,before:beforeMinimized,after:afterMinimized});
  await session.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});await session.detach();
  for(const p of cPages)await p.evaluate(()=>window.lab.manual());
  await cPages[0].bringToFront();
  await host('show','A');await host('focus','A');await host('marker',{stage:'human-ready',label:'all'});
  console.log(JSON.stringify(out,null,2));
}catch(error){out.error=String(error);console.error(error);process.exitCode=1;}
finally{await writeFile(path.join(dir,'follow-up.json'),JSON.stringify(out,null,2)+'\n');await c.close();await e.close();}
