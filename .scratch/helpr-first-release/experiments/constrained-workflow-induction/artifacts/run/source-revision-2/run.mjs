import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, oracle } from '../autonomous-workflow-induction/fixtures.mjs';
import { session, ensure, hash, save, actionPrompt, actionSchema, positionSchema, validate, parseSchema } from './protocol.mjs';
import { openRun, capture, compact, fingerprint, actionFrom, resultRule, artifactRule, locate, bind } from './runtime.mjs';

const root=path.resolve('artifacts/run'),phase=process.argv[2]||'learn';await mkdir(root,{recursive:true});
const s=await session(root,phase),record={phase,startedAt:new Date().toISOString(),runs:[]};
const sourceFiles=['protocol.mjs','runtime.mjs','run.mjs'];
record.sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(f))])));
const load=file=>readFile(file,'utf8').then(JSON.parse);
const error=e=>({code:e.code||e.name,message:e.message?.slice(0,500),detail:e.detail,executed:e.executed,executionUncertain:e.executionUncertain});
const taskView=t=>({request:t.request,goal:t.goal,inputs:t.inputs,constraints:t.constraints});

async function resultLearning(r,task,url) {
  const ctx=await r.browser.newContext({acceptDownloads:true});const page=await ctx.newPage();
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});const obs=await capture(page);await save(r.directory+'/public-observation.json',obs);
    const rules=[];
    for(const [key,v] of Object.entries(task.inputs)) {
      const nodes=obs.nodes.filter(n=>v.type==='file'?n.tag==='a'&&n.href:n.name===v.value||n.value===v.value);
      ensure(nodes.length,'no-result-position',{key});
      const p=await s.ask('result-'+key,'从实际公开结果中选择唯一可核对该输入的观察位置。文字必须直接呈现该输入原文；文件必须是本次原文件的实际下载链接。期望值及原始字节哈希由程序固定。仅返回 target 和 reason。',
        {task:taskView(task),input:key,page:compact({...obs,nodes})},positionSchema(nodes));
      rules.push(resultRule(nodes.find(n=>n.id===p.target),task,key));
    }
    return rules;
  } finally {await ctx.close();}
}

