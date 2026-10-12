// Read-only minimized reproduction, deliberately outside the recovery candidate.
import path from 'node:path';import {here,load,save} from './common.mjs';import {locate} from '../workflow-reliability/executor.mjs';
export async function run({page,out,stopAt}){
 const events=[],tag='[DEBUG-recovery-editor]',clean=s=>String(s).replace(/([?&](?:_wpnonce|_ajax_nonce|nonce)=)[^&\s"'<>\\]+/g,'$1[redacted]');
 page.on('pageerror',e=>events.push({tag,type:'pageerror',message:clean(e.message),stack:clean(e.stack).slice(0,1800)}));
 page.on('console',m=>{if(m.type()==='error')events.push({tag,type:'console',message:clean(m.text()).slice(0,1200)});});
 page.on('requestfailed',r=>events.push({tag,type:'requestfailed',url:clean(r.url()),error:r.failure()}));
 page.on('response',r=>{if(r.status()>=400)events.push({tag,type:'http-failure',url:clean(r.url()),status:r.status()});});
 const pending=new Map();page.on('request',r=>pending.set(r,{url:clean(r.url()),start:Date.now()}));page.on('requestfinished',r=>pending.delete(r));page.on('requestfailed',r=>pending.delete(r));
 const started=Date.now();await page.goto('http://home.ts-ali.internal:38080/wp-admin/'+(stopAt==='dashboard'?'':'post.php?post=6&action=edit'),{waitUntil:'commit'});
 const flow=load(path.join(here,'flow.json')),target=locate(page,(stopAt==='dashboard'?flow.steps[0].before:flow.steps[0].after)[0].target);let beforePassed=true,passed=true;
 try{await target.waitFor({state:'visible',timeout:10000});}catch{beforePassed=false;}
 const beforeMs=Date.now()-started;save(path.join(out,'pending-after-short-check.json'),{pending:[...pending.values()],body:await page.evaluate(()=>({body:!!document.body,readyState:document.readyState}))});await page.waitForLoadState('domcontentloaded',{timeout:90000});
 try{await target.waitFor({state:'visible',timeout:10000});}catch{passed=false;}
 const capabilities=[];
 if(stopAt==='frame-owner'){
   const cdp=await page.context().newCDPSession(page),tree=await cdp.send('Page.getFrameTree'),frameId=tree.frameTree.childFrames[0].frame.id;
   const owner=await cdp.send('DOM.getFrameOwner',{frameId});const resolved=await cdp.send('DOM.resolveNode',{backendNodeId:owner.backendNodeId});capabilities.push({name:'owned-frame-owner-and-node',passed:Number.isInteger(owner.backendNodeId)&&resolved.object.subtype==='node'});
   for(const [name,method,params] of [['unknown-frame','DOM.getFrameOwner',{frameId:'unowned-frame-fixture'}],['missing-frame','DOM.getFrameOwner',{}],['unknown-backend-node','DOM.resolveNode',{backendNodeId:999999999}]]){try{await cdp.send(method,params);capabilities.push({name,passed:false});}catch(e){capabilities.push({name,passed:true,reason:e.message});}}
   const value=()=>target.evaluate(el=>'value'in el?el.value:el.textContent);const original=await value();await target.click();capabilities.push({name:'actual-iframe-click-without-changing-record',passed:await value()===original});await cdp.detach();
 }
 const state=await page.evaluate(()=>({readyState:document.readyState,secure:isSecureContext,scripts:document.scripts.length,frames:[...document.querySelectorAll('iframe')].map(e=>({name:e.name,src:e.getAttribute('src'),srcdoc:e.hasAttribute('srcdoc')})),resources:performance.getEntriesByType('resource').filter(r=>r.duration>3000).map(r=>({name:r.name,duration:r.duration})),body:document.body.innerText.slice(-1800)}));
 const result={beforePassed,beforeMs,passed,capabilities,elapsedMs:Date.now()-started,events,state};save(path.join(out,'diagnostic.json'),result);return result;
}
