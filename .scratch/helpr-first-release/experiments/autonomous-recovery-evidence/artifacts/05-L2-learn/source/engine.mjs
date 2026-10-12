// Experimental generic execution/reconciliation seam. Website knowledge lives in learned data.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {capture,compact} from '../staged-workflow-checks/runtime.mjs';
import {locate} from '../workflow-reliability/executor.mjs';import {bind} from '../workflow-reliability/contract.mjs';
import {here,load,save,hash,ensure,log} from './common.mjs';import {ask,object,string,choice} from './model.mjs';
export function coverage(rules,task){
  for(const [key,input] of Object.entries(task.inputs)){
    const found=rules.filter(r=>r.covers===key);ensure(found.length===1,'missing-or-duplicate-coverage:'+key);
    const r=found[0];ensure(r.kind==='checked'?r.target.name?.input===key:r.expected?.input===key,'wrong-input-binding:'+key);
    ensure(input.type==='file'?['artifact','download'].includes(r.kind)&&r.expected.field==='sha256':['text','value','checked'].includes(r.kind),'wrong-condition-kind:'+key);
  }
}
export async function run({page,rpc,send,out,proxy,q,mode,stopAt,taskId,probeIdentityUrl}){
  const flow=load(path.join(here,'flow.json'));let record=await rpc('read'),task=record.task,rules=fs.existsSync(path.join(here,'rules.json'))?load(path.join(here,'rules.json')):null,navChain=Promise.resolve();
  const finalSteps=flow.steps.filter(s=>s.effect==='commit'&&s.action.op!=='finish');
  const readyRules=flow.steps.filter(s=>s.effect!=='commit').flatMap(s=>s.after).filter(r=>r.covers||r.kind==='checked');
  const dedupReady=[...new Map(readyRules.map(r=>[r.covers||JSON.stringify(r.target),r])).values()];
  const halt=async phase=>{await navChain;send({checkpoint:phase});await new Promise(()=>{});};
  const guard=async()=>{const r=await rpc('read');ensure(r.intent==='running','intent-blocks-dispatch');ensure(hash(r.task)===r.taskHash,'changed-task');return r;};
  const observe=async label=>{const o=await capture(page);save(path.join(out,label+'.json'),o);return o;};
  page.on('framenavigated',f=>{if(f!==page.mainFrame())return;const url=f.url();if(!url.startsWith(task.origin+'/'))return;navChain=navChain.then(()=>rpc('navigation',{url,method:'main-frame-navigation',time:Date.now()}));});
  async function fetchBytes(url){
    ensure(new URL(url).origin===task.origin,'download-origin');
    return new Promise((resolve,reject)=>{const req=http.request(proxy,{path:url,method:'GET',headers:{host:new URL(url).host}},res=>{const chunks=[];let n=0;res.on('data',b=>{n+=b.length;if(n>10*1024*1024){req.destroy();reject(new Error('download-too-large'));}else chunks.push(b);});res.on('end',()=>{try{ensure(res.statusCode===200,'download-status');resolve(Buffer.concat(chunks));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(20000,()=>req.destroy(new Error('download-timeout')));req.end();});
  }
  async function check(rule,{persistArtifact=false,timeout=10000}={}){
    const r=bind(rule,task.inputs),deadline=Date.now()+timeout;let evidence;
    do{
      const target=locate(page,r.target),count=await target.count();evidence={kind:r.kind,covers:rule.covers,count};
      if(count===1){
        if(r.kind==='visible'){evidence.ok=await target.isVisible();}
        else if(r.kind==='checked'){evidence.actual=await target.isChecked();evidence.ok=evidence.actual===r.expected;}
        else if(['download','artifact'].includes(r.kind)){
          const href=await target.getAttribute('href');
          if(href){const url=new URL(href,page.url()).href;try{const bytes=await fetchBytes(url);evidence={...evidence,url,sha256:hash(bytes),bytes:bytes.length,ok:hash(bytes)===r.expected};if(evidence.ok){fs.writeFileSync(path.join(out,rule.covers+'-download.bin'),bytes);if(persistArtifact)await rpc('artifact',{...evidence,key:rule.covers,source:'unique-observed-anchor-and-downloaded-bytes'});}}catch(e){evidence.error=e.message;}}
        }else{evidence.actual=r.kind==='value'?await target.evaluate(el=>'value'in el?el.value:el.textContent):(await target.innerText()).trim();evidence.ok=evidence.actual===r.expected;}
      }
      if(evidence.ok)return evidence;
      if(Date.now()<deadline)await delay(160);
    }while(Date.now()<deadline);
    throw Object.assign(new Error('condition-not-confirmed'),{detail:{rule,evidence}});
  }
  async function checks(list,options){const evidence=[];for(const rule of list)evidence.push(await check(rule,options));return evidence;}
  async function perform(step,{final=false,skipAfter=false}={}){
    await guard();await checks(step.before||[]);const action=bind(step.action,task.inputs),target=locate(page,action.target);await target.waitFor({state:action.op==='upload'?'attached':'visible'});ensure(await target.count()===1,'nonunique-action');
    if(action.op==='upload'){const value=Object.values(task.inputs).find(v=>v.type==='file'&&v.path===action.value);ensure(value&&hash(fs.readFileSync(value.path))===value.sha256,'material-version-changed');}
    await rpc('dispatch',{kind:final?'final':'step',id:step.id||'learned-save',action:step.action});
    if(final&&stopAt==='dispatch-gap')await halt('dispatch-gap');
    log(out,{kind:'step-start',id:step.id,op:action.op,final});
    const options={timeout:18000},navigationHref=action.op==='click'?await target.getAttribute('href'):null;
    if(action.op==='click')await target.click(options);
    else if(action.op==='fill')await target.fill(action.value,options);
    else if(action.op==='check')await target.setChecked(action.value,options);
    else if(action.op==='hover')await target.hover(options);
    else if(action.op==='upload')await target.setInputFiles(action.value,options);
    else throw new Error('unsupported-action');
    if(navigationHref)await page.waitForLoadState('domcontentloaded');
    await delay(300);await navChain;
    if(!skipAfter){
      // Keep completed uploads even if a later condition or save fails.
      for(const rule of step.after||[])await check(rule,{persistArtifact:rule.kind==='artifact'});
    }
    await rpc('checkpoint',{step:step.id,verified:!skipAfter});log(out,{kind:'step-complete',id:step.id});
  }
  async function choose(label,prompt,o,schema){const input=compact(o);delete input.aria;const result=await ask(label,prompt,{observation:input},schema);log(out,{kind:'model-proposal',source:result.source});return result;}
  function node(o,id){const n=o.nodes.find(n=>n.id===id);ensure(n,'unobserved-node');return n;}
  async function rememberIdentity(){
    await navChain;record=await rpc('read');
    const urls=[...new Set(record.navigations.map(n=>n.url).filter(url=>{const u=new URL(url);return u.origin===task.origin&&u.pathname===rules.identity.pathname&&!!u.searchParams.get(rules.identity.queryKey);}))];
    if(urls.length!==1)return null;
    await rpc('identity',{url:urls[0],ruleHash:hash(rules.identity),execution:task.executionId,taskHash:hash(task),source:'saved-navigation'});return urls[0];
  }
  async function prepare(){
    ensure(record.phase==='new'||(record.phase==='preparing'&&record.dispatches.length===0&&record.artifacts.length===0),'preparation-already-started');await rpc('checkpoint',{phase:'preparing'});await page.goto(task.entryUrl,{waitUntil:'domcontentloaded'});
    for(const step of flow.steps.filter(s=>s.effect!=='commit')){await perform(step);if(step.action.op==='upload'&&stopAt==='uploaded')await halt('uploaded');}
    coverage(dedupReady,task);await checks(dedupReady);
    let saveAction=rules?.saveAction,proof;
    if(mode==='learn'){
      const o=await observe('before-save');const result=await choose('save-action','从当前观察中选择一个把现有内容保存为草稿、但不公开发布的按钮。只提议编号。',o,object({target:choice(o.nodes.map(n=>n.id)),reason:string}));
      const n=node(o,result.proposal.target);ensure(n.role==='button'&&!n.disabled,'save-control-type');saveAction={op:'click',target:n.target};ensure(!finalSteps.some(s=>hash(s.action)===hash(saveAction)),'save-is-final-action');proof={save:result.source};
    }
    const before=page.url();await perform({id:'save-checkpoint',action:saveAction,before:[],after:[]});
    await page.waitForURL(u=>rules?!!u.searchParams.get(rules.identity.queryKey):u.searchParams.size>0,{timeout:20000});await navChain;
    if(mode==='learn'){
      const o=await observe('after-save');const u=new URL(o.url),keys=[...u.searchParams.keys()].filter(k=>u.searchParams.get(k)!==new URL(task.entryUrl).searchParams.get(k));ensure(keys.length,'no-observed-identity');
      const result=await ask('stable-identity','从保存动作前后观察到的 URL 组成部分中，选择代表这条记录稳定编号的查询参数。不要选择动作名称、临时令牌或新建入口。返回已有参数名。',{before,current:o.url,query:Object.fromEntries(u.searchParams)},object({queryKey:choice(keys),reason:string}));
      rules={schema:1,saveAction,identity:{pathname:u.pathname,queryKey:result.proposal.queryKey},readyRules:dedupReady,resultRules:flow.resultRules,finalSteps,proof:{...proof,identity:result.source}};save(path.join(here,'rules-learning.json'),rules);
    }
    ensure(await rememberIdentity(),'identity-not-formed');
    if(stopAt==='saved-navigation')await halt('saved-navigation');
    const evidence=await checks(dedupReady);await rpc('checkpoint',{phase:'prepared',evidence});return evidence;
  }
  async function publish(){
    await guard();const evidence=await checks(rules.readyRules);coverage(rules.readyRules,task);await rpc('checkpoint',{phase:'prepared',evidence});
    for(const [i,step] of finalSteps.entries())await perform(step,{final:i===finalSteps.length-1});
    const finish=flow.steps.find(s=>s.action.op==='finish');await locate(page,bind(finish.action.target,task.inputs)).waitFor({state:'visible'});
    const target=locate(page,bind(finish.action.target,task.inputs));ensure(await target.count()===1,'result-not-unique');const href=await target.getAttribute('href');ensure(href,'result-link-empty');const url=new URL(href,page.url()).href;ensure(new URL(url).origin===task.origin,'result-origin');
    await rpc('checkpoint',{resultUrl:url,source:'learned-finish-link'});await page.goto(url,{waitUntil:'domcontentloaded'});const resultEvidence=await checks(rules.resultRules);coverage(rules.resultRules,task);
    await observe('public-result');if(stopAt==='result-verified')await halt('result-verified');
    await rpc('outcome',{decision:'completed',observedEffect:'completed',resultUrl:url,evidence:resultEvidence});return url;
  }
  async function recover({persist=true}={}){
    record=await rpc('read');const base={taskId,executionId:task.executionId,intent:record.intent,previousPhase:record.phase,automaticAction:'none',pid:process.pid};
    const editor=await rememberIdentity();if(!editor)return {...base,decision:'uncertain',reason:'stable-identity-unavailable',knownArtifacts:record.artifacts};
    await page.goto(editor,{waitUntil:'domcontentloaded'});await locate(page,bind(rules.readyRules.find(r=>r.kind==='value').target,task.inputs)).waitFor({state:'visible'});await delay(900);
    const entry=locate(page,bind(rules.resultEntry.target,task.inputs));let outcome;
    if(await entry.count()===1&&await entry.isVisible()){
      const href=await entry.getAttribute('href');ensure(href&&new URL(href,page.url()).origin===task.origin,'recovery-entry-origin');const url=new URL(href,page.url()).href;
      await page.goto(url,{waitUntil:'domcontentloaded'});
      try{coverage(rules.resultRules,task);const evidence=await checks(rules.resultRules,{timeout:800});outcome={...base,decision:record.intent==='running'?'completed':'held',observedEffect:'completed',resultUrl:url,evidence};}
      catch(e){outcome={...base,decision:'uncertain',reason:'result-not-confirmed',detail:e.detail||e.message};}
    }else{
      try{coverage(rules.readyRules,task);const evidence=await checks(rules.readyRules,{timeout:900});outcome=record.dispatches.some(d=>d.kind==='final')?{...base,decision:'uncertain',reason:'final-may-have-been-dispatched',evidence}:{...base,decision:record.intent==='running'?'ready-to-continue':'held',observedEffect:'draft-ready',editorUrl:editor,evidence};}
      catch(e){outcome={...base,decision:'uncertain',reason:'draft-not-confirmed',detail:e.detail||e.message};}
    }
    await observe('recovery-observation');if(outcome.observedEffect==='completed'&&stopAt==='result-verified')await halt('result-verified');
    if(persist)await rpc('outcome',outcome);return outcome;
  }
  try{
    if(mode==='learn'){
      await prepare();const resultUrl=await publish();record=await rpc('read');await page.goto(record.editorUrl,{waitUntil:'domcontentloaded'});await delay(1400);const o=await observe('reopened-editor');
      const result=await choose('recovery-result-link','现在重新打开本任务的编辑记录。选择能打开该记录真实公开结果的链接；不要选列表、预览、其他记录或站点主页。链接必须属于当前记录。',o,object({target:choice(o.nodes.filter(n=>n.tag==='a'&&n.href).map(n=>n.id)),reason:string}));
      const n=node(o,result.proposal.target);ensure(new URL(n.href,o.url).href===resultUrl,'learned-result-entry-does-not-match-verified-result');rules.resultEntry={target:n.target};rules.proof.resultEntry=result.source;coverage(rules.resultRules,task);save(path.join(here,'rules.json'),rules);
      return {decision:'learned',resultUrl,rulesHash:hash(rules),editorUrl:record.editorUrl};
    }
    if(mode==='prepare'){await prepare();return {decision:'prepared'};}
    if(mode==='recover')return await recover();
    if(mode==='resume'){const r=await recover();save(path.join(out,'before-resume.json'),r);ensure(r.decision==='ready-to-continue','not-safe-to-resume');return {decision:'completed',resultUrl:await publish()};}
    if(mode==='guards'){
      const results=[];const reject=async(name,fn)=>{try{await fn();results.push({name,passed:false});}catch(e){results.push({name,passed:true,reason:e.message});}};
      await reject('old-process-qualification',()=>rpc('dispatch',{kind:'step'},{...q,epoch:q.epoch-1}));
      if(probeIdentityUrl)await reject('other-execution-identity',()=>rpc('identity',{url:probeIdentityUrl,source:'counterfactual-fixture'}));
      await rpc('intent',{intent:'stopped',source:'explicit-test-fixture'});await reject('stopped-old-action',()=>rpc('dispatch',{kind:'step'}));await reject('late-model-proposal',()=>rpc('proposal',{target:'old-model-output'}));
      await rpc('intent',{intent:'running',source:'explicit-continue-test-fixture'});await reject('old-action-after-explicit-continue',()=>rpc('dispatch',{kind:'step'}));
      for(const key of Object.keys(task.inputs))await reject('missing-condition-'+key,()=>coverage(rules.resultRules.filter(r=>r.covers!==key),task));
      const wrong=structuredClone(rules.resultRules);wrong[0].expected={input:'not-the-current-version'};await reject('wrong-model-input-proposal',()=>coverage(wrong,task));
      return {decision:'guard-probes',results};
    }
    if(mode==='negative'){
      record=await rpc('read');ensure(record.lastOutcome?.resultUrl,'no-observed-result-for-probe');await page.goto(record.lastOutcome.resultUrl,{waitUntil:'domcontentloaded'});
      const results=[],reject=async(name,fn)=>{try{await fn();results.push({name,passed:false});}catch(e){results.push({name,passed:true,reason:e.message,detail:e.detail});}};
      const original=task;task=structuredClone(task);const fileKey=Object.keys(task.inputs).find(k=>task.inputs[k].type==='file');task.inputs[fileKey].sha256=hash('explicit-other-material-version-fixture');
      await reject('actual-download-does-not-match-another-version',()=>check(rules.resultRules.find(r=>r.covers===fileKey),{timeout:0}));task=original;
      const wrong=structuredClone(rules.resultRules[0]);wrong.target={frame:'main',by:'css',selector:'a'};await reject('nonunique-proposed-position',()=>check(wrong,{timeout:0}));
      const switched=structuredClone(rules.resultRules[0]);switched.target=rules.resultRules.find(r=>r.covers!==switched.covers&&r.kind==='text').target;await reject('wrong-observed-position',()=>check(switched,{timeout:0}));
      return {decision:'negative-probes',source:'explicit-counterfactual-fixtures',results};
    }
    throw new Error('unsupported-run-mode');
  }catch(e){try{await observe('failure-observation');}catch{}save(path.join(out,'failure.json'),{code:e.code||e.name,message:e.message,detail:e.detail});throw e;}
}
