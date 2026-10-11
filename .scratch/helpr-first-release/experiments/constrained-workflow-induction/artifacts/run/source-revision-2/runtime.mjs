// 通用实验执行器：无网站、业务字段、栏目、提交名称或成功文案。
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../autonomous-workflow-induction/node_modules/playwright/index.mjs';
import { observe } from '../runtime-flow-replay/engine.mjs';
import { locate, checkAll } from '../workflow-reliability/executor.mjs';
import { bind, validateMaterials } from '../workflow-reliability/contract.mjs';
import { ensure, hash, save } from './protocol.mjs';
export { chromium, locate, bind };

const roles = new Set(['button','link','textbox','searchbox','document','checkbox','radio','switch','tab','option','combobox','menuitem','heading','paragraph','status','region']);
const safeUrl = s => s?.replace(/([?&](?:_wpnonce|_ajax_nonce|nonce)=)[^&\s"'<>\\]+/g,'$1[redacted]');
export async function capture(page) {
  const raw = await observe(page), nodes = [], seen = new Set();
  async function add(spec, role, name, hidden = false) {
    const key = JSON.stringify(spec); if (seen.has(key)) return; seen.add(key);
    const l = locate(page,spec);
    try {
      if (await l.count() !== 1) return;
      const info = await l.evaluate(el => { const r = el.getBoundingClientRect(); return {
        tag:el.tagName.toLowerCase(), type:el.getAttribute('type'), value:('value' in el ? el.value : el.textContent)?.trim().slice(0,1200),
        editable:el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName),
        checked:'checked' in el ? el.checked : el.getAttribute('aria-checked'), disabled:el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
        visible:!!el.getClientRects().length, inViewport:r.width>0 && r.height>0 && r.right>0 && r.left<innerWidth && r.bottom>0 && r.top<innerHeight,
        href:el.getAttribute('href'), download:el.hasAttribute('download'), submit:el.tagName==='BUTTON' && el.type==='submit' && !!el.form,
      }; });
      if ((!info.visible && !hidden) || info.type==='password') return;
      info.href = safeUrl(info.href);
      nodes.push({id:'n'+(nodes.length+1),frame:spec.frame,role,name,...Object.fromEntries(Object.entries(info).filter(([,v])=>v!==null&&v!==undefined)),target:spec});
    } catch {}
  }
  for (const frame of raw.frames) {
    if (!frame.frame || !frame.aria) continue;
    const ancestors = [];
    for (const line of frame.aria.split('\n')) {
      const m = /^(\s*)- ([a-z][a-z0-9-]*)(?: "((?:\\.|[^"\\])*)")?(.*)$/.exec(line); if (!m) continue;
      const indent=m[1].length, role=m[2]; let name=''; try { if(m[3]!==undefined)name=JSON.parse('"'+m[3]+'"'); } catch {continue;}
      while(ancestors.length && ancestors.at(-1).indent>=indent)ancestors.pop();
      const target={frame:frame.frame,by:'role',role,name};
      const level=/\[level=(\d+)\]/.exec(m[4]);if(level)target.level=Number(level[1]);
      if(name && roles.has(role)) {
        await add(target,role,name);
        if(await locate(page,target).count()>1) {
          for(const a of [...ancestors].reverse()) {
            if(a.target.name && await locate(page,a.target).count()===1) {
              const scoped={...target,within:a.target};
              await add(scoped,role,name); if(await locate(page,scoped).count()===1)break;
            }
          }
        }
      }
      ancestors.push({indent,target});
    }
    const f=frame.frame==='main'?page.mainFrame():page.frame({name:frame.frame});
    if(!f)continue;
    for (const text of await f.locator('p,h1,h2,[role="status"]').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>e.textContent.trim()).filter(t=>t&&t.length<1500))) {
      await add({frame:frame.frame,by:'text',name:text},'text',text);
    }
    await add({frame:frame.frame,by:'css',selector:'input[type="file"]'},'file-input','',true);
  }
  return {url:page.url(),nodes,aria:raw.frames.map(f=>({frame:f.frame,aria:f.aria}))};
}
export const compact = observation => ({url:observation.url,nodes:observation.nodes.map(({target,submit,download,...n})=>({...n,...(download?{download}:{}),...(submit?{submit}:{})}))});
export const fingerprint = o => hash(o.nodes.map(({id,target,...n})=>n));

