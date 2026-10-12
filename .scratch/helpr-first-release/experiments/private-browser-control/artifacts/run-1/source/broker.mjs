// Throwaway protocol Adapter. Only the documented capability subset is admitted.
import { randomBytes } from 'node:crypto';

const pageMethods = new Set(`Page.enable Page.getFrameTree Page.setLifecycleEventsEnabled Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument Page.createIsolatedWorld Page.navigate Page.reload Page.captureScreenshot Page.getLayoutMetrics Page.handleJavaScriptDialog Page.setInterceptFileChooserDialog Page.bringToFront Runtime.enable Runtime.disable Runtime.evaluate Runtime.callFunctionOn Runtime.getProperties Runtime.releaseObject Runtime.releaseObjectGroup Runtime.runIfWaitingForDebugger Runtime.addBinding Runtime.removeBinding DOM.getDocument DOM.describeNode DOM.resolveNode DOM.getContentQuads DOM.getBoxModel DOM.scrollIntoViewIfNeeded DOM.querySelector DOM.querySelectorAll DOM.setFileInputFiles Network.enable Network.getResponseBody Input.dispatchMouseEvent Input.dispatchKeyEvent Input.insertText Input.dispatchTouchEvent Log.enable Inspector.enable`.split(' '));
const fail = reason => { throw new Error(reason); };
const safeNavigation = url => { try { const u=new URL(url);return u.protocol==='https:' || (u.protocol==='http:' && ['127.0.0.1','localhost'].includes(u.hostname)); } catch {return false;} };

