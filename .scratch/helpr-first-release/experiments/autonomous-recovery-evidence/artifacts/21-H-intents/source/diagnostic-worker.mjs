import {createRequire} from 'node:module';import {run} from './diagnostic.mjs';
const require=createRequire(import.meta.url),{chromium}=require('../visible-page-control/node_modules/playwright');
let config,transport,browser,sequence=0;const pending=new Map();
const send=m=>process.connected&&process.send(m);
process.on('message',async m=>{
  if(m.credentials){config=m.credentials;return;}
  if(m.protocol){if(m.protocol.transportClosed)transport?.onclose?.();else transport?.onmessage?.(m.protocol);return;}
  if(m.reply){const p=pending.get(m.reply);if(p){pending.delete(m.reply);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}return;}
  if(m.job){try{
    transport={send:cdp=>send({cdp,token:config.token}),close(){this.onclose?.();},onmessage:null,onclose:null};
    browser=await chromium.connectOverCDP(transport,{noDefaults:true,timeout:15000});
    const page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(18000);page.setDefaultNavigationTimeout(45000);
    const rpc=(op,data={},override)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({rpc:{id,op,data},q:override||config.q});});
    const result=await run({...config,...m.job,page,rpc,send});send({result});
  }catch(e){send({failure:{code:e.code||e.name,message:e.message,detail:e.detail,stack:e.stack?.slice(0,1800)}});}}
});
process.on('disconnect',()=>process.exit(0));
