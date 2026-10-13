import {chromium} from 'playwright';
let credentials,transport,browser,page;
const send=m=>process.parentPort.postMessage(m);
process.parentPort.on('message',async({data:m})=>{
  if(m.protocol){if(m.protocol.transportClosed)transport?.onclose?.();else transport?.onmessage?.(m.protocol);return;}
  if(m.credentials){credentials=m.credentials;return;}
  if(!m.job)return;
  try{
    if(!browser){transport={send:cdp=>send({cdp,token:credentials.token}),close(){this.onclose?.();},onmessage:null,onclose:null};browser=await chromium.connectOverCDP(transport,{noDefaults:true,timeout:15000});page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(6000);}
    const before=Number(await page.locator('#progress').innerText());
    if(m.job.op==='advance'){await page.getByRole('button',{name:'自动推进',exact:true}).click();await page.waitForFunction(n=>Number(document.querySelector('#progress').textContent)>n,before);}
    const value={counter:Number(await page.locator('#progress').innerText()),text:await page.locator('#text').inputValue(),paste:await page.locator('#paste').inputValue()};
    send({result:{id:m.job.id,value}});
  }catch(error){send({result:{id:m.job.id,error:error.message}});}
});