function targetFor(node, task, key) {
  const target=structuredClone(node.target);
  if(key) {
    const v=task.inputs[key];ensure(v?.type==='string'&&node.name===v.value,'name-binding-mismatch');target.name={input:key};
  }
  return target;
}
export function actionFrom(p, observation, task) {
  if(p.op==='stop')throw Object.assign(new Error(p.reason),{code:'model-stopped'});
  const n=observation.nodes.find(n=>n.id===p.target);ensure(n,'stale-or-missing-node');
  if(p.op==='click')ensure(n.inViewport,'target-outside-viewport');
  const action={op:p.op,target:targetFor(n,task,p.nameInput)};
  if(p.op==='check'&&Object.values(task.inputs).some(v=>v.type==='string'&&v.value===n.name))ensure(p.nameInput,'dynamic-name-needs-binding');
  ensure(!p.valueInput||!p.literal,'mixed-input-and-literal');
  if(['fill','upload','select'].includes(p.op)) {
    ensure(p.valueInput||p.literal,'missing-value');
    if(p.valueInput) {
      const v=task.inputs[p.valueInput];ensure(v.type===(p.op==='upload'?'file':'string'),'input-type-mismatch');
      action.value={input:p.valueInput,...(v.type==='file'?{field:'path'}:{})};
    } else {ensure(p.op!=='upload','unbound-upload');action.value=p.literal;}
  } else if(p.op==='check') {ensure(n.role==='checkbox'||n.role==='switch'||n.role==='radio','check-target-type');action.value=p.checked;}
  else if(p.op==='press') {ensure(['Enter','Escape','Tab','ArrowDown','ControlOrMeta+End'].includes(p.literal),'unsupported-key');action.value=p.literal;}
  else ensure(!p.valueInput&&!p.literal,'unexpected-value');
  if(p.op==='fill')ensure(n.editable,'fill-target-type');
  if(p.op==='upload')ensure(n.type==='file','upload-target-type');
  if(p.op==='finish')ensure(n.tag==='a'&&n.href,'finish-target-type');
  ensure(!n.disabled,'disabled-control');
  return {action,effect:p.effect,before:p.op==='upload'?[]:[{kind:'visible',target:action.target}],after:[],note:p.reason};
}

// 只在显式输入观察位置被选中时把该位置的精确名称绑定到相应输入；不全局替换常量。
export function resultRule(node, task, key) {
  const v=task.inputs[key], target=structuredClone(node.target);
  if(v.type==='file')return {kind:'download',target,expected:{input:key,field:'sha256'},covers:key};
  if(node.name===v.value)target.name={input:key};
  ensure(node.value===v.value||node.name===v.value,'result-position-not-equal',{key,actual:node.value});
  return {kind:node.editable?'value':'text',target,compare:'equals',expected:{input:key},covers:key};
}
export function artifactRule(node,task,key) {
  ensure(task.inputs[key]?.type==='file'&&node.tag==='a'&&node.href,'artifact-position-type');
  const target=structuredClone(node.target);
  if(node.name===task.inputs[key].name)target.name={input:key,field:'name'};
  if(node.name===task.inputs[key].stem)target.name={input:key,field:'stem'};
  return {kind:'artifact',target,expected:{input:key,field:'sha256'},covers:key};
}

