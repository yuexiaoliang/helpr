// 实验候选 Module。业务状态核对由 observe 注入，不按 URL / 页面文字认领任务。
const {webContents}=require('electron');
class TaskOwnership {
 constructor({native,win,ExecutionControl,log,observe}){
  Object.assign(this,{native,win,ExecutionControl,log,observe});this.tasks=new Map();this.connection=null;this.connectionEpoch=0;this.bindSerial=0;
 }
 add(task,view){
  const r={task,view,viewVersion:1,documentEpoch:1,pauseRevision:0,reasons:new Set(),binding:null,ready:false,control:new this.ExecutionControl(task,this.log)};
  this.tasks.set(task,r);this.watch(r,view);return r;
 }
 watch(r,view){
  const wc=view.webContents;
  wc.on('did-start-navigation',details=>{if(r.view===view&&details.isMainFrame)this.invalidate(r.task,'document-change');});
  wc.on('render-process-gone',()=>{if(r.view===view)this.invalidate(r.task,'renderer-lost');});
  wc.on('destroyed',()=>{if(r.view===view)this.invalidate(r.task,'view-destroyed');});
 }
 invalidate(task,reason){
  const r=this.tasks.get(task);r.documentEpoch++;r.ready=false;r.binding=null;r.reasons.add(reason);r.control.stop();
  this.log({kind:'binding-invalidated',task,reason,documentEpoch:r.documentEpoch,viewVersion:r.viewVersion});
 }
 stop(task,reason){const r=this.tasks.get(task);r.pauseRevision++;r.reasons.add(reason);r.control.stop();this.log({kind:'task-paused',task,reason,reasons:[...r.reasons]});}
 input(event){
  this.log({kind:'native-input',...event});
  if(this.tasks.has(event.owner))this.stop(event.owner,'takeover');
  else if(event.owner==='unknown')for(const r of this.tasks.values())this.stop(r.task,'unknown-input');
 }
 bindNative(task){
  const r=this.tasks.get(task),b=r.view.getBounds();
  if(!r.view.getVisible()){this.native.untag(task);return null;}
  const identity=this.native.tagRegion(task,b.x,b.y,b.width,b.height,b.x+40,b.y+40);
  this.log({kind:'native-subtree-bound',task,identity,wcId:r.view.webContents.id,viewVersion:r.viewVersion,bounds:b});return identity;
 }
 async connect(connection){
  this.connection=connection;this.connectionEpoch++;
  connection.on('disconnected',()=>{if(this.connection!==connection)return;for(const r of this.tasks.values())this.invalidate(r.task,'connection-lost');});
  await this.readTargets();
 }
 async readTargets(){
  if(!this.connection?.isConnected())throw Error('connection-unavailable');
  const targets=new Map();
  for(const page of this.connection.contexts().flatMap(c=>c.pages())){
   if(page.isClosed())continue;const session=await page.context().newCDPSession(page);
   try{const {targetInfo}=await session.send('Target.getTargetInfo');const wc=webContents.fromDevToolsTargetId(targetInfo.targetId);if(wc)targets.set(wc.id,{page,targetId:targetInfo.targetId});}finally{await session.detach();}
  }
  this.targets=targets;
 }
 async refresh(task){
  const r=this.tasks.get(task),view=r.view,epoch=r.documentEpoch,connectionEpoch=this.connectionEpoch;
  await r.control.settled();await this.readTargets();
  if(view.webContents.isDestroyed())throw Error('view-destroyed');
  const wcId=view.webContents.id,target=this.targets.get(wcId);if(!target)throw Error('registered-target-not-found');
  const current=await this.observe(target.page,task);
  if(view!==r.view||epoch!==r.documentEpoch||connectionEpoch!==this.connectionEpoch||!this.connection.isConnected())throw Error('binding-changed-during-observation');
  const nativeIdentity=this.bindNative(task);
  if(!nativeIdentity)throw Error('task-not-visible-for-native-binding');
  r.binding=Object.freeze({serial:++this.bindSerial,wcId,targetId:target.targetId,page:target.page,documentEpoch:epoch,viewVersion:r.viewVersion,connectionEpoch,nativeIdentity});r.ready=true;
  target.page.once('close',()=>{if(r.binding?.page===target.page)this.invalidate(task,'page-handle-closed');});
  this.log({kind:'current-page-verified',task,binding:{...r.binding,page:undefined},current,reasons:[...r.reasons]});return current;
 }
 async continueTask(task,{explicit=false}={}){
  const r=this.tasks.get(task),pauseRevision=r.pauseRevision;
  if(!explicit&&[...r.reasons].some(reason=>!['document-change','view-replaced','connection-lost','page-handle-closed'].includes(reason)))throw Error('explicit-continue-required');
  const current=await this.refresh(task);
  const binding=r.binding;
  if(r.control.active)r.control.stop();await r.control.settled();
  if(r.pauseRevision!==pauseRevision)throw Error('new-stop-during-verification');
  if(!r.ready||r.binding!==binding||!binding||!this.connection.isConnected())throw Error('binding-changed-before-resume');
  r.control.startNewExecution();r.reasons.clear();
  this.log({kind:'resumed-after-verification',task,explicit,bindingSerial:r.binding.serial,generation:r.control.generation,current});return this.token(task);
 }
 token(task){const r=this.tasks.get(task);return Object.freeze({task,binding:r.binding,execution:r.control.ticket()});}
 guard(token){
  const r=this.tasks.get(token.task);
  if(!r||!r.ready||!token.binding||token.binding!==r.binding||r.view.webContents.isDestroyed()||r.view.webContents.id!==token.binding.wcId||this.connectionEpoch!==token.binding.connectionEpoch||!this.connection.isConnected()){
   this.log({kind:'stale-binding-rejected',task:token.task,bindingSerial:token.binding?.serial});throw Error('stale-page-binding');
  }
  r.control.check(token.execution,'ownership-guard');return r;
 }
 async dispatch(token,operation,action){
  const r=this.guard(token);const value=await r.control.dispatch(token.execution,operation,signal=>action(token.binding.page,signal));this.guard(token);return value;
 }
 replace(task,view){const r=this.tasks.get(task);this.invalidate(task,'view-replaced');this.native.untag(task);r.view=view;r.viewVersion++;this.watch(r,view);}
 state(task){const r=this.tasks.get(task);return {active:r.control.active,ready:r.ready,reasons:[...r.reasons],generation:r.control.generation,wcId:r.view.webContents.isDestroyed()?null:r.view.webContents.id,bindingSerial:r.binding?.serial,documentEpoch:r.documentEpoch,viewVersion:r.viewVersion};}
}
module.exports={TaskOwnership};
