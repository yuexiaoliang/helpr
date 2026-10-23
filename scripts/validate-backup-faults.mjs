// 07 已确认收尾：CUA 操作实际 UI；此入口只管理原资料、受限故障及独立证据。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spend,validationRoot} from './workspace-budget.mjs';
import {verifyDevelopmentSignature} from './development-signing.mjs';
import {capacityVolume,guardCapacity} from './backup-validation-storage.mjs';

const commandNames=['check-space','release-space','arm-receipt','check-receipt','arm-readonly','check-readonly','release-readonly','arm-restore-interrupt','check-restore','cold','finish','abort'];
const contractFile=path.join(validationRoot,'backup-fault-contracts.mjs');
createRequire(import.meta.resolve('vite'))('esbuild').buildSync({stdin:{contents:"export {uiCommandSchema,snapshotSchema} from './app/shared/contracts';export {backupStatusSchema} from './app/shared/backup';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:contractFile});
const {uiCommandSchema,snapshotSchema,backupStatusSchema}=await import(pathToFileURL(contractFile).href);
function parseControl(value){assert(value&&Object.keys(value).sort().join(',')==='nonce,op'&&typeof value.nonce==='string'&&value.nonce.length<80&&commandNames.includes(value.op),'INVALID_CONTROL');return value;}
for(const op of commandNames)parseControl({op,nonce:'offline'});
for(const command of [{kind:'snapshot'},{kind:'backup-status'},{kind:'quit'}])uiCommandSchema.parse(command);
const fakeRoot='/private/tmp/backup-check';const fakeMount=`/private/tmp/helpr-workspace-validation-${process.getuid()}/backup07-volume-test`;
const safe={root:fakeRoot,image:fakeRoot+'/capacity.dmg',mount:fakeMount,actualImage:fakeRoot+'/capacity.dmg',actualMount:fakeMount,volumeBytes:16*1024*1024,volumeDevice:2,hostDevice:1};
guardCapacity(safe);assert.throws(()=>guardCapacity({...safe,volumeDevice:1}));assert.throws(()=>guardCapacity({...safe,volumeBytes:64*1024*1024}));assert.throws(()=>guardCapacity({...safe,actualImage:'/other/image.dmg'}));assert.throws(()=>parseControl({op:'rpc',nonce:'bad',command:{kind:'create'}}));
if(process.argv.length===3&&process.argv[2]==='--check'){console.log(JSON.stringify({valid:true,appStarts:0,faults:0,models:0,effects:0,hostVolumeRejected:true,oversizedVolumeRejected:true}));process.exit(0);}
const args=process.argv.slice(2);const preflight=args.at(-1)==='--preflight';if(preflight)args.pop();const preparationRetry=args.at(-1)==='--preparation-retry';if(preparationRetry)args.pop();const build=Number(args[0]?.match(/^--build=(35|36)$/)?.[1]);assert(args.length===1&&build,'FIXED_BUILD_REQUIRED');
const sourceRoot=path.join(validationRoot,'backup-07-35'),sourceCold=sourceRoot+'-cold';
const source=JSON.parse(fs.readFileSync(path.join(sourceCold,'result.json')));
assert(source.passed&&source.build===35&&source.starts.length===2&&source.models.length===6&&source.effects.length===2&&source.counts.A===1&&source.counts.B===1,'VERIFIED_SOURCE_REQUIRED');
const profile=JSON.parse(fs.readFileSync(path.join(sourceRoot,'private-context.json'))).profile;
const profileRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
assert(profile===profileRoot+'/backup07-CPFJP0'&&fs.realpathSync(profile)===profile,'FIXED_PROFILE_REQUIRED');
const origin=JSON.parse(fs.readFileSync(path.join(sourceRoot,'context.json'))).origin;
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)&&new URL(origin).origin===origin,'FIXED_LOCAL_ORIGIN_REQUIRED');
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,`build-${build}.json`)));
assert(manifest.prepared&&path.isAbsolute(manifest.app),'PREPARED_BUILD_REQUIRED');
for(const [file,hash]of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(manifest.app,file))).digest('hex'),hash);
const signature=verifyDevelopmentSignature(manifest.app);
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{timeout:65000,stdio:'pipe'});
const processRows=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return {pid:+m[1],parent:+m[2],group:+m[3],command:m[4]};});
const existing=processRows();assert(!existing.some(row=>row.pid!==process.pid&&(/\/helpr\.app\/Contents\/MacOS\/helpr(?: |$)/.test(row.command)||/^(?:\S*\/)?node scripts\/validate-(?:backup|workspace|recovery|takeover).*\.mjs/.test(row.command))),'OTHER_VALIDATION_RUNNING');
for(const start of source.starts)assert(!existing.some(row=>start.pids.includes(row.pid)||start.groups.includes(row.group)),'SOURCE_PROCESSES_REMAIN');
const budgetFile=path.join(validationRoot,'budget.json');
const readBudget=()=>JSON.parse(fs.readFileSync(budgetFile));const initialBudget=readBudget(),campaign=initialBudget.backup07Closeout;
assert(campaign?.basis.includes('增加')&&campaign.baseline.starts===90&&campaign.baseline.faults===37,'APPROVED_CLOSEOUT_REQUIRED');
assert(initialBudget.used.starts+2<=initialBudget.limits.starts&&initialBudget.used.faults+5<=initialBudget.limits.faults&&initialBudget.used.cleanups+1<=initialBudget.limits.cleanups,'PRIMARY_BUDGET_REQUIRED');
assert(campaign.activeMilliseconds<campaign.limits.activeMilliseconds,'CAMPAIGN_TIME_EXHAUSTED');
if(preparationRetry){const prior=JSON.parse(fs.readFileSync(path.join(validationRoot,'backup-07-closeout-1/result.json')));assert(prior.error==='HELPER_FAILED:hdiutil'&&prior.starts.length===0&&prior.faults.length===0&&prior.storage.reclaimed&&prior.remainingHelperProcesses.length===0&&prior.helpers[0].stderr.includes('-format requires'),'DIAGNOSED_PREPARATION_FAILURE_REQUIRED');}
const root=path.join(validationRoot,preparationRetry?'backup-07-closeout-2':'backup-07-closeout-1');assert(!fs.existsSync(root),'ROUND_ALREADY_EXISTS');
if(preflight){console.log(JSON.stringify({preflight:true,build,profile:'original',primaryStarts:2,primaryFaults:5,maximumImageMiB:32,newTasks:0,models:0,effects:0,appStarts:0}));process.exit(0);}
fs.mkdirSync(root,{mode:0o700});
{const b=readBudget();b.backup07Closeout.runs.push({root,started:Date.now(),candidate:build,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n',{mode:0o600});}
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const report={build,archive:manifest.hashes['Contents/Resources/app.asar'],certificate:signature.certificateSha256,sourceSHA256:createHash('sha256').update(fs.readFileSync(path.join(sourceCold,'result.json'))).digest('hex'),started:Date.now(),limits:{starts:2,faults:5,models:0,effects:0,tasks:0,roundMilliseconds:1200000},starts:[],faults:[],commands:[],helpers:[],checks:[],models:[],effects:[],pageInputs:[],counts:source.counts,stages:[],phase:'storage-preparation'};
let lastAccount=Date.now(),failure,current,reader,volume,watcher,readonly=false,finished=false,baseline,receiptFile,receiptRequest,receiptDigest,immediateStop,restoreBefore,interrupted=false,gate,receiptEpoch;
let deadline=Math.min(Date.now()+1200000,Date.now()+campaign.limits.activeMilliseconds-campaign.activeMilliseconds);
report.rounds=[{kind:'faults',started:report.started,deadline}];
const helpers=new Map();
function account(){const now=Date.now(),b=readBudget();b.backup07Closeout.activeMilliseconds+=now-lastAccount;lastAccount=now;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n',{mode:0o600});}
function save(){write('result.json',report);account();}
const check=(name,condition)=>{assert(condition,name);if(!report.checks.includes(name))report.checks.push(name);save();};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function limited(){assert(Date.now()<deadline,'ROUND_TIME_LIMIT');assert(readBudget().backup07Closeout.activeMilliseconds<campaign.limits.activeMilliseconds,'CAMPAIGN_TIME_LIMIT');if(failure)throw Error(failure);}
function fault(kind,detail={}){limited();assert(report.faults.length<report.limits.faults,'PRIMARY_FAULT_LIMIT');const b=spend('faults');report.faults.push({kind,at:Date.now(),global:b.used.faults,...detail});save();}
function emergency(){const b=readBudget();assert(b.used.cleanups-campaign.baseline.cleanups<campaign.limits.cleanups,'CAMPAIGN_CLEANUP_LIMIT');spend('cleanups');}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{failure??='VALIDATOR_'+signal;save();});
async function until(fn,ms=15000,cleanup=false){const end=cleanup?Date.now()+ms:Math.min(deadline,Date.now()+ms);while(Date.now()<end){if(!cleanup)limited();if(await fn())return;await delay(50);}throw Error('BACKUP_FAULT_WAIT_EXPIRED');}
function captureTree(app){const rows=processRows();let added=true;while(added){added=false;for(const row of rows)if(app.pids.has(row.parent)&&!app.pids.has(row.pid)){app.pids.add(row.pid);added=true;}}for(const row of rows)if(app.pids.has(row.pid)&&app.pids.has(row.group))app.groups.add(row.group);app.row.pids=[...app.pids];app.row.groups=[...app.groups];app.row.tree=rows.filter(row=>app.pids.has(row.pid));return rows.filter(row=>app.pids.has(row.pid)||app.groups.has(row.group));}
async function run(executable,args,{input}={}){
 const child=spawn(executable,args,{detached:true,stdio:['pipe','pipe','pipe']});const row={executable,args,pid:child.pid,group:child.pid,at:Date.now()};report.helpers.push(row);helpers.set(child.pid,child);save();let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);child.stdin.end(input);
 const members=()=>processRows().filter(p=>p.pid===child.pid||p.group===child.pid);
 const terminate=signal=>{if(!row.cleanupUsed){emergency();row.cleanupUsed=true;}try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
 try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{row.timeout=true;try{terminate('SIGTERM');}catch(error){row.cleanupError=error.message;}reject(Error('HELPER_TIMEOUT'));},20000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);row.exit={code,signal};row.stderr=errors.slice(-3000);save();code===0?resolve(output):reject(Error('HELPER_FAILED:'+path.basename(executable)));});});}
 finally{
  row.remaining=members();
  if(row.remaining.length){terminate('SIGTERM');try{await until(()=>members().length===0,1000,true);}catch{terminate('SIGKILL');await until(()=>members().length===0,1000,true);}}
  row.remaining=members();assert(row.remaining.length===0,'HELPER_GROUP_REMAINS');helpers.delete(child.pid);save();
 }
}
const archive=file=>{const raw=fs.readFileSync(file),value=JSON.parse(raw),payload=Buffer.from(JSON.stringify(value.payload));assert(value.format==='helpr-backup'&&value.version===1&&value.dataVersion===6&&value.stateModel===1,'BACKUP_FORMAT');assert(value.files[0].bytes===payload.length&&value.files[0].sha256===createHash('sha256').update(payload).digest('hex'),'BACKUP_INTEGRITY');assert(!/ciphertext|local-fixture-not-a-secret|modelSettings|cookie|sessionToken/.test(raw.toString()),'BACKUP_PRIVATE_CONFIGURATION');return {value,sha256:createHash('sha256').update(raw).digest('hex')};};
const backupDirectory=path.join(profile,'backups'),oldArchive=source.oldBackup;
const oldDigest=archive(oldArchive).sha256;
const keptFiles=()=>Object.fromEntries(fs.readdirSync(backupDirectory).filter(name=>name.endsWith('.helpr-backup')).map(name=>[name,archive(path.join(backupDirectory,name)).sha256]));
const originalSafety=keptFiles();
const taskA=source.tasks.find(t=>t.name==='A').id,taskB=source.tasks.find(t=>t.name==='B').id;
const site=http.createServer((req,res)=>{try{limited();const match=req.url.match(/^\/page\/([AB])$/);if(req.method==='GET'&&match){const name=match[1];res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>07 ${name} 备注</title><style>body{font:20px -apple-system;padding:32px;color:#244135;background:#f4f8f5}button{font:inherit;padding:12px}</style><h1>07 ${name} 备注</h1><p>${name} 写入 1 次</p><button onclick="fetch('/effect/${name}',{method:'POST'})">写入备注 ${name}</button><p>本机虚构记录，仅核对备份与已有结果。</p></html>`);return;}if(req.method==='POST'){const kind=req.url.startsWith('/v1/')?'models':req.url.startsWith('/effect/')?'effects':'pageInputs';report[kind].push({url:req.url,at:Date.now()});save();throw Error('NEW_REQUEST_FORBIDDEN:'+kind);}res.writeHead(404);res.end();}catch(error){failure??=error.message;save();if(!res.headersSent)res.writeHead(400);res.end('FIXTURE_REJECTED');}});
function rpc(command){if(command.kind!=='quit')limited();if(!['show','inspect'].includes(command.kind))uiCommandSchema.parse(command);const app=current;assert(app.child.connected,'NO_CHANNEL');return new Promise((resolve,reject)=>{const id=++app.sequence,timer=setTimeout(()=>{app.pending.delete(id);reject(Error('RPC_TIMEOUT'));},command.kind==='quit'?45000:15000);app.pending.set(id,{resolve,reject,timer});app.child.send({id,command});});}
async function snapshot(){const value=snapshotSchema.parse(await rpc({kind:'snapshot'}));write('snapshot.json',value);return value;}
const status=async()=>backupStatusSchema.parse(await rpc({kind:'backup-status'}));
const facts=state=>state.tasks.map(t=>({id:t.id,goal:t.goal,url:t.url,draft:t.draft,messages:t.messages,execution:t.execution?{intent:t.execution.intent,intentId:t.execution.intentId,goal:t.execution.goal,goalVersion:t.execution.goalVersion,restoreReview:t.execution.restoreReview,actions:t.execution.actions,result:t.execution.result}:null}));
async function launch(){limited();const priorGates=new Set(fs.readdirSync(profile).filter(name=>/^\.input-gate-[0-9a-f-]+$/.test(name)));assert(report.starts.length<2,'START_LIMIT');if(current)assert(current.cleared,'PREVIOUS_NOT_CLEARED');const used=spend('starts');assert(used.used.starts-campaign.baseline.starts<=campaign.limits.starts,'CAMPAIGN_START_LIMIT');const row={start:used.used.starts,at:Date.now(),round:report.rounds.at(-1).kind,deadline};report.starts.push(row);save();
 const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 const child=spawn(path.join(manifest.app,'Contents/MacOS/helpr'),['--workspace-validation','--workspace-fixture'],{env:{...env,HELPR_VALIDATION_DATA:profile,HELPR_FIXTURE_ORIGIN:origin},stdio:['ignore','ignore',fs.openSync(path.join(root,`stderr-${row.start}.log`),'a',0o600),'ipc']});row.pid=child.pid;
 const app={child,row,pids:new Set([child.pid]),groups:new Set(),sequence:0,pending:new Map(),ready:null,exit:null,cleared:false};current=app;
 child.on('message',message=>{if(message.ready){app.ready=message;app.recordsPid=message.recordsPid;app.pids.add(message.hostPid);app.pids.add(message.recordsPid);}if(message.recordsRestored){app.recordsPid=message.recordsPid;app.pids.add(message.recordsPid);report.recordRestored={...message,at:Date.now()};}const entry=app.pending.get(message.id);if(entry){clearTimeout(entry.timer);app.pending.delete(message.id);message.error?entry.reject(Error(message.error)):entry.resolve(message.value);}});
 child.once('exit',(code,signal)=>{app.exit={code,signal};row.exit=app.exit;for(const p of app.pending.values()){clearTimeout(p.timer);p.reject(Error('APPLICATION_EXITED'));}app.pending.clear();save();});
 await until(()=>{captureTree(app);return app.ready||app.exit;},30000);assert(app.ready&&!app.exit,'APPLICATION_NOT_READY');await rpc({kind:'show'});await until(async()=>(await snapshot()).tasks.every(t=>t.phase==='manual'));
 if(report.starts.length===1){const files=fs.readdirSync(profile).filter(name=>/^\.input-gate-[0-9a-f-]+$/.test(name)&&!priorGates.has(name));assert.equal(files.length,1,'ONE_NATIVE_GATE_REQUIRED');gate=createRequire(import.meta.url)(path.join(manifest.app,'Contents/Resources/input-bridge.node'));gate.open(path.join(profile,files[0]),false);report.nativeGateFile=files[0];}
 write('ready.json',app.ready);save();console.log('BACKUP_FAULT_READY '+JSON.stringify({root,start:row.start,volume:volume.mount,exports:path.join(root,'exports'),oldArchive,hostApp:path.join(manifest.app,'Contents/Frameworks/helpr Workspace.app')}));
}
async function gone(app){await until(()=>app.exit,45000,true);await until(()=>captureTree(app).length===0,8000,true);app.row.remaining=captureTree(app);assert.equal(app.exit.code,0,'NORMAL_EXIT_REQUIRED');app.cleared=true;save();}
async function quit(){if(!current.exit)await rpc({kind:'quit'}).catch(error=>{if(!['APPLICATION_EXITING','APPLICATION_EXITED'].includes(error.message))throw error;});await gone(current);}
async function armReader(){fault('receipt-commit-shared-reader');const child=spawn('python3',['scripts/backup-storage-reader.py',path.join(profile,'workspace.sqlite')],{detached:true,stdio:['pipe','pipe','pipe']});const value={child,pid:child.pid,events:[],released:false,expired:false,exit:null};reader=value;report.reader={pid:child.pid,at:Date.now(),events:value.events};let output='';child.stdout.on('data',chunk=>{output+=chunk;const lines=output.split('\n');output=lines.pop();for(const line of lines){try{const event=JSON.parse(line);value.events.push(event);if(event.stage==='expired'){value.expired=true;failure??='READER_EXPIRED';}}catch{failure??='BAD_READER_RECEIPT';}}save();});child.stderr.on('data',chunk=>{report.reader.stderr=(report.reader.stderr??'')+chunk;});child.once('exit',(code,signal)=>{value.exit={code,signal};report.reader.exit=value.exit;if(!value.released)failure??='READER_EXPIRED';save();});await until(()=>value.events.some(row=>row.stage==='reader-held'),3000);return value;}
async function releaseReader(){if(!reader)return;reader.released=true;if(!reader.exit)reader.child.stdin.end('release\n');await until(()=>reader.exit,2000,true);assert.equal(reader.exit.code,0,'READER_NORMAL_EXIT');assert(!reader.expired,'READER_EXPIRED');assert(!alive(reader.pid),'READER_REMAINING');reader=null;save();}
function sameCurrent(state){const a=state.tasks.find(t=>t.id===taskA),b=state.tasks.find(t=>t.id===taskB);check('new-goal-retained',a.goal.includes('保留新目标'));check('new-stop-retained',b.execution.intent==='stopped');check('old-archive-and-original-safety-unchanged',archive(oldArchive).sha256===oldDigest&&Object.entries(originalSafety).every(([name,sha])=>archive(path.join(backupDirectory,name)).sha256===sha));}
function recordSignal(signal,label){const pid=current.recordsPid;const row=processRows().find(row=>row.pid===pid);assert(row&&row.parent===current.child.pid&&current.pids.has(pid)&&row.command.includes(manifest.app),'OWN_RECORD_PROCESS_REQUIRED');fault(label,{pid,parent:row.parent,group:row.group,signal});process.kill(pid,signal);}
function failureReceipt(code,since){const folder=path.join(profile,'diagnostics');const rows=fs.readdirSync(folder).filter(name=>name.startsWith('records.')&&name.endsWith('.log')).flatMap(name=>fs.readFileSync(path.join(folder,name),'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}));return rows.findLast(row=>row.pid===current.recordsPid&&row.code===code&&Date.parse(row.time)>=since);}
const stages=['space','receipt','readonly','restore','cold'];
function stage(value){assert.equal(value,stages[report.stages.length],'STAGE_ORDER');report.stages.push(value);save();}
let timer;
try{
 await new Promise((resolve,reject)=>{site.once('error',reject);site.listen(Number(new URL(origin).port),'127.0.0.1',resolve);});
 fs.mkdirSync(path.join(root,'exports'),{mode:0o700});
 write('context.json',{root,profile,origin,oldArchive,exports:path.join(root,'exports')});
 volume=await capacityVolume({root,profileRoot,run,fault,emergency,save:state=>{report.storage={...state};save();}});
 await launch();baseline=await snapshot();report.phase='space';save();
 timer=setTimeout(()=>{failure??='ROUND_TIME_LIMIT';},Math.max(1,deadline-Date.now()));
 while(!finished){limited();if(current.exit&&current.exit.code!==0)throw Error('APPLICATION_FAILED');captureTree(current);
  let state,view;
  if(!current.exit){try{state=await snapshot();view=await status();write('backup-status.json',view);}catch(error){if(!['APPLICATION_EXITING','APPLICATION_EXITED'].includes(error.message))throw error;await gone(current);}}
  if(reader&&!reader.released&&state){
   const b=state.tasks.find(t=>t.id===taskB);
   if(b?.executionControl?.blocked&&!b.executionControl.stopSaved&&b.executionControl.message.includes('停止')){immediateStop??={at:Date.now(),execution:b.execution,control:b.executionControl,backupPhase:view.phase,writerWaiting:reader.events.some(row=>row.stage==='writer-waiting'),native:gate.state(taskB)};if(!report.nativeStopDenial){let sent=0;assert.throws(()=>gate.permit(taskB,receiptEpoch,()=>{sent++;}),/INPUT_QUALIFICATION_REVOKED/);check('native-old-ticket-denied-before-stop-save',sent===0&&immediateStop.native.blocked&&immediateStop.native.epoch>receiptEpoch);report.nativeStopDenial={oldEpoch:receiptEpoch,current:immediateStop.native,sent};}report.immediateStop=immediateStop;save();}
   if(view.phase==='uncertain'&&immediateStop&&receiptFile){receiptRequest=view.requestId;receiptDigest=archive(receiptFile).sha256;report.lostReceipt={requestId:receiptRequest,file:receiptFile,sha256:receiptDigest,status:view};check('archive-published-before-receipt-and-stop-immediate',reader.events.some(row=>row.stage==='writer-waiting')&&immediateStop.writerWaiting&&immediateStop.execution.intent!=='stopped');await releaseReader();await until(async()=>{const b=(await snapshot()).tasks.find(t=>t.id===taskB);return b.execution.intent==='stopped'&&b.executionControl?.stopSaved;},3000);report.receiptReadyForRetry=true;save();}
  }
  if(interrupted&&!report.interrupt.killed&&state){
   assert(['working','uncertain'].includes(view.phase)&&view.operation==='restore'&&view.requestId&&view.selection?.archive.file===oldArchive,'RESTORE_ORIGINAL_PENDING_REQUIRED');
   Object.assign(report.interrupt,{requestId:view.requestId,selectionToken:view.selection.token,pendingStatus:view});
   recordSignal('SIGKILL','restore-copy-writing-record-killed');report.interrupt.killed=true;watcher.close();watcher=null;
   await until(()=>Boolean(report.recordRestored)&&report.recordRestored.recordsPid!==report.interrupt.recordsPid,15000);
   await until(async()=>{const pending=await status();return pending.phase==='uncertain'&&pending.requestId===report.interrupt.requestId;});
   const reopened=await snapshot();sameCurrent(reopened);const previousVersion=restoreBefore.tasks.find(t=>t.id===taskA).execution.version;
   check('restore-cut-before-switch-commit',reopened.tasks.find(t=>t.id===taskA).execution.version===previousVersion+1);
   write('interrupted.json',{state:reopened,status:await status(),before:restoreBefore,interrupt:report.interrupt});report.restoreReadyForRetry=true;save();
  }
  const control=path.join(root,'command.json');if(fs.existsSync(control)){const value=parseControl(JSON.parse(fs.readFileSync(control)));fs.unlinkSync(control);let result;
   try{switch(value.op){
    case 'check-space':assert(report.stages.length===0&&view.phase==='error'&&view.operation==='create'&&view.location===volume.mount&&view.requestId,'SPACE_FAILURE_REQUIRED');await until(()=>failureReceipt('BACKUP_STORAGE_FULL',report.started),3000);report.spaceError=failureReceipt('BACKUP_STORAGE_FULL',report.started);check('full-volume-keeps-records-and-no-success',JSON.stringify(facts(state))===JSON.stringify(facts(baseline))&&!fs.readdirSync(volume.mount).some(name=>name.endsWith('.helpr-backup')));write('space.json',{state,status:view,storage:report.storage});stage('space');result={spacePassed:true};break;
    case 'release-space':assert(report.stages.join(',')==='space','SPACE_FIRST');await volume.release();result={exports:path.join(root,'exports')};break;
    case 'arm-receipt':assert(volume.state.released&&report.stages.join(',')==='space'&&!reader&&!watcher,'RECEIPT_SEQUENCE');assert.equal(view.location,path.join(root,'exports'));receiptEpoch=gate.state(taskB).epoch;assert(gate.state(taskB).available,'NATIVE_CAPABILITY_REQUIRED');await armReader();watcher=fs.watch(path.join(root,'exports'),(_event,name)=>{try{if(name?.endsWith('.helpr-backup')){const file=path.join(root,'exports',name);if(fs.existsSync(file)){archive(file);receiptFile=file;save();}}}catch(error){failure??=error.message;}});result={armed:true};break;
    case 'check-receipt':assert(report.receiptReadyForRetry&&view.phase==='complete'&&view.requestId===receiptRequest,'ORIGINAL_RECEIPT_REQUIRED');sameCurrent(state);check('retry-original-archive-without-new-file',archive(receiptFile).sha256===receiptDigest&&fs.readdirSync(path.join(root,'exports')).filter(name=>name.endsWith('.helpr-backup')).length===1);write('receipt.json',{state,status:view,immediateStop,lostReceipt:report.lostReceipt});watcher.close();watcher=null;stage('receipt');result={receiptPassed:true};break;
    case 'arm-readonly':assert(report.stages.join(',')==='space,receipt'&&view.selection?.archive.file===oldArchive,'READONLY_SEQUENCE');fault('restore-current-copy-directory-readonly');fs.chmodSync(backupDirectory,0o500);readonly=true;result={armed:true};break;
    case 'check-readonly':assert(readonly&&view.phase==='error'&&view.operation==='restore'&&view.selection?.archive.file===oldArchive&&!view.safety,'RESTORE_FAILURE_REQUIRED');await until(()=>failureReceipt('BACKUP_STORAGE_UNAVAILABLE',report.faults.at(-1).at),3000);report.readonlyError=failureReceipt('BACKUP_STORAGE_UNAVAILABLE',report.faults.at(-1).at);sameCurrent(state);check('failed-current-copy-does-not-restore',state.tasks.every(t=>t.execution.restoreReview==='required'));write('readonly.json',{state,status:view});stage('readonly');result={readonlyPassed:true};break;
    case 'release-readonly':assert(readonly&&report.stages.join(',')==='space,receipt,readonly','READONLY_FIRST');fs.chmodSync(backupDirectory,0o700);readonly=false;result={released:true};break;
    case 'arm-restore-interrupt':assert(!readonly&&report.stages.join(',')==='space,receipt,readonly'&&!watcher,'RESTORE_SEQUENCE');restoreBefore=state;const recordIdentity=processRows().find(row=>row.pid===current.recordsPid);assert(recordIdentity&&recordIdentity.parent===current.child.pid&&current.pids.has(recordIdentity.pid)&&recordIdentity.command.includes(manifest.app),'OWN_RECORD_PROCESS_REQUIRED');fault('restore-copy-record-stop-armed',{...recordIdentity,signal:'SIGSTOP'});watcher=fs.watch(backupDirectory,(_event,name)=>{if(interrupted||!name?.endsWith('.partial'))return;try{assert(!current.exit&&current.recordsPid===recordIdentity.pid,'RECORD_IDENTITY_CHANGED');process.kill(recordIdentity.pid,'SIGSTOP');interrupted=true;report.interrupt={at:Date.now(),file:name,recordsPid:current.recordsPid};save();}catch(error){failure??=error.message;}});result={armed:true};break;
    case 'check-restore':assert(report.restoreReadyForRetry&&view.phase==='restored'&&view.requestId===report.interrupt.requestId&&view.selection?.token===report.interrupt.selectionToken&&view.archive.file===oldArchive,'ORIGINAL_RESTORE_NOT_RECONCILED');sameCurrent(state);const expectedSafety=path.join(backupDirectory,'before-restore-'+createHash('sha256').update(report.interrupt.requestId).digest('hex')+'.helpr-backup');check('restore-reconciled-paused-and-safety-valid',view.safety.file===expectedSafety&&state.tasks.every(t=>t.execution.restoreReview==='required')&&archive(view.safety.file).value.payload.tasks.some(t=>t.id===taskA&&t.goal.includes('保留新目标')));const newSafetyFiles=Object.keys(keptFiles()).filter(name=>!Object.hasOwn(originalSafety,name));check('one-safety-for-original-restore',newSafetyFiles.length===1&&newSafetyFiles[0]===path.basename(expectedSafety));report.finalFacts=facts(state);write('restored.json',{state,status:view,interrupt:report.interrupt});stage('restore');result={restored:true};break;
    case 'cold':assert(report.stages.join(',')==='space,receipt,readonly,restore','FAULTS_FIRST');await quit();limited();report.rounds.at(-1).ended=Date.now();deadline=Math.min(Date.now()+1200000,Date.now()+campaign.limits.activeMilliseconds-readBudget().backup07Closeout.activeMilliseconds);report.rounds.push({kind:'cold',started:Date.now(),deadline});clearTimeout(timer);timer=setTimeout(()=>{failure??='ROUND_TIME_LIMIT';},Math.max(1,deadline-Date.now()));await launch();const cold=await snapshot();check('fault-cold-retains-goals-stops-and-review',JSON.stringify(facts(cold))===JSON.stringify(report.finalFacts));stage('cold');result={cold:true};break;
    case 'finish':assert(report.stages.join(',')==='space,receipt,readonly,restore,cold','ALL_STAGES_REQUIRED');await quit();check('no-new-model-effect-or-task',report.models.length===0&&report.effects.length===0&&report.pageInputs.length===0&&(await snapshotFromDisk()).tasks.length===2);finished=true;result={finished:true};break;
    case 'abort':throw Error('CUA_ROUND_ABORTED');
   }write('command-result.json',{nonce:value.nonce,ok:true,value:result});}catch(error){write('command-result.json',{nonce:value.nonce,ok:false,error:error.message});throw error;}
  }
  await delay(300);
 }
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;console.error(error.stack);}
finally{
 clearTimeout(timer);watcher?.close();if(readonly){fs.chmodSync(backupDirectory,0o700);readonly=false;}
 try{await releaseReader();}catch(error){report.readerCleanupError=error.message;if(reader&&alive(reader.pid)){emergency();try{process.kill(-reader.pid,'SIGKILL');}catch{}await until(()=>!alive(reader.pid),1000,true);}}
 if(current&&!current.cleared){try{await quit();}catch(error){report.normalCleanupError=error.message;}
  if(!current.cleared){emergency();const rows=captureTree(current);for(const group of current.groups)if(rows.some(row=>row.group===group))try{process.kill(-group,'SIGTERM');}catch{}for(const pid of current.pids)if(alive(pid))try{process.kill(pid,'SIGTERM');}catch{}
   try{await until(()=>captureTree(current).length===0,5000,true);}catch{for(const group of current.groups)try{process.kill(-group,'SIGKILL');}catch{}for(const pid of current.pids)if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}await delay(500);}current.row.remaining=captureTree(current);if(current.row.remaining.length)report.passed=false;}
 }
 if(volume)try{await volume.cleanup();}catch(error){report.storageCleanupError=error.message;report.passed=false;}
 const helperGroups=report.helpers.map(row=>row.group);report.remainingHelperProcesses=processRows().filter(row=>helperGroups.includes(row.group)||helpers.has(row.pid));if(report.remainingHelperProcesses.length)report.passed=false;
 site.closeAllConnections();await new Promise(resolve=>site.close(resolve));report.ended=Date.now();report.rounds.at(-1).ended??=report.ended;{const b=readBudget();Object.assign(b.backup07Closeout.runs.find(row=>row.root===root),{ended:report.ended,passed:report.passed,error:report.error,remaining:current?.row.remaining??[],storageDetached:report.storage?.detached??false});fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n',{mode:0o600});}save();console.log('BACKUP_FAULT_RESULT '+JSON.stringify({passed:report.passed,error:report.error,root}));
}
async function snapshotFromDisk(){return snapshotSchema.parse(JSON.parse(fs.readFileSync(path.join(root,'snapshot.json'))));}