export async function openRun(task,directory,deadline,{holdUpload=false}={}) {
  await mkdir(directory,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({storageState:'../runtime-flow-replay/private/auth.json',viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(task.entryUrl,{waitUntil:'domcontentloaded',timeout:60000});
  const events=[],readyRules=[], fixedDigest=hash(task);let current,uploadWait,uploadRelease,uploadHeld,uploadRequest,uploadResponse,resolveUploadResponse,uploadUsed=false;
  let requestInFlight=0;
  const emit=async row=>{const e={at:new Date().toISOString(),...row};events.push(e);await appendFile(directory+'/events.jsonl',JSON.stringify(e)+'\n');};
  const guard=()=>{ensure(Date.now()<deadline,'total-time-budget');ensure(hash(task)===fixedDigest&&task.authorization.inputsDigest===hash(task.inputs),'task-changed');ensure(new URL(page.url()).origin===task.origin,'origin-changed');};
  const covered=()=>Object.keys(task.inputs).every(k=>readyRules.some(r=>r.covers===k));
  async function checks(rules,timeout=10000,targetPage=page) {
    guard();const standard=rules.filter(r=>r.kind!=='artifact');const evidence=await checkAll(targetPage,standard,task,directory,guard,timeout);
    for(const rule of rules.filter(r=>r.kind==='artifact')) {
      const target=locate(targetPage,bind(rule.target,task.inputs));ensure(await target.count()===1,'artifact-target-missing');
      const href=await target.getAttribute('href');ensure(href&&new URL(href,targetPage.url()).origin===task.origin,'artifact-origin');
      const response=await context.request.get(new URL(href,targetPage.url()).href,{timeout:12000});
      const actual=hash(await response.body());ensure(response.ok()&&actual===bind(rule.expected,task.inputs),'artifact-bytes-mismatch');
      evidence.push({condition:rule,ok:true,actual});
    }
    return evidence;
  }
  async function ready(timeout=0) {guard();await validateMaterials(task);ensure(covered(),'inputs-not-covered',{covered:readyRules.map(r=>r.covers),required:Object.keys(task.inputs)});return checks(readyRules,timeout);}
  page.on('response',r=>{if(r.request()===uploadRequest)resolveUploadResponse?.(r.status());});
  await page.route('**/*',async route=>{
    const req=route.request();if(['GET','HEAD','OPTIONS'].includes(req.method())){await route.continue().catch(()=>{});return;}
    requestInFlight++;
    const row={type:'mutation-request',method:req.method(),path:new URL(req.url()).pathname,effectProposal:current?.effect||'background',operation:current?.action?.op};
    try {
      guard();
      ensure(new URL(req.url()).origin===task.origin,'mutation-request-origin');
      const type=req.headers()['content-type']||'', body=req.postDataBuffer();
      let approvedUpload=false;
      if(current?.action.op==='upload'&&type.startsWith('multipart/form-data')&&body) {
        const selected=bind(current.action.value,task.inputs),file=Object.values(task.inputs).find(v=>v.type==='file'&&v.path===selected);
        if(file){const bytes=await readFile(file.path);approvedUpload=hash(bytes)===file.sha256&&body.includes(bytes);}
      }
      if(approvedUpload) {
        row.authorization='exact-authorized-upload-bytes';
        if(holdUpload&&!uploadUsed) {
          uploadUsed=true;uploadRequest=req;uploadResponse=new Promise(r=>{resolveUploadResponse=r;});
          uploadWait=new Promise(r=>{uploadRelease=r;});uploadHeld?.();await emit({...row,type:'upload-held'});await uploadWait;
        }
      } else {await ready();row.authorization='all-input-conditions';}
      await emit({...row,outcome:'allowed'});await route.continue();
    } catch(e) {await emit({...row,outcome:'blocked',code:e.code||e.name,detail:e.detail});await route.abort('blockedbyclient').catch(()=>{});}
    finally {requestInFlight--;}
  });
  function remember(rule) {const i=readyRules.findIndex(r=>r.covers===rule.covers&&r.covers);if(i>=0)readyRules.splice(i,1,rule);else readyRules.push(rule);}
  async function perform(step,{learn=false}={}) {
    guard();await validateMaterials(task);
    await checks(step.before);
    // 对所有动作采用同一阶段约束，effect 无法切换执行权限。
    if(covered()||step.effect==='commit')await ready();
    const a=bind(step.action,task.inputs),target=locate(page,a.target);
    await target.waitFor({state:a.op==='upload'?'attached':'visible',timeout:18000});ensure(await target.count()===1,'ambiguous-target');
    ensure(await target.evaluate(el=>el.ownerDocument.defaultView.origin)===task.origin,'target-origin');
    if(a.op==='finish') {
      await ready();const href=await target.getAttribute('href');ensure(href&&new URL(href,page.url()).origin===task.origin,'result-origin');
      return {resultUrl:new URL(href,page.url()).href};
    }
    const href=await target.getAttribute('href');if(a.op==='click'&&href)ensure(new URL(href,page.url()).origin===task.origin,'navigation-origin');
    if(a.op==='fill')ensure(await target.evaluate(el=>'value'in el?el.value:el.textContent)!==a.value,'input-already-satisfied');
    if(a.op==='check')ensure(await target.isChecked()!==a.value,'check-already-satisfied');
    const handle=await target.elementHandle();
    const held=new Promise(r=>{uploadHeld=r;});current=step;
    await emit({type:'dispatch',step:step.id,action:step.action,effectProposal:step.effect,covered:covered()});
    let executed=false,pending,settled,negative;
    try {
      switch(a.op) {
        case 'hover':await target.hover();break;
        case 'click':await target.click();break;
        case 'fill':await target.fill(a.value);break;
        case 'check':await target.setChecked(a.value);break;
        case 'select':await target.selectOption({label:a.value});break;
        case 'press':await target.press(a.value);break;
        case 'upload':await target.setInputFiles(a.value);break;
        case 'wait':await delay(700);break;
        default:throw Object.assign(new Error('unsupported-op'),{code:'unsupported-op'});
      }
      executed=true;
      if(a.op==='click'&&href)await page.waitForLoadState('domcontentloaded',{timeout:60000});
      if(a.op==='upload'&&holdUpload) {
        await Promise.race([held,delay(20000).then(()=>{throw new Error('upload-not-observed');})]);
        pending=await capture(page);await save(directory+'/upload-pending.json',pending);
        if(step.after.length)try{negative={passed:true,evidence:await checks(step.after,0)};}catch(e){negative={passed:false,code:e.code||e.name,detail:e.detail};}
        if(negative)await emit({type:'pending-upload-condition',negative});
        uploadRelease();const status=await Promise.race([uploadResponse,delay(30000).then(()=>{throw new Error('upload-response-timeout');})]);ensure(status<400,'upload-http-failed',{status});
        await delay(900);settled=await capture(page);await save(directory+'/upload-settled.json',settled);
        ensure(!negative?.passed,'upload-condition-false-positive');
      }
      await delay(350);
      if(learn&&['fill','check','select'].includes(a.op)) {
        const kind=a.op==='check'?'checked':'value',expected=step.action.value;
        let observationTarget=step.action.target;
        const same=await locate(page,bind(observationTarget,task.inputs)).count()===1&&await locate(page,bind(observationTarget,task.inputs)).evaluate((el,h)=>el===h,handle).catch(()=>false);
        if(!same) {
          const obs=await capture(page);let found;
          for(const n of obs.nodes)if(await locate(page,n.target).evaluate((el,h)=>el===h,handle).catch(()=>false)){found=n.target;break;}
          ensure(found,'field-identity-lost',{phase:'observe-only',executed:true});observationTarget=found;
          await emit({type:'post-action-observation-rebound',step:step.id,from:step.action.target,to:found,method:'same-DOM-node'});
        }
        const rule={kind,target:observationTarget,...(kind==='value'?{compare:'equals'}:{}),expected};
        if(step.action.value?.input)rule.covers=step.action.value.input;
        if(a.op==='check'&&step.action.target.name?.input)rule.covers=step.action.target.name.input;
        step.after=[rule];
      }
      await checks(step.after);
      for(const rule of step.after)if(rule.covers||rule.kind==='checked')remember(rule);
      return {executed,pending:pending&&'upload-pending.json',settled:settled&&'upload-settled.json',negative};
    } catch(e) {e.executed=executed;e.executionUncertain=!executed&&['click','press','upload'].includes(a.op);throw e;}
    finally {await handle?.dispose();current=undefined;}
  }
  async function publicResult(url,rules) {
    const ctx=await browser.newContext({acceptDownloads:true});const p=await ctx.newPage();
    try {await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});ensure(new URL(p.url()).origin===task.origin,'public-result-origin');const evidence=await checks(rules,15000,p);await p.screenshot({path:directory+'/runtime-public.png',fullPage:true});return evidence;}
    finally {await ctx.close();}
  }
  return {browser,page,events,readyRules,covered,remember,checks,ready,perform,publicResult,emit,
    close:async()=>{uploadRelease?.();await save(directory+'/ready-rules.json',readyRules);await browser.close();}};
}
