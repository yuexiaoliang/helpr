import {app,utilityProcess} from 'electron';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {fileURLToPath} from 'node:url';
import {Broker} from './broker.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),data=app.getPath('userData');fs.mkdirSync(data,{recursive:true});
const budgetFile=path.join(data,'launch-budget.json'),budget=fs.existsSync(budgetFile)?JSON.parse(fs.readFileSync(budgetFile)):{starts:0};
if(budget.starts>=16)throw Error('LAB_START_BUDGET_EXHAUSTED');
budget.starts++;fs.writeFileSync(budgetFile,JSON.stringify(budget));
const out=path.join(data,'runs',String(budget.starts).padStart(2,'0'));fs.mkdirSync(out,{recursive:true});
const log=e=>fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify({at:Date.now(),...e})+'\n');
const db=new DatabaseSync(path.join(data,'records.sqlite'));db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,intent TEXT,phase TEXT,counter INTEGER,generation INTEGER);');
for(const task of ['A','B'])db.prepare("INSERT OR IGNORE INTO tasks VALUES(?,'running','verify',0,0)").run(task);
db.exec("UPDATE tasks SET generation=generation+1,phase=CASE WHEN phase='dispatched' THEN 'uncertain' ELSE 'verify' END");
let quitting=false,suspended=false,serial=0,host,broker,fixture,ready=false;
const workers=new Map(),pending=new Map(),inflight=new Set();
const rows=()=>db.prepare('SELECT * FROM tasks ORDER BY id').all();
function status(){host?.connected&&host.send({status:{version:app.getVersion(),tasks:rows(),suspended,ready}});}
function pause(task,intent){db.prepare('UPDATE tasks SET intent=?,generation=generation+1 WHERE id=?').run(intent,task);broker?.revoke(task);log({kind:'paused',task,intent});status();}
function job(task,op){return new Promise((resolve,reject)=>{const id=++serial,w=workers.get(task);if(!w)return reject(Error('worker-missing'));const timer=setTimeout(()=>{pending.delete(id);reject(Error('worker-timeout'));},12000);pending.set(id,{resolve,reject,timer});w.child.postMessage({job:{id,op}});});}
async function connect(task){
  workers.get(task)?.child.kill();
  const child=utilityProcess.fork(path.join(here,'worker.mjs'),[],{env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'},stdio:'pipe',serviceName:'helpr Lab '+task});
  const c=broker.client(`${task}-${++serial}`,task,m=>child.postMessage({protocol:m}),5400000);workers.set(task,{child,c});
  child.stdout.on('data',b=>fs.appendFileSync(path.join(out,task+'.stdout.log'),b));child.stderr.on('data',b=>fs.appendFileSync(path.join(out,task+'.stderr.log'),b));
  child.on('message',m=>{if(m.cdp)broker.command(c,m.token,m.cdp);if(m.result){const p=pending.get(m.result.id);if(p){pending.delete(m.result.id);clearTimeout(p.timer);m.result.error?p.reject(Error(m.result.error)):p.resolve(m.result.value);}}});
  child.on('exit',code=>{c.revoked=true;broker.close(c,'WORKER_EXIT');log({kind:'worker-exit',task,code});});
  child.postMessage({credentials:{token:c.token}});
  const observed=await job(task,'observe');const row=rows().find(r=>r.id===task);
  // The fixture's actual counter is evidence. A lower counter never grants replay.
  if(observed.counter<row.counter)throw Error('website-counter-regressed');
  db.prepare("UPDATE tasks SET counter=?,phase=CASE WHEN phase='uncertain' THEN 'uncertain' ELSE 'verified' END WHERE id=?").run(observed.counter,task);log({kind:'reopened-and-verified',task,observed,stillUncertain:row.phase==='uncertain'});return observed;
}
async function tick(task){
  if(quitting||suspended||!ready||inflight.has(task))return;
  const row=rows().find(r=>r.id===task);if(row.intent!=='running'||row.phase!=='verified')return;
  inflight.add(task);
  try{db.prepare("UPDATE tasks SET phase='dispatched' WHERE id=?").run(task);const observed=await job(task,'advance');db.prepare("UPDATE tasks SET counter=?,phase='verified' WHERE id=?").run(observed.counter,task);log({kind:'effect-verified',task,counter:observed.counter});}
  catch(error){db.prepare("UPDATE tasks SET phase='uncertain' WHERE id=?").run(task);log({kind:'effect-uncertain',task,message:error.message});}
  finally{inflight.delete(task);status();}
}
async function close(){
  if(quitting)return;quitting=true;ready=false;clearInterval(timer);log({kind:'quit-dispatch-closed'});
  for(const task of ['A','B'])broker?.revoke(task);
  for(const w of workers.values())w.child.kill();
  db.exec('PRAGMA optimize');log({kind:'quit-records-saved',tasks:rows()});
  if(host?.connected)host.send({close:true});else finish();
}
function finish(){fixture?.kill();db.close();app.exit(0);}
app.dock.hide();app.on('before-quit',e=>{if(!quitting){e.preventDefault();close();}});app.on('second-instance',()=>host?.send({show:true}));
fixture=utilityProcess.fork(path.join(here,'fixture.mjs'),[data],{stdio:'pipe',serviceName:'helpr Lab Website'});
fixture.stdout.on('data',b=>fs.appendFileSync(path.join(out,'fixture.stdout.log'),b));fixture.stderr.on('data',b=>fs.appendFileSync(path.join(out,'fixture.stderr.log'),b));
fixture.on('message',m=>{if(m.ready)launch(m.origin);});
const timer=setInterval(()=>{for(const task of ['A','B'])tick(task);},1000);
setTimeout(()=>{if(!ready&&!quitting){log({kind:'startup-timeout'});close();}},60000).unref();
setTimeout(()=>{log({kind:'automatic-runtime-limit'});close();},90*60*1000).unref();
function launch(origin){
  host=spawn(process.execPath,['--lab-host','--lab-data='+data,'--lab-out='+out,'--lab-origin='+origin,'--remote-debugging-pipe','--site-per-process'],{env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,LANG:process.env.LANG},stdio:['ignore','pipe','pipe','pipe','pipe','ipc']});
  host.stdout.pipe(fs.createWriteStream(path.join(out,'host.stdout.log')));host.stderr.pipe(fs.createWriteStream(path.join(out,'host.stderr.log')));
  broker=new Broker(host,log);log({kind:'launched',controller:process.pid,host:host.pid,version:app.getVersion(),executable:process.execPath,versions:process.versions});
  fs.writeFileSync(path.join(out,'pids.json'),JSON.stringify({controller:process.pid,host:host.pid}));
  host.on('message',async m=>{try{
    if(m.registration)broker.register(m.registration);
    if(m.unregistration)broker.unregister(m.unregistration);
    if(m.ready){log({kind:'host-ready',...m.ready});await Promise.all(['A','B'].map(connect));ready=true;status();}
    if(m.input){log({kind:'native-input',...m.input});if(['A','B'].includes(m.input.owner))pause(m.input.owner,'takeover');else if(m.input.owner==='unknown')for(const task of ['A','B'])pause(task,'unknown-input');}
    if(m.power){log({kind:'power',event:m.power});if(['suspend','lock-screen'].includes(m.power)){suspended=true;for(const task of ['A','B'])broker.revoke(task);}else if(['resume','unlock-screen'].includes(m.power)){await Promise.all(['A','B'].map(connect));suspended=false;}status();}
    if(m.request){const {kind,task}=m.request;
      if(kind==='quit')return close();
      if(kind==='stop'&&['A','B'].includes(task))pause(task,'stopped');
      if(kind==='continue'&&['A','B'].includes(task)){const generation=rows().find(r=>r.id===task).generation;await connect(task);if(rows().find(r=>r.id===task).generation!==generation)throw Error('new-intent-during-check');db.prepare("UPDATE tasks SET intent='running',generation=generation+1 WHERE id=?").run(task);status();}
    }
  }catch(error){log({kind:'operation-failed',message:error.message});host.connected&&host.send({notice:'核对尚未完成：'+error.message});}});
  host.on('exit',(code,signal)=>{log({kind:'host-exit',code,signal});quitting=true;clearInterval(timer);for(const w of workers.values())w.child.kill();finish();});
}
