// 实际派发进程；模型只能提交单个封闭动作，不能传入可执行脚本。
import { chromium } from '../independent-stop/node_modules/playwright/index.mjs';
import { ExecutionControl } from '../independent-stop/control.mjs';
import { deferred } from './lab.mjs';
const executions=new Map(), owners=new Map(), pages=new Map(), gates=new Map(), popupJobs=new Set();let browser;
const emit=row=>process.send({event:{pid:process.pid,eventAt:Date.now(),...row}});
const ensure=(yes,code)=>{if(!yes)throw new Error(code);};
export async function identity(page){const c=await page.context().newCDPSession(page);try{return (await c.send('Target.getTargetInfo')).targetInfo;}finally{await c.detach();}}
async function remember(page){const id=await identity(page);pages.set(id.targetId,page);return id;}
function current(lease,operation){
  const e=executions.get(lease.task);
  if(!e||e.execution!==lease.execution||e.ticket.generation!==lease.generation){emit({kind:'rejected-identity',...lease,operation});throw new Error('stale-execution');}
  e.control.check(e.ticket,operation);return e;
}
function owned(lease,pageId,operation){const e=current(lease,operation);if(owners.get(pageId)!==lease.task){emit({kind:'rejected-page-owner',...lease,pageId,operation});throw new Error('foreign-page');}ensure(pages.has(pageId)&&!pages.get(pageId).isClosed(),'page-closed');return e;}
function dispatch(lease,pageId,operation,fn){const e=owned(lease,pageId,operation);return e.control.dispatch(e.ticket,operation,signal=>{emit({kind:'primitive-start',...lease,pageId,operation});return fn(pages.get(pageId),signal);});}
async function bind(message){
  const {task,execution,rootId}=message;let old=executions.get(task),control;
  if(old){old.control.stop();await old.control.settled();control=old.control;control.startNewExecution();}else control=new ExecutionControl(task,row=>emit({...row,execution:executions.get(task)?.execution}));
  for(const [id,owner] of owners)if(owner===task)owners.delete(id);
  for(const context of browser.contexts())for(const p of context.pages())await remember(p);
  ensure(pages.has(rootId),'root-not-found');
  const entry={control,ticket:control.ticket(),execution,rootId};executions.set(task,entry);owners.set(rootId,task);
  const lease={task,execution,generation:entry.ticket.generation};
  const root=pages.get(rootId);
  if(old?.popupHandler)root.off('popup',old.popupHandler);
  const popupHandler=popup=>{
    const job=(async()=>{try{current(lease,'popup-bind');const id=await remember(popup);current(lease,'popup-bind-result');ensure(id.openerId===rootId,'popup-opener-mismatch');ensure(!owners.has(id.targetId),'popup-already-owned');owners.set(id.targetId,task);emit({kind:'popup-bound',...lease,pageId:id.targetId,openerId:id.openerId});}catch(e){emit({kind:'popup-binding-rejected',...lease,error:e.message});}})();
    popupJobs.add(job);job.finally(()=>popupJobs.delete(job));
  };root.on('popup',popupHandler);entry.popupHandler=popupHandler;
  emit({kind:'execution-bound',...lease,pageId:rootId});return lease;
}
async function perform(message){
  const {lease,action,queueGate,retryGate,timeout=15000,typeDelay=55}=message;
  current(lease,'receive-action');
  if(queueGate){const g=deferred();gates.set(queueGate,g);emit({kind:'dispatch-queued',...lease,gate:queueGate});await g.promise;}
  const {pageId,op,role,name,value=''}=action;
  owned(lease,pageId,'action');
  ensure(['click','fill','type','finish'].includes(op),'unsupported-operation');
  if(op==='finish'){emit({kind:'finish-accepted',...lease,pageId,reply:action.reply});return {finished:true,reply:action.reply};}
  ensure(['button','textbox','link'].includes(role)&&typeof name==='string'&&name.length>0,'invalid-target');
  const one=()=>dispatch(lease,pageId,op,(page,signal)=>{
    const target=page.getByRole(role,{name,exact:true});const options={signal,timeout};
    if(op==='click')return target.click(options);
    if(op==='fill')return target.fill(value,options);
    return target.pressSequentially(value,{...options,delay:typeDelay});
  });
  try{await one();}
  catch(e){
    if(!retryGate||e.name!=='TimeoutError')throw e;
    const g=deferred();gates.set(retryGate,g);emit({kind:'retry-queued',...lease,gate:retryGate});await g.promise;
    // 重试仍过同一个逐原语入口，不借用释放队列时的新代次。
    await one();
  }
  current(lease,'action-result');emit({kind:'action-complete',...lease,pageId,op});return {finished:false};
}
async function handle(m){
  if(m.method==='connect'){browser=await chromium.connectOverCDP(m.endpoint,{noDefaults:true});return {pid:process.pid,version:browser.version()};}
  if(m.method==='bind')return bind(m);
  if(m.method==='release'){gates.get(m.gate)?.resolve();return true;}
  if(m.method==='stop'){const e=current(m.lease,'stop-request');e.control.stop();await e.control.settled();emit({kind:'stop-ack',...m.lease});return true;}
  if(m.method==='observe'){
    current(m.lease,'observe');await Promise.all([...popupJobs]);current(m.lease,'observe-ready');
    const result=[];
    for(const [id,owner]of owners)if(owner===m.lease.task&&!pages.get(id).isClosed()){
      const snapshot=await dispatch(m.lease,id,'observe',(p,signal)=>p.locator('body').ariaSnapshot({signal,timeout:5000}));
      result.push({pageId:id,url:pages.get(id).url(),snapshot});
    }
    current(m.lease,'observe-result');emit({kind:'observation',...m.lease,pages:result});return result;
  }
  if(m.method==='action')return perform(m);
  if(m.method==='stats')return {pid:process.pid,memory:process.memoryUsage()};
  if(m.method==='close'){for(const e of executions.values())e.control.stop();for(const g of gates.values())g.resolve();await Promise.all([...executions.values()].map(e=>e.control.settled()));await browser.close();return true;}
  throw new Error('unknown-method');
}
process.on('message',m=>{handle(m).then(result=>process.send({id:m.id,result}),e=>{emit({kind:'rpc-error',lease:m.lease,method:m.method,error:e.name+': '+e.message});process.send({id:m.id,error:{name:e.name,message:e.message}});});});
