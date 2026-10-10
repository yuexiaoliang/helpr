import { _electron, chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { createLab } from './server.mjs';

// 独立重开真人样本，不重跑已完成的双候选自动实验。
const root=path.dirname(fileURLToPath(import.meta.url));
const electronPath=createRequire(import.meta.url)('electron');
const out=path.join(root,'artifacts','manual-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
await writeFile(path.join(root,'artifacts/latest-manual.txt'),out+'\n');
const lab=await createLab(out);
const socket=net.createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const electronPort=socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const metadata={startedAt:new Date().toISOString(),scope:'Electron human-input sample; fixture UI preflight only; not a full automated replay',base:lab.base,electronPort,manualStatus:'preparing'};
const results=[];
const save=async()=>{await lab.flush();await writeFile(path.join(out,'results.json'),JSON.stringify({metadata,results},null,2)+'\n');};
let electron, control, closing=false, finish;
const finished=new Promise(resolve=>{finish=resolve;});
async function shutdown(reason){
  if(closing)return;closing=true;
  metadata.endedAt=new Date().toISOString();metadata.closedBecause=reason;
  await control?.close().catch(()=>{});
  await electron?.close().catch(()=>{});
  await save();await lab.close();finish();
}
async function waitUntil(fn){
  for(let n=0;n<200;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Electron fixture preparation timed out');
}
try{
  electron=await _electron.launch({executablePath:electronPath,args:[path.join(root,'electron-main.cjs')],env:{...process.env,LAB_BASE:lab.base,LAB_DIR:out,LAB_CDP_PORT:String(electronPort),LAB_START_HIDDEN:'1'},timeout:40000});
  await waitUntil(()=>electron.evaluate(()=>!!global.labHost));
  const host=(name,value)=>electron.evaluate((_,arg)=>global.labHost.command(arg.name,arg.value),{name,value});
  await waitUntil(()=>electron.evaluate(async()=>{
    const ready=await Promise.all(['A','B'].map(async label=>{
      const wc=global.labHost.map.get(label);
      return wc.getURL().includes('/fixture')&&await wc.executeJavaScript('window.lab?.snapshot().task')==='electron-'+label;
    }));
    return ready.every(Boolean);
  }));
  metadata.initialTargets=await fetch('http://127.0.0.1:'+electronPort+'/json/list').then(response=>response.json());
  control=await chromium.connectOverCDP('http://127.0.0.1:'+electronPort,{noDefaults:true});
  control.contexts().forEach(context=>context.setDefaultTimeout(7000));
  const pages=[];
  for(const label of ['electron-A','electron-B'])pages.push(await waitUntil(async()=>{
    for(const page of control.contexts().flatMap(context=>context.pages())){
      if(await page.evaluate(()=>window.lab?.snapshot().task).catch(()=>null)===label)return page;
    }
  }));
  await host('show','A');
  lab.setPhase('automated-fixture-controls-preflight');
  await host('marker',{stage:'automated-fixture-controls-preflight',label:'A'});
  const page=pages[0];
  await page.evaluate(()=>window.lab.manual());
  await page.reload();
  const afterReload=await page.evaluate(()=>({state:window.lab.snapshot(),visible:document.querySelector('#manual-done').checkVisibility()}));
  await Promise.all([page.waitForURL('**/next'),page.locator('#navigate').click()]);
  await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  const afterNavigation=await page.evaluate(()=>{
    const button=document.querySelector('#manual-done'),rect=button.getBoundingClientRect();
    return {state:window.lab.snapshot(),visible:button.checkVisibility(),inViewport:rect.top>=0&&rect.bottom<=innerHeight,rect:rect.toJSON()};
  });
  if(!afterReload.visible||afterReload.state.stage!=='human'||!afterNavigation.visible||!afterNavigation.inViewport||afterNavigation.state.stage!=='human')throw new Error('Completion control did not survive reload/navigation/scroll');
  results.push({name:'completion-control-reload-navigation-scroll',status:'passed',evidence:{afterReload,afterNavigation}});
  for(const [index,target] of pages.entries()){
    await target.goto(lab.base+'/fixture');
    await target.evaluate(label=>{window.lab.bind(label);window.lab.manual();},'electron-'+['A','B'][index]);
  }
  await pages[0].screenshot({path:path.join(out,'electron-A-ready.png')});
  metadata.manualStatus='awaiting-real-user';
  metadata.versions=await electron.evaluate(()=>process.versions);
  lab.setPhase('human-awaiting');
  await host('marker',{stage:'human-ready',label:'all'});
  await host('focus','A');
  const live={pid:process.pid,base:lab.base,electronPort,out,manualPages:['electron-A','electron-B']};
  await writeFile(path.join(out,'live.json'),JSON.stringify(live,null,2)+'\n');
  await save();
  console.log('READY_FOR_HUMAN '+JSON.stringify(live));
  electron.on('close',()=>{void shutdown('electron-closed');});
  process.on('SIGTERM',()=>{void shutdown('SIGTERM');});
  process.on('SIGINT',()=>{void shutdown('SIGINT');});
  await finished;
}catch(error){metadata.error=String(error);console.error(error);process.exitCode=1;await shutdown('error');}