export class Broker {
  constructor(host, log) {
    this.host=host;this.log=log;this.next=0;this.pending=new Map();this.clients=new Map();this.targets=new Map();this.sessions=new Map();this.commands=0;this.secrets=[];
    let buffer='';host.stdio[4].setEncoding('utf8');host.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(raw)this.receive(JSON.parse(raw));}});
    host.stdio[3].on('error',()=>{});
    host.on('exit',()=>{for(const p of this.pending.values())p.reject(new Error('PIPE_CLOSED'));this.pending.clear();for(const c of this.clients.values())this.close(c,'HOST_EXIT');});
  }
  send(method, params={}, sessionId) {
    const id=++this.next;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.host.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
  }
  valid(c, token) {return !c.revoked && token===c.token && Date.now()<c.expires && !!c.task;}
  register(info) {
    this.targets.set(info.targetId,info);this.log({kind:'registered',...info});
    for(const c of this.clients.values())if(c.auto && this.valid(c,c.token) && c.task===info.task)this.autoAttach(c,info.targetId).catch(e=>this.log({kind:'attach-error',client:c.id,reason:e.message}));
  }
  unregister(targetId) {this.targets.delete(targetId);for(const [id,s] of this.sessions)if(s.targetId===targetId){this.sessions.delete(id);s.c.deliver({method:'Target.detachedFromTarget',params:{sessionId:id,targetId},...(s.parent?{sessionId:s.parent}:{})});}this.log({kind:'unregistered',targetId});}
  client(id, task, deliver, ttl=180000) {
    const token=randomBytes(32).toString('hex');this.secrets.push(token);
    const c={id,task,deliver,token,expires:Date.now()+ttl,revoked:false,auto:false,autoTargets:new Set(),virtual:new Set(),files:new Set()};this.clients.set(id,c);return c;
  }
  async attach(c,targetId,parent,automatic=false) {
    const target=this.targets.get(targetId);if(!target || target.task!==c.task)fail('TARGET_NOT_OWNED');
    const info=(await this.send('Target.getTargetInfo',{targetId})).targetInfo;
    if(!this.valid(c,c.token))fail('QUALIFICATION_REVOKED');
    const {sessionId}=await this.send('Target.attachToTarget',{targetId,flatten:true});
    if(!this.valid(c,c.token)){await this.send('Target.detachFromTarget',{sessionId});fail('QUALIFICATION_REVOKED');}
    this.sessions.set(sessionId,{c,targetId,parent,frames:new Set(),contexts:new Set(),objects:new Set(),backendNodes:new Set()});
    this.log({kind:'attached',client:c.id,task:c.task,targetId,sessionId,automatic});
    if(automatic)c.deliver({method:'Target.attachedToTarget',params:{sessionId,targetInfo:info,waitingForDebugger:false},...(parent?{sessionId:parent}:{})});
    return {sessionId};
  }
  async autoAttach(c,targetId) {if(c.autoTargets.has(targetId))return;c.autoTargets.add(targetId);try{await this.attach(c,targetId,undefined,true);}catch(e){c.autoTargets.delete(targetId);throw e;}}
  close(c,reason) {
    c.auto=false;c.deliver({transportClosed:reason});
    for(const [id,s] of this.sessions)if(s.c===c){this.sessions.delete(id);this.send('Target.detachFromTarget',{sessionId:id}).catch(()=>{});}
    c.virtual.clear();c.autoTargets.clear();this.log({kind:'channel-closed',client:c.id,task:c.task,reason});
  }
  revoke(task) {for(const c of this.clients.values())if(c.task===task){c.revoked=true;this.close(c,'REVOKED');}this.log({kind:'revoked',task});}
  learn(s,value) {
    if(!value||typeof value!=='object')return;
    if(value.frame?.id)s.frames.add(value.frame.id);
    if(value.frameId)s.frames.add(value.frameId);
    if(value.objectId)s.objects.add(value.objectId);
    if(value.backendNodeId)s.backendNodes.add(value.backendNodeId);
    for(const x of Object.values(value))if(x&&typeof x==='object')this.learn(s,x);
  }
  receive(message) {
    if(message.id!==undefined){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result??{});}return;}
    const s=this.sessions.get(message.sessionId);if(!s || !this.valid(s.c,s.c.token))return;
    if(message.method==='Target.attachedToTarget'){
      const p=message.params;const target=this.targets.get(p.targetInfo.targetId);
      if((target && target.task!==s.c.task) || !['iframe','worker'].includes(p.targetInfo.type)){this.send('Target.detachFromTarget',{sessionId:p.sessionId}).catch(()=>{});this.log({kind:'child-rejected',type:p.targetInfo.type,task:s.c.task});return;}
      this.sessions.set(p.sessionId,{c:s.c,targetId:p.targetInfo.targetId,parent:message.sessionId,frames:new Set(),contexts:new Set(),objects:new Set(),backendNodes:new Set()});
      this.log({kind:'child-attached',task:s.c.task,client:s.c.id,parent:message.sessionId,sessionId:p.sessionId,targetId:p.targetInfo.targetId,type:p.targetInfo.type});
    }
    if(message.method==='Target.detachedFromTarget')this.sessions.delete(message.params.sessionId);
    if(message.method==='Runtime.executionContextsCleared'){s.contexts.clear();s.objects.clear();s.backendNodes.clear();}
    if(message.method==='Runtime.executionContextCreated'){s.contexts.add(message.params.context.id);if(message.params.context.auxData?.frameId)s.frames.add(message.params.context.auxData.frameId);}
    if(message.method==='Runtime.executionContextDestroyed')s.contexts.delete(message.params.executionContextId);
    this.learn(s,message.params);s.c.deliver(message);
  }
  async command(c,token,msg) {
    const {id,method,params={},sessionId}=msg;
    const reply=body=>c.deliver({id,...(sessionId?{sessionId}:{}),...body});
    try {
      if(++this.commands>20000)fail('COMMAND_BUDGET');
      if(!this.valid(c,token))fail(c.revoked?'QUALIFICATION_REVOKED':Date.now()>=c.expires?'QUALIFICATION_EXPIRED':'QUALIFICATION_INVALID');
      if(!Number.isInteger(id)||typeof method!=='string'||!params||typeof params!=='object')fail('MALFORMED');
      this.log({kind:'command',client:c.id,task:c.task,method,sessionId:sessionId??null});
      const s=sessionId?this.sessions.get(sessionId):undefined;
      const root=!sessionId||c.virtual.has(sessionId);
      if(!root && (!s || s.c!==c))fail('SESSION_NOT_OWNED');
      let result;
      // Target commands are intercepted at every depth; a page session is not a bypass.
      if(method==='Target.getTargets')result={targetInfos:(await this.send(method,{})).targetInfos.filter(t=>this.targets.get(t.targetId)?.task===c.task)};
      else if(method==='Target.getTargetInfo'){
        if(params.targetId && this.targets.get(params.targetId)?.task!==c.task)fail('TARGET_NOT_OWNED');
        result=await this.send(method,params,root?undefined:sessionId);
      } else if(method==='Target.attachToBrowserTarget') {const v=`virtual-${c.id}-${++this.next}`;c.virtual.add(v);result={sessionId:v};}
      else if(method==='Target.attachToTarget') result=await this.attach(c,params.targetId,root?undefined:sessionId);
      else if(method==='Target.detachFromTarget') {
        const owned=this.sessions.get(params.sessionId);if(!owned||owned.c!==c)fail('SESSION_NOT_OWNED');
        this.sessions.delete(params.sessionId);result=await this.send(method,{sessionId:params.sessionId});
      } else if(method==='Target.setAutoAttach') {
        if(params.flatten!==true || params.autoAttach!==true)fail('AUTO_ATTACH_MODE');
        if(root){c.auto=true;await Promise.all([...this.targets.values()].filter(t=>t.task===c.task).map(t=>this.autoAttach(c,t.targetId)));result={};}
        else result=await this.send(method,{autoAttach:true,flatten:true,waitForDebuggerOnStart:true,filter:[{type:'iframe'},{type:'worker'},{exclude:true}]},sessionId);
      } else if(root){if(method!=='Browser.getVersion')fail('ROOT_CAPABILITY_DENIED');result=await this.send(method,{});}
      else {
        if(!pageMethods.has(method))fail('PAGE_CAPABILITY_DENIED');
        if(params.targetId||params.sessionId||params.browserContextId)fail('NESTED_ROUTING_DENIED');
        for(const k of ['frameId'])if(params[k]&&!s.frames.has(params[k]))fail('FRAME_NOT_OWNED');
        for(const k of ['contextId','executionContextId'])if(params[k]!==undefined&&!s.contexts.has(params[k]))fail('CONTEXT_NOT_OWNED');
        if(params.objectId&&!s.objects.has(params.objectId))fail('OBJECT_NOT_OWNED');
        for(const a of params.arguments??[])if(a.objectId&&!s.objects.has(a.objectId))fail('OBJECT_NOT_OWNED');
        if(params.backendNodeId&&!s.backendNodes.has(params.backendNodeId))fail('NODE_NOT_OWNED');
        if(method==='Page.navigate'&&!safeNavigation(params.url))fail('NAVIGATION_DENIED');
        if(method==='DOM.setFileInputFiles'&&(!Array.isArray(params.files)||params.files.some(f=>!c.files.has(f))))fail('FILE_NOT_SELECTED');
        // Awaiting discovery above must never reopen a qualification revoked in the meantime.
        if(!this.valid(c,token))fail('QUALIFICATION_REVOKED');
        result=await this.send(method,params,sessionId);this.learn(s,result);
      }
      if(!this.valid(c,token))fail('LATE_RESULT_AFTER_REVOCATION');
      reply({result});
    } catch(e){this.log({kind:'denied',client:c.id,task:c.task,method,reason:e.message});reply({error:{code:-32001,message:e.message}});}
  }
}
