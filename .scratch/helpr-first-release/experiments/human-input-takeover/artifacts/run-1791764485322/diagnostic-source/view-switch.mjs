// 真实宿主按钮的回归探针；诊断操作不计为真人证据。
import {chromium} from '../../visible-page-control/node_modules/playwright/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=process.argv.slice(2).find(value=>!value.startsWith('--'))||String(await readFile(root+'/artifacts/latest.txt')).trim();
const live=JSON.parse(await readFile(run+'/live.json'));
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+live.port,{noDefaults:true});
const pages=browser.contexts().flatMap(context=>context.pages());
const shell=pages.find(page=>page.url()===live.origin+'/shell');
const taskA=pages.find(page=>page.url()===live.origin+'/fixture?task=A');
const taskB=pages.find(page=>page.url()===live.origin+'/fixture?task=B');
const errors=[],results=[];
shell.on('pageerror',error=>errors.push(error.message));
if(process.argv.includes('--reload-shell'))await shell.reload();
const width=await shell.evaluate(()=>innerWidth);
try{
 const cases=process.argv.includes('--only-a')?[['只看 A',width]]:[['只看 A',width],['只看 B',width],['同时查看',Math.floor(width/2)]];
 for(const [button,expected]of cases){
  const before={A:await taskA.evaluate(()=>innerWidth),B:await taskB.evaluate(()=>innerWidth)};
  // 宿主文档可能后台节流；保留真实按钮点击与处理函数，仅跳过 RAF 稳定性等待。
  await shell.getByRole('button',{name:button,exact:true}).click({timeout:3000,force:true});
  const matched=await taskA.waitForFunction(expected=>innerWidth===expected,expected,{timeout:600}).then(()=>true,()=>false);
  const after={A:await taskA.evaluate(()=>innerWidth),B:await taskB.evaluate(()=>innerWidth)};
  results.push({button,expected,before,after,pass:matched&&after.A===expected});
 }
 const result={at:new Date().toISOString(),scope:'automatic diagnostic; not human input',pass:results.every(row=>row.pass)&&errors.length===0,results,errors};
 await writeFile(run+'/view-switch-diagnostic-'+Date.now()+'.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));process.exitCode=result.pass?0:1;
}finally{await browser.close();}
