import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../runtime-flow-replay/node_modules/playwright/index.mjs';
import { atomicJSON } from '../ai-parallel-binding/control.mjs';
import { check } from './versions.mjs';

// 从已观察到的当前主题正文容器读取；不发布、不修订原执行记录。
const root=fileURLToPath(new URL('./artifacts/current/',import.meta.url));
const browser=await chromium.launch({headless:true});const checks=[];
try{
  const context=await browser.newContext();
  for(const task of 'ABC'){
    const bundle=JSON.parse(await readFile(root+'bundle-'+task+'.json'));
    const result=JSON.parse(await readFile(root+'publication-'+task+'/result.json'));
    const page=await context.newPage();await page.goto(result.resultUrl,{waitUntil:'domcontentloaded'});
    const content=page.locator('main .wp-block-post-content');check(await content.count()===1,'article-container-count');
    const actual=await content.evaluate(el=>({
      childNodes:[...el.childNodes].filter(n=>n.nodeType===1||n.textContent.trim()).map(n=>({type:n.nodeType,tag:n.tagName||null,text:n.textContent})),
      paragraphs:[...el.querySelectorAll('p')].map(p=>p.textContent),
      attachments:[...el.querySelectorAll('.wp-block-file a')].map(a=>({text:a.textContent,url:a.href})),
      html:el.innerHTML,
    }));
    check(actual.paragraphs.length===1&&actual.paragraphs[0]===bundle.content.body,'article-body-not-exact');
    check(actual.childNodes.length===2&&actual.childNodes[0].tag==='P'&&actual.childNodes[1].tag==='DIV','unexpected-article-content');
    check(actual.attachments.length===2&&actual.attachments.every(a=>a.url===result.publication.attachmentUrl),'article-attachment-mismatch');
    checks.push({task,passed:true,url:page.url(),unauthenticated:true,exactBody:true,expectedContent:bundle.content.id,actual});await page.close();
  }
  await atomicJSON(root+'exact-public-verification.json',{passed:true,checks});
  console.log(JSON.stringify({passed:true,articles:checks.length}));
}finally{await browser.close();}
