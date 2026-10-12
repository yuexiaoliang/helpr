import { readFile, mkdir, writeFile, appendFile, open, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../runtime-flow-replay/node_modules/playwright/index.mjs';
import { execute, locate, bind, observe } from '../runtime-flow-replay/engine.mjs';
import { atomicJSON } from '../ai-parallel-binding/control.mjs';
import { PreviewLedger, hash, check } from './versions.mjs';

const dir=fileURLToPath(new URL('.',import.meta.url));process.chdir(dir);
const task=process.argv[2];check(['A','B','C'].includes(task),'task-required');
const root=dir+'artifacts/current', output=root+'/publication-'+task;
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const lock=await open(root+'/publication.lock','wx');await lock.writeFile(String(process.pid));await lock.close();
let browser,page,openedOutput=false;
const result={task,pid:process.pid,startedAt:new Date().toISOString(),modelCalls:0,steps:[],confirmationSource:'experiment-injected'};
const journal=async row=>appendFile(output+'/events.jsonl',JSON.stringify({at:new Date().toISOString(),...row})+'\n');
try {
  const registration=await json(root+'/registration.json');
  const budget=await json(root+'/publication-budget.json');
  const reserve=async kind=>{check(Date.now()<registration.deadline,'time-budget');check(budget[kind].length<budget.limits[kind],kind+'-budget');budget[kind].push({task,pid:process.pid,at:new Date().toISOString()});await atomicJSON(root+'/publication-budget.json',budget);};
  check(!budget.preparations.some(r=>r.task===task),'task-already-attempted-reconcile-before-retry');
  const bundle=await json(root+'/bundle-'+task+'.json'), workflowBytes=await readFile(root+'/workflow.json'), workflow=JSON.parse(workflowBytes);
  const validate=async()=>new PreviewLedger(await json(root+'/preview-ledger.json')).validate(bundle,workflowBytes);
  await validate();await mkdir(output,{recursive:false});openedOutput=true;
  result.bundle=bundle.id;result.content=bundle.content.id;result.authority=bundle.authority.id;result.workflow=hash(workflowBytes);result.params=bundle.params;
  const sourceFiles=['publish.mjs','versions.mjs','../runtime-flow-replay/engine.mjs'];
  result.sourceHashes={};await mkdir(output+'/source',{recursive:true});
  for(const f of sourceFiles){const bytes=await readFile(f);result.sourceHashes[f]=hash(bytes);await writeFile(output+'/source/'+f.split('/').at(-1),bytes);}
  await reserve('preparations');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({storageState:'../runtime-flow-replay/private/auth.json',acceptDownloads:true,viewport:{width:1440,height:1000}});
  result.browserVersion=browser.version();page=await context.newPage();page.setDefaultTimeout(18000);
  await page.goto(bundle.params.entryUrl,{waitUntil:'domcontentloaded',timeout:30000});
  check(page.url().startsWith(bundle.params.entryUrl),'login-not-ready');
  // 以下是实验用例的独立就绪断言，不是重新学得的网站流程。
  async function readiness() {
    await validate();
    const frame=page.frame({name:'editor-canvas'});check(frame,'editor-missing');
    const editable=await frame.locator('[contenteditable="true"],input,textarea').evaluateAll(es=>es.map(e=>'value'in e?e.value:e.textContent));
    check(editable.filter(v=>v===bundle.params.title).length===1,'editor-title-mismatch');
    check(editable.filter(v=>v===bundle.params.body).length===1,'editor-body-mismatch');
    check(await page.getByRole('checkbox',{name:bundle.params.category,exact:true}).isChecked(),'editor-category-mismatch');
    check(!await page.getByRole('checkbox',{name:'Uncategorized',exact:true}).isChecked(),'unexpected-category');
    const deadline=Date.now()+18000;let attachmentUrl,actualHash;
    while(Date.now()<deadline){
      const urls=[...new Set(await frame.locator('a[href]').evaluateAll(es=>es.map(e=>e.href).filter(h=>h.endsWith('.xlsx'))))];
      if(urls.length===1&&new URL(urls[0]).origin===bundle.params.origin){
        const r=await context.request.get(urls[0],{timeout:10000});
        if(r.ok()){attachmentUrl=urls[0];actualHash=hash(await r.body());break;}
      }
      await delay(150);
    }
    check(actualHash===bundle.content.material.sha256,'editor-attachment-bytes-mismatch');
    const record={title:bundle.params.title,body:bundle.params.body,category:bundle.params.category,attachmentUrl,actualHash,content:bundle.content.id};
    await journal({kind:'pre-submit-readiness',...record});return record;
  }
  let resultUrl;
  const publishIndices=workflow.steps.map((step,i)=>step.action.op==='click'&&step.action.target.name==='Publish'?i:-1).filter(i=>i>=0);
  check(publishIndices.length===2,'fixture-publish-shape-changed');
  for(const [index,step] of workflow.steps.entries()) {
    check(Date.now()<registration.deadline,'time-budget');const bytes=await validate();
    check(new URL(page.url()).origin===bundle.params.origin,'page-origin-changed');
    if(publishIndices.includes(index))await readiness();
    if(index===publishIndices.at(-1))await reserve('submissions');
    await journal({kind:'before-action',index,action:step.action,bundle:bundle.id});
    let outcome;
    if(step.action.op==='upload') {
      await reserve('uploads');
      const target=locate(page,bind(step.action.target,bundle.params));
      await target.waitFor({state:'attached'});check(await target.count()===1,'upload-target-not-unique');
      // 上传已经核对的同一份 Buffer，避免文件路径在读取与上传之间被替换。
      await target.setInputFiles({name:bundle.params.fileName,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
      outcome={completed:true,bufferSha256:hash(bytes),bytes:bytes.length};
    } else outcome=await execute(page,step.action,bundle.params);
    const row={index,outcome,pageUrl:page.url()};result.steps.push(row);await journal({kind:'after-action',...row});
    resultUrl=outcome.resultUrl||resultUrl;
  }
  check(resultUrl,'result-link-missing');result.resultUrl=resultUrl;
  // 发布结果先落盘，截图失败不得把已发布结果变成未知或重新提交。
  await atomicJSON(output+'/execution-result.json',{...result,status:'published-awaiting-verification'});
  const publicContext=await browser.newContext({acceptDownloads:true});const publicPage=await publicContext.newPage();
  await publicPage.goto(resultUrl,{waitUntil:'domcontentloaded',timeout:30000});
  const heading=publicPage.getByRole('heading',{name:bundle.params.title,exact:true,level:1});await heading.waitFor();
  const actualText=await publicPage.locator('body').innerText();check(actualText.includes(bundle.params.body),'public-body-mismatch');
  const links=await publicPage.locator('a[href]').evaluateAll(es=>es.map(e=>({text:e.textContent,href:e.href,download:e.hasAttribute('download')})));
  const urls=[...new Set(links.filter(l=>new URL(l.href).pathname.endsWith('.xlsx')).map(l=>l.href))];
  check(urls.length===1,'public-attachment-count');check(new URL(urls[0]).origin===bundle.params.origin,'public-attachment-origin');
  const categories=links.filter(l=>l.href===bundle.params.origin+'/?cat=2');check(categories.some(l=>l.text.trim()===bundle.params.category),'public-category-mismatch');
  const downloadLink=publicPage.locator('a[download]').filter({visible:true});check(await downloadLink.count()===1,'download-control-count');
  const [download]=await Promise.all([publicPage.waitForEvent('download'),downloadLink.click()]);await download.saveAs(output+'/download.xlsx');
  const expected=await validate(),actual=await readFile(output+'/download.xlsx');check(actual.equals(expected),'download-bytes-mismatch');
  await writeFile(output+'/public-text.txt',actualText);
  await atomicJSON(output+'/public-observation.json',{url:publicPage.url(),heading:await heading.innerText(),text:actualText,links,unauthenticated:true});
  result.publication={url:resultUrl,attachmentUrl:urls[0],downloadSha256:hash(actual),exactBytesMatch:true,bodyExactMatch:true,category:bundle.params.category};
  result.passed=true;await atomicJSON(output+'/result.json',result);
  try{await publicPage.screenshot({path:output+'/public.png',fullPage:true,timeout:15000});result.capture={status:'passed'};}catch(error){result.capture={status:'failed',error:error.name};}
  await publicContext.close();
}catch(error){result.passed=false;result.error={name:error.name,message:error.message.slice(0,2500)};if(page&&openedOutput)await atomicJSON(output+'/failure-observation.json',await observe(page)).catch(()=>{});process.exitCode=1;}
finally{
  result.endedAt=new Date().toISOString();await atomicJSON(openedOutput?output+'/result.json':root+'/dispatch-rejected-'+Date.now()+'.json',result);await browser?.close();await rm(root+'/publication.lock');
  console.log(JSON.stringify({task,passed:result.passed,url:result.publication?.url,steps:result.steps.length,error:result.error}));
}
