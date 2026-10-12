import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('../visible-page-control/node_modules/playwright');
let token,transport,browser,seq=500000;const pending=new Map();
const deliver=value=>process.connected&&process.send(value);
const raw=(method,params={},sessionId,tokenMode)=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});deliver({cdp:{id,method,params,...(sessionId?{sessionId}:{})},token:tokenMode==='missing'?undefined:tokenMode==='forged'?'not-a-credential':token});
});
function buildTransport(){
  return {send:message=>deliver({cdp:message,token}),close(){deliver({disconnect:true});this.onclose?.();},onmessage:null,onclose:null};
}
process.on('message',async m=>{
  if(m.credentials){token=m.credentials.token;deliver({ready:true});return;}
  if(m.protocol){const p=pending.get(m.protocol.id);if(p){pending.delete(m.protocol.id);m.protocol.error?p.reject(new Error(m.protocol.error.message)):p.resolve(m.protocol.result);}
    else if(m.protocol.transportClosed){transport?.onclose?.(m.protocol.transportClosed);}
    else transport?.onmessage?.(m.protocol);return;}
  if(!m.job)return;
  const {id,op,...args}=m.job;let value;
  try {
    if(op==='connect'){transport=buildTransport();browser=await chromium.connectOverCDP(transport,{noDefaults:true,timeout:7000});for(const c of browser.contexts())c.setDefaultTimeout(4500);value=browser.contexts()[0].pages().map(p=>p.url());}
    else if(op==='disconnect'){await browser.close();value=true;}
    else if(op==='raw')value=await raw(args.method,args.params,args.sessionId,args.tokenMode);
    else if(op==='evaluate')value=await page(args).evaluate(args.expression);
    else if(op==='fill'){await page(args).locator(args.selector).fill(args.value);value=await page(args).locator(args.selector).inputValue();}
    else if(op==='click'){await page(args).locator(args.selector).click();value=true;}
    else if(op==='frameFill'){const f=page(args).frameLocator(args.frame);await f.locator(args.selector).fill(args.value);value=await f.locator(args.selector).inputValue();}
    else if(op==='goto'){await page(args).goto(args.url);value=page(args).url();}
    else if(op==='reload'){await page(args).reload();value=page(args).url();}
    else if(op==='pages')value=browser.contexts()[0].pages().map(p=>p.url());
    else if(op==='screenshot'){value=(await page(args).screenshot()).toString('base64');}
    else if(op==='upload'){await page(args).locator('input[type=file]').setInputFiles(args.file);value=await page(args).locator('input[type=file]').evaluate(el=>Array.from(el.files).map(f=>f.name));}
    else if(op==='quit'){deliver({result:{id,value:true}});process.exit(0);}
    else throw new Error('UNKNOWN_JOB');
    deliver({result:{id,value}});
  }catch(e){deliver({result:{id,error:e.message}});}
});
function page(args){const pages=browser.contexts()[0].pages();const p=args.urlMatch?pages.find(p=>p.url().includes(args.urlMatch)):pages.find(p=>p.url().includes('/page?'));if(!p)throw new Error('PAGE_NOT_FOUND');return p;}
process.on('disconnect',()=>process.exit(0));