async function learn() {
  const runIndex=(s.meta.learnRuns||0)+1;s.meta.learnRuns=runIndex;await s.persist();
  const prefixSource=process.argv[3]?await load(path.resolve(process.argv[3])):null;
  const f=await fixture(root,runIndex===1?'learn':'learn-'+runIndex),task=await s.parse(f,prefixSource?.task);
  ensure(!task.rejected,'learning-task-rejected');
  const outcome={name:f.envelope.id,trace:[],failures:[],task,status:'in-progress'};record.runs.push(outcome);
  const r=await openRun(task,f.directory,s.meta.deadline,{holdUpload:true});r.directory=f.directory;
  let noProgress=0;
  try {
    if(prefixSource) {
      outcome.reusedSource={file:process.argv[3],hash:hash(prefixSource),steps:[]};
      for(const entry of prefixSource.trace) {
        const step=structuredClone(entry.step);
        if(step.effect==='commit')break;
        if(step.action.op==='check'&&typeof step.action.target.name==='string'&&Object.values(task.inputs).some(v=>v.type==='string'&&v.value===step.action.target.name))break;
        const result=await r.perform(step);outcome.trace.push({step,result});outcome.reusedSource.steps.push(step.id);
      }
      await save(f.directory+'/results.json',outcome);
    }
    for(let n=0;n<32;n++) {
      s.guard();const obs=await capture(r.page);await save(f.directory+'/observation-'+n+'.json',obs);
      const p=await s.ask('action-'+n,actionPrompt,{task:taskView(task),page:compact(obs),
        history:outcome.trace.map(t=>({op:t.step.action.op,target:t.step.action.target,value:t.step.action.value,result:t.result})),
        readyInputs:r.readyRules.map(q=>q.covers).filter(Boolean),missingInputs:Object.keys(task.inputs).filter(k=>!r.readyRules.some(q=>q.covers===k)),
        recentFailures:outcome.failures.slice(-3),blockedRequests:r.events.filter(e=>e.outcome==='blocked').slice(-2)},actionSchema(obs.nodes,task));
      let step;
      try {
        step=actionFrom(p,obs,task);step.id='s'+(outcome.trace.length+1);
        const previous=outcome.trace.at(-1)?.step;
        if(previous&&!previous.after.length)previous.after=structuredClone(step.before);
        const result=await r.perform(step,{learn:true});
        if(step.action.op==='upload') {
          const after=await capture(r.page),nodes=after.nodes.filter(q=>q.tag==='a'&&q.href),key=step.action.value.input;
          const position=await s.ask('uploaded-artifact','上传已结束。选择本次上传文件的实际可读链接；用于读取原始字节并比较授权素材哈希。只能选择真实链接，不要使用可编辑文件名作为完成证据。',
            {task:taskView(task),input:key,page:compact({...after,nodes})},positionSchema(nodes));
          const rule=artifactRule(nodes.find(q=>q.id===position.target),task,key);step.after=[rule];await r.checks(step.after);r.remember(rule);
        }
        outcome.trace.push({step,result});
        console.log(JSON.stringify({phase,name:outcome.name,step:step.id,op:step.action.op,target:step.action.target,effect:step.effect}));
        if(result.resultUrl) {
          const rules=await resultLearning(r,task,result.resultUrl);
          const runtimeEvidence=await r.publicResult(result.resultUrl,rules);
          const independent=await oracle(r.browser,result.resultUrl,f);
          const candidate={schema:1,createdAt:new Date().toISOString(),source:outcome.reusedSource||'fresh-constrained-model-exploration',template:task,
            entryChecks:outcome.trace[0].step.before,steps:outcome.trace.map(t=>t.step),resultRules:rules};
          candidate.seal=hash({steps:candidate.steps,resultRules:candidate.resultRules,template:task});
          await save(root+'/candidate.json',candidate);outcome.status='learned-unvalidated';outcome.result={url:result.resultUrl,runtimeEvidence,independent};break;
        }
        const next=await capture(r.page);noProgress=fingerprint(obs)===fingerprint(next)?noProgress+1:0;
        ensure(noProgress<3,'no-progress-limit');
      } catch(e) {
        outcome.failures.push({proposal:p,step,error:error(e)});await save(f.directory+'/results.json',outcome);
        // 动作已执行则不重新提议或重复动作；观察位置校准只在通用 perform 中按同一 DOM 节点进行。
        if(e.executed||e.executionUncertain||['model-stopped','no-progress-limit'].includes(e.code))throw e;
        noProgress++;console.log(JSON.stringify({phase,failure:error(e),noProgress}));ensure(noProgress<3,'no-progress-limit');
      }
      await save(f.directory+'/results.json',outcome);
    }
    ensure(outcome.status==='learned-unvalidated','step-budget');
  } catch(e) {outcome.status='failed';outcome.error=error(e);outcome.lastObservation=await capture(r.page).catch(()=>null);}
  finally {await r.page.screenshot({path:f.directory+'/page.png',fullPage:true}).catch(()=>{});await r.close();await save(f.directory+'/results.json',outcome);}
}

