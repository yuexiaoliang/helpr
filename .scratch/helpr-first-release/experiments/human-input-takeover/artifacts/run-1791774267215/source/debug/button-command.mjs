// 单独验证真实 shell.html 的按钮事件入口；宿主通信是明确的夹具，不能证明原生布局。
import {chromium} from '../../visible-page-control/node_modules/playwright/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.argv[2]||root+'/shell.html');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();const errors=[],results=[];
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
 window.commandCalls=[];
 window.takeoverLab={
  command:async(name,value)=>{window.commandCalls.push({name,value});return {accepted:true};},
  onState:callback=>window.stateCallback=callback
 };
});
try{
 await page.goto(pathToFileURL(source).href);
 for(const [button,value] of [['只看 A','A'],['只看 B','B'],['同时查看','split']]){
  const before=await page.evaluate(()=>commandCalls.length);
  await page.getByRole('button',{name:button,exact:true}).click();
  const calls=await page.evaluate(()=>commandCalls);
  results.push({button,expected:{name:'view',value},actual:calls.at(-1)||null,pass:calls.length===before+1&&calls.at(-1).name==='view'&&calls.at(-1).value===value});
 }
 const result={at:new Date().toISOString(),source,browser:browser.version(),scope:'real HTML button events with host bridge fixture; not native layout or human evidence',pass:errors.length===0&&results.every(row=>row.pass),results,errors};
 if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));process.exitCode=result.pass?0:1;
}finally{await browser.close();}
