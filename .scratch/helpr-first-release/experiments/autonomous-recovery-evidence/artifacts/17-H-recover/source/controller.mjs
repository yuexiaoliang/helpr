import fs from 'node:fs';import path from 'node:path';import {fork,spawn} from 'node:child_process';import {createRequire} from 'node:module';
import {here,load,save,log,ensure} from './common.mjs';import {Broker} from './broker.mjs';import {Store} from './store.mjs';
const [out,taskId,proxy]=process.argv.slice(2),store=new Store(out),require=createRequire(import.meta.url);
if(taskId==='init'){for(const task of load(path.join(here,'tasks.json')))store.init(task);store.close();process.exit(0);}
const record=store.read(taskId),q=store.qualify(taskId),env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const argv=[path.join(here,'host.cjs'),out,record.task.origin,proxy,path.resolve(here,'private/auth.json'),taskId,'--remote-debugging-pipe','--site-per-process'];
const host=spawn(require('../visible-page-control/node_modules/electron'),argv,{env,stdio:['ignore','pipe','pipe','pipe','pipe','ipc']});
host.stdout.pipe(fs.createWriteStream(path.join(out,'host.stdout.log')));host.stderr.pipe(fs.createWriteStream(path.join(out,'host.stderr.log')));
const broker=new Broker(host,e=>log(out,e),[record.task.origin]);let child,c;
const notify=m=>process.connected&&process.send(m,()=>{});
log(out,{kind:'launch',controllerPid:process.pid,hostPid:host.pid,argv});
host.on('message',async m=>{
  if(m.registration)broker.register(m.registration);if(m.unregistration)broker.unregister(m.unregistration);
  if(m.ready){
    child=fork(path.join(here,'worker.mjs'),[],{env,stdio:['ignore','pipe','pipe','ipc']});child.stdout.pipe(fs.createWriteStream(path.join(out,'worker.stdout.log')));child.stderr.pipe(fs.createWriteStream(path.join(out,'worker.stderr.log')));
    c=broker.client('worker',taskId,message=>child.connected&&child.send({protocol:message}),15*60000);
    for(const v of Object.values(record.task.inputs))if(v.type==='file')c.files.add(v.path);
    child.on('message',msg=>{
      if(msg.cdp)broker.command(c,msg.token,msg.cdp);
      else if(msg.rpc){try{const value=store.request(msg.q,msg.rpc.op,msg.rpc.data);child.send({reply:msg.rpc.id,value});}catch(e){child.send({reply:msg.rpc.id,error:e.message});}}
      else notify(msg);
    });
    child.on('exit',(code,signal)=>{broker.revoke(taskId);notify({workerExit:{code,signal}});});
    child.send({credentials:{token:c.token,q,out,proxy,taskId}});notify({ready:true,controllerPid:process.pid,hostPid:host.pid,workerPid:child.pid,epoch:store.epoch});
  }
});
process.on('message',m=>{
  if(m.job)child.send(m);
  if(m.inspect){save(path.join(out,'final-record.json'),store.read(taskId));notify({record:store.read(taskId)});}
  if(m.close){child?.kill();host.send({close:true});}
});
host.on('exit',(code,signal)=>{log(out,{kind:'host-exit',code,signal});child?.kill();store.close();process.exit(code||0);});
process.on('disconnect',()=>{child?.kill();host.kill();process.exit(0);});