async function replay(candidate,f,task,{changed=false,effectProbe=false}={}) {
  const out={name:f.envelope.id,trace:[],status:'running',candidateHash:hash(candidate),taskHash:hash(task)};record.runs.push(out);
  const r=await openRun(task,f.directory,s.meta.deadline,{holdUpload:true});r.directory=f.directory;
  let changedOnce=false,probed=false;
  try {
    ensure(candidate.seal===hash({steps:candidate.steps,resultRules:candidate.resultRules,template:candidate.template}),'candidate-seal-changed');
    await r.checks(candidate.entryChecks);
    for(const original of candidate.steps) {
      const step=structuredClone(original);
      if(changed&&!changedOnce&&step.action.op==='fill') {
        const target=locate(r.page,bind(step.action.target,task.inputs));await target.waitFor({state:'visible'});
        await target.evaluate(el=>{el.setAttribute('aria-label','实验更名后的输入');if(el.hasAttribute('placeholder'))el.setAttribute('placeholder','实验更名后的输入');});
        changedOnce=true;await r.emit({type:'fixture-control-changed',step:step.id});
      }
      if(effectProbe&&!probed&&step.effect==='commit') {
        ensure(r.covered(),'effect-probe-needs-ready-stage');
        const field=r.readyRules.find(rule=>rule.kind==='value'&&rule.covers&&task.inputs[rule.covers].type==='string');ensure(field,'effect-probe-no-field');
        const target=locate(r.page,bind(field.target,task.inputs)),value=bind(field.expected,task.inputs);
        await target.fill('实验注入：尚未满足授权内容');const before=r.events.filter(e=>e.type==='dispatch').length;
        let caught;
        try{await r.perform({...step,effect:'read'});}catch(e){caught=error(e);}
        const after=r.events.filter(e=>e.type==='dispatch').length;
        out.effectProbe={actualAction:step.action,incorrectProposal:'read',caught,dispatchPrevented:before===after};
        ensure(caught&&before===after,'wrong-effect-bypassed-ready-check');
        await target.fill(value);await r.ready();probed=true;
        await save(f.directory+'/effect-probe.json',out.effectProbe);
      }
      const result=await r.perform(step);out.trace.push({id:step.id,op:step.action.op,...result});
      if(result.resultUrl) {
        out.result={url:result.resultUrl,runtimeEvidence:await r.publicResult(result.resultUrl,candidate.resultRules),independent:await oracle(r.browser,result.resultUrl,f)};
        out.status='completed';break;
      }
    }
    ensure(out.status==='completed','no-verified-result');if(effectProbe)ensure(probed,'no-actual-commit-probe');
  } catch(e) {out.error=error(e);out.status=changedOnce&&!e.executed?'correctly-blocked':'failed';out.lastObservation=await capture(r.page).catch(()=>null);}
  finally {out.modelCallsDuringBrowserReplay=0;await r.page.screenshot({path:f.directory+'/page.png',fullPage:true}).catch(()=>{});await r.close();await save(f.directory+'/results.json',out);}
  console.log(JSON.stringify({phase,name:out.name,status:out.status,error:out.error}));return out;
}

async function calibrate() {
  const c=await load(root+'/candidate.json'),f=await fixture(root,'calibration'),task=await s.parse(f,c.template);ensure(!task.rejected,'calibration-rejected');
  const out=await replay(c,f,task,{effectProbe:true});
  if(out.status==='completed') {c.validatedAt=new Date().toISOString();c.validationEvidence='calibration/results.json';await save(root+'/frozen-candidate.json',c);}
}
async function evaluate() {
  const c=await load(root+'/frozen-candidate.json');
  ensure(c.validatedAt,'candidate-not-validated');
  for(const name of ['heldout','heldout-collision']) {
    const f=await fixture(root,name),task=await s.parse(f,c.template);ensure(!task.rejected,'heldout-rejected');await replay(c,f,task);
  }
  for(const variant of ['draft','update','summarize']) {
    const f=await fixture(root,'negative-'+variant,variant),task=await s.parse(f,c.template);
    const out={name:f.envelope.id,status:task.rejected?'correctly-rejected':'incorrectly-accepted',reason:task.reason,browserDispatched:false};
    record.runs.push(out);await save(f.directory+'/results.json',out);
  }
  const f=await fixture(root,'changed-control'),task=await s.parse(f,c.template);ensure(!task.rejected,'changed-control-parse-rejected');await replay(c,f,task,{changed:true});
  const protocolChecks=[];
  for(const invalid of [{proposal:{}},{compatible:true},{compatible:'true'}]) {
    try{validate(invalid,parseSchema);protocolChecks.push({invalid,status:'unexpectedly-accepted'});}catch(e){protocolChecks.push({invalid,status:'rejected',error:error(e)});}
  }
  await save(root+'/protocol-negatives.json',protocolChecks);
}

try {if(phase==='learn')await learn();else if(phase==='calibrate')await calibrate();else if(phase==='evaluate')await evaluate();else throw new Error('unknown-phase');}
catch(e){record.error=error(e);console.log(JSON.stringify({phase,error:record.error}));process.exitCode=1;}
finally {
  record.endedAt=new Date().toISOString();record.calls=s.meta.calls.length;record.tokens=s.meta.calls.reduce((n,c)=>n+(c.usage?.total_tokens||0),0);
  await save(root+'/'+phase+'-summary-'+Date.now()+'.json',record);await s.persist();
  console.log(JSON.stringify({phase,calls:record.calls,tokens:record.tokens,runs:record.runs.map(r=>({name:r.name,status:r.status,error:r.error}))}));
}
