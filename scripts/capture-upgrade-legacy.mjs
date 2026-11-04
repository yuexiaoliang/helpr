import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { spend, validationRoot } from './workspace-budget.mjs';
import { requireUpgradeNativePreflight, confirmUpgradeUI } from './upgrade-validation-state.mjs';

// 原临时格式6库已不在；从固定旧实包重新取得真实库，不合成旧SQL。
assert(['--run','--new'].includes(process.argv[2]) && process.argv.length===3);
const upgraded=process.argv[2]==='--new';
const sourceBuild=upgraded?41:36;
const ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], {encoding:'utf8',timeout:5000}).trim().split('\n').map(line => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
  assert(m); return {pid:+m[1],parent:+m[2],group:+m[3],birth:m[4],command:m[5]};
});
assert(!ps().some(p => p.pid !== process.pid && (/\/helpr\.app\/Contents\/MacOS\/helpr(?: |$)/.test(p.command) || /helpr Workspace Helper/.test(p.command) || /^(?:\S*\/)?node\s+(?:\S*\/)?(?:validate-\S+|capture-upgrade-legacy)\.mjs(?:\s|$)/.test(p.command))), 'OTHER_VALIDATION_RUNNING');
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'inherit',timeout:65000});
const budget=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json')));
assert(budget.upgrade09Repair?.active && budget.upgrade09Repair?.unlimited && budget.upgrade09Repair?.approved);
requireUpgradeNativePreflight(budget.upgrade09Repair.nativePreflight);
const legacy=upgraded?JSON.parse(fs.readFileSync(path.join(validationRoot,'upgrade09-legacy-refresh/result.json'))):null;
if(upgraded)assert(legacy.passed && legacy.exit.code===0 && legacy.remaining.length===0);
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,`build-${sourceBuild}.json`)));
assert(manifest.prepared && manifest.build===sourceBuild);
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const [file,digest] of Object.entries(manifest.hashes))assert.equal(hash(path.join(manifest.app,file)),digest);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',manifest.app],{stdio:'pipe',timeout:30000});
const root=path.join(validationRoot,upgraded?'upgrade09-final-migration':'upgrade09-legacy-refresh');
fs.mkdirSync(root,{mode:0o700});
const profile=fs.mkdtempSync(`/private/tmp/helpr-workspace-validation-${process.getuid()}/upgrade09-legacy-`);
if(upgraded){fs.copyFileSync(path.join(legacy.root,'source-format6/workspace.sqlite'),path.join(profile,'workspace.sqlite'),fs.constants.COPYFILE_EXCL);fs.writeFileSync(path.join(profile,'.workspace-records'),'copied actual old36 database\n',{mode:0o600});}
const installation=path.join(root,'helpr.app');
const report={sourceBuild,sourceApp:manifest.app,root,profile,installation,started:Date.now(),deadline:Date.now()+20*60000,passed:false};
const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
report.install=spend('installs','upgrade09Repair').used.installs;save();
execFileSync('/usr/bin/ditto',[manifest.app,installation],{timeout:120000});
for(const [file,digest] of Object.entries(manifest.hashes))assert.equal(hash(path.join(installation,file)),digest);
report.start=spend('starts','upgrade09Repair').used.starts;
const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const stderr=fs.openSync(path.join(root,'stderr.log'),'wx',0o600);
const child=spawn(path.join(installation,'Contents/MacOS/helpr'),['--workspace-validation'],{env:{...env,HELPR_VALIDATION_DATA:profile},stdio:['ignore','ignore',stderr,'ipc']});fs.closeSync(stderr);
report.pid=child.pid;report.at=Date.now();save();
const identities=new Map(),groups=new Map(),pending=new Map();let sequence=0;
function owned(){
  const rows=ps(),by=new Map(rows.map(r=>[r.pid,r]));
  const same=r=>r && identities.get(r.pid)?.birth===r.birth && identities.get(r.pid)?.command===r.command;
  const inside=r=>r.command.startsWith(installation+'/Contents/');
  const remember=r=>identities.set(r.pid,{birth:r.birth,command:r.command});
  if(!identities.size){const r=by.get(child.pid);if(r?.parent===process.pid && inside(r))remember(r);}
  let added=true;while(added){added=false;for(const r of rows)if(!same(r)&&inside(r)&&same(by.get(r.parent))){remember(r);added=true;}}
  for(const r of rows)if(same(r)&&same(by.get(r.group)))groups.set(r.group,identities.get(r.group));
  const valid=g=>groups.has(g)&&(!by.has(g)||same(by.get(g)));
  for(const r of rows)if(!same(r)&&inside(r)&&valid(r.group))remember(r);
  const live=rows.filter(r=>same(r)||valid(r.group));
  Object.assign(report,{pids:[...identities.keys()],identities:Object.fromEntries(identities),groups:[...groups.keys()],tree:live});return live;
}
child.on('message',m=>{if(m.ready)report.ready=m;if(m.startupFailure)report.startupFailure=m.startupFailure;const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}save();});
child.on('exit',(code,signal)=>{report.exit={code,signal};for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('APPLICATION_EXITED'));}pending.clear();save();});
child.on('error',e=>{report.spawnError=e.code??'SPAWN_FAILED';save();});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('LEGACY_WAIT_TIMEOUT');}
function rpc(command,ms=15000){assert(child.connected,'APPLICATION_DISCONNECTED');return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC_TIMEOUT'));},ms);pending.set(id,{resolve,reject,timer});child.send({id,command});});}
async function quit(){if(!report.exit)await rpc({kind:'quit'},45000).catch(e=>{if(!['APPLICATION_EXITED','APPLICATION_DISCONNECTED','APPLICATION_EXITING'].includes(e.message))throw e;});await until(()=>report.exit,45000);await until(()=>owned().length===0,10000);assert.equal(report.exit.code,0);report.remaining=owned();save();}
try{
  assert(owned().some(p=>p.pid===child.pid),'OWN_PROCESS_REQUIRED');
  await until(async()=>{try{await rpc({kind:'show'});return true;}catch(e){if(e.message!=='RECORDS_UNAVAILABLE')throw e;return false;}},30000);
  await until(()=>report.ready||report.exit,30000);assert(report.ready&&!report.exit);
  await rpc({kind:'show'});
  fs.writeFileSync(path.join(root,'context.json'),JSON.stringify({root,profile,start:report.start,hostPid:report.ready.hostPid,hostApp:path.join(installation,'Contents/Frameworks/helpr Workspace.app')}),{mode:0o600});
  console.log(JSON.stringify({ready:true,start:report.start,hostApp:path.join(installation,'Contents/Frameworks/helpr Workspace.app')}));
  let finished=false;
  while(!finished){
    assert(Date.now()<report.deadline,'APP_PHASE_TIMEOUT');owned();
    const file=path.join(root,'command.json');
    if(fs.existsSync(file)){
      const c=JSON.parse(fs.readFileSync(file));fs.unlinkSync(file);let value;
      try{
        if(c.op==='ui-ready'){report.nativeUI=confirmUpgradeUI(report,c.observation);value={confirmed:true};}
        else if(c.op==='seed'){
          assert(!upgraded&&report.nativeUI&&!report.seeded);
          for(const name of ['A','B']){const r=await rpc({kind:'create',requestId:randomUUID(),goal:`真实旧版迁移验证任务${name}`});await rpc({kind:'draft',requestId:randomUUID(),taskId:r.taskId,text:`旧版保留的中文草稿${name}`});await rpc({kind:'execution-intent',requestId:randomUUID(),taskId:r.taskId,intent:'stop'});}
          report.seeded=true;value=await rpc({kind:'snapshot'});fs.writeFileSync(path.join(root,'old-snapshot.json'),JSON.stringify(value,null,2));
        }
        else if(c.op==='finish'){
          assert((upgraded||report.seeded)&&report.nativeUI);report.baseline=await rpc({kind:'snapshot'});
          if(upgraded){
            const facts=s=>s.tasks.map(t=>[t.id,t.goal,t.draft,t.messages.map(m=>({role:m.role,text:m.text})),t.execution?.intent??null,t.execution?.phase??null]);
            assert.deepEqual(facts(report.baseline),facts(legacy.baseline));
            report.actualCapability=await rpc({kind:'inspect'});
            report.originalTaskFactsMatched=true;
          }
          await quit();
          report.databaseSha256=hash(path.join(profile,'workspace.sqlite'));
          if(!upgraded){fs.mkdirSync(path.join(root,'source-format6'),{mode:0o700});fs.copyFileSync(path.join(profile,'workspace.sqlite'),path.join(root,'source-format6/workspace.sqlite'),fs.constants.COPYFILE_EXCL);}
          fs.writeFileSync(path.join(root,'old-baseline.json'),JSON.stringify({tasks:report.baseline.tasks.map(t=>[t.id,t.goal,t.draft,t.messages.map(m=>({role:m.role,text:m.text})),t.execution?.intent??null,t.execution?.phase??null])}),{mode:0o600});
          report.passed=true;finished=true;value={finished:true};
        }else throw Error('UNKNOWN_LEGACY_COMMAND');
        save();fs.writeFileSync(path.join(root,'command-result.json'),JSON.stringify({nonce:c.nonce,ok:true,value}),{mode:0o600});
      }catch(e){fs.writeFileSync(path.join(root,'command-result.json'),JSON.stringify({nonce:c.nonce,ok:false,error:e.message}),{mode:0o600});throw e;}
    }await delay(100);
  }
}catch(e){report.error=e.message;process.exitCode=1;}
finally{
  try{await quit();}catch(e){report.passed=false;process.exitCode=1;report.cleanupError=e.message;report.cleanup=spend('cleanups','upgrade09Repair').used.cleanups;for(const signal of ['SIGTERM','SIGKILL']){const live=owned();if(!live.length)break;report.signals??=[];report.signals.push({signal,members:live});for(const g of new Set(live.map(r=>r.group)))if(groups.has(g))try{process.kill(-g,signal);}catch{}for(const p of owned())try{process.kill(p.pid,signal);}catch{}await delay(1000);}report.remaining=owned();}
  report.ended=Date.now();save();console.log(JSON.stringify({passed:report.passed,error:report.error,root,remaining:report.remaining}));
}
