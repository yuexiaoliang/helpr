import fs from 'node:fs';import path from 'node:path';import {fork,spawn} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {Broker} from './broker.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),[out,base]=process.argv.slice(2),require=createRequire(import.meta.url);
const electron=require('../visible-page-control/node_modules/electron');
const log=e=>fs.appendFileSync(path.join(out,'control-events.jsonl'),JSON.stringify({time:Date.now(),...e})+'\n');
// No inherited debugging flags or model settings: the fixture needs only the OS launch environment.
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const argv=[path.join(here,'host.cjs'),out,base,'--remote-debugging-pipe','--site-per-process'];
const host=spawn(electron,argv,{env,stdio:['ignore','pipe','pipe','pipe','pipe','ipc']});
host.stdout.pipe(fs.createWriteStream(path.join(out,'electron.stdout.log')));host.stderr.pipe(fs.createWriteStream(path.join(out,'electron.stderr.log')));
const broker=new Broker(host,log),workers=new Map(),pending=new Map();let jobSeq=0,uiPending;
log({kind:'launch',controllerPid:process.pid,hostPid:host.pid,executable:electron,argv,stdio:['ignore','stdout-log','stderr-log','private-cdp-write','private-cdp-read','private-host-ipc']});
host.on('message',m=>{if(m.registration)broker.register(m.registration);if(m.unregistration)broker.unregister(m.unregistration);if(m.ready)process.send({ready:true,controllerPid:process.pid,hostPid:host.pid,uiTarget:m.uiTarget,versions:m.versions});if(m.uiProbeResult){uiPending?.(m.uiProbeResult);uiPending=null;}});
host.on('exit',(code,signal)=>{log({kind:'host-exit',code,signal});for(const w of workers.values())w.child.kill();});
function startWorker(id,task,ttl,credentialFrom){
  return new Promise((resolve,reject)=>{
    const child=fork(path.join(here,'worker.mjs'),[],{env,stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.pipe(fs.createWriteStream(path.join(out,`${id}.stdout.log`)));child.stderr.pipe(fs.createWriteStream(path.join(out,`${id}.stderr.log`)));
    const c=broker.client(id,task,message=>child.connected&&child.send({protocol:message}),ttl);
    const selected=path.join(out,'selected-material.txt');c.files.add(selected);workers.set(id,{child,c});
    child.on('message',m=>{
      if(m.ready)resolve({pid:child.pid,id});
      if(m.cdp)broker.command(c,m.token,m.cdp);
      if(m.disconnect)broker.close(c,'CLIENT_DISCONNECT');
      if(m.result){const p=pending.get(m.result.id);if(p){pending.delete(m.result.id);clearTimeout(p.timer);m.result.error?p.reject(new Error(m.result.error)):p.resolve(m.result.value);}}
    });
    child.on('error',reject);child.on('exit',(code,signal)=>{c.revoked=true;broker.close(c,'WORKER_EXIT');log({kind:'worker-exit',id,pid:child.pid,code,signal});});
    child.send({credentials:{token:credentialFrom?workers.get(credentialFrom).c.token:c.token}});
    log({kind:'worker-start',id,task,pid:child.pid,ttl});
  });
}
function job(client,body){return new Promise((resolve,reject)=>{const id=++jobSeq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('WORKER_TIMEOUT'));},10000);pending.set(id,{resolve,reject,timer});workers.get(client).child.send({job:{id,...body}});});}
process.on('message',async m=>{
  if(m.seq===undefined)return;
  let value;try{
    if(m.op==='start')value=await startWorker(m.id,m.task,m.ttl,m.credentialFrom);
    else if(m.op==='job')value=await job(m.client,m.body);
    else if(m.op==='revoke'){broker.revoke(m.task);value=true;}
    else if(m.op==='expire'){workers.get(m.client).c.expires=Date.now()-1;value=true;}
    else if(m.op==='killWorker'){workers.get(m.client).child.kill('SIGKILL');value=true;}
    else if(m.op==='inspect')value={targets:[...broker.targets.values()],sessions:[...broker.sessions].map(([id,s])=>({id,client:s.c.id,targetId:s.targetId,parent:s.parent,frames:[...s.frames],contexts:[...s.contexts]})),commands:broker.commands,pids:[process.pid,host.pid,...[...workers.values()].map(w=>w.child.pid)]};
    else if(m.op==='uiProbe')value=await new Promise(resolve=>{uiPending=resolve;host.send({uiProbe:true});});
    else if(m.op==='secretAudit'){
      let checked=0,matches=[];function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory()){if(!['profile','source'].includes(entry.name))scan(f);}else{const bytes=fs.readFileSync(f);checked++;if(broker.secrets.some(s=>bytes.includes(Buffer.from(s))))matches.push(path.relative(out,f));}}}scan(out);value={checked,matches,credentialsIssued:broker.secrets.length};
    }else if(m.op==='close'){for(const w of workers.values())w.child.kill();host.send({close:true});value=true;}
    else throw new Error('UNKNOWN_CONTROL_OPERATION');
    process.send({seq:m.seq,value});
  }catch(e){process.send({seq:m.seq,error:e.message});}
});
process.on('disconnect',()=>{for(const w of workers.values())w.child.kill();host.kill();process.exit(0);});
