// 07：一个受管入口管理两次顺序启动。CUA 操作真实 UI；本地文件命令仅准备和独立核对。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spend, validationRoot } from './workspace-budget.mjs';
import { verifyDevelopmentSignature } from './development-signing.mjs';

const contractFile = path.join(validationRoot, 'backup-contracts.mjs');
fs.mkdirSync(validationRoot, {recursive:true,mode:0o700});
createRequire(import.meta.resolve('vite'))('esbuild').buildSync({stdin:{contents:"export {uiCommandSchema} from './app/shared/contracts';export {nextStepSchema} from './app/shared/execution';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:contractFile});
const {uiCommandSchema,nextStepSchema} = await import(pathToFileURL(contractFile).href);
const commands = origin => ({
  configure: state => ({kind:'model-save',requestId:randomUUID(),expectedVersion:state.modelSettings?.version??0,protocol:'chat-completions',endpoint:origin+'/v1',model:'local-fixture-07',apiKey:'local-fixture-not-a-secret'}),
  create: name => ({kind:'create',requestId:randomUUID(),goal:`07 ${name} 写入一条备注并核对完成 ${origin}/page/${name}`}),
  intent:(taskId,intent)=>({kind:'execution-intent',requestId:randomUUID(),taskId,intent}),
});
function replyFor(name,count,plan,initial) {
  const fact=`${name} 写入 ${count} 次`;
  return nextStepSchema.parse({decision:initial?'wait':count===1?'complete':'act',summary:initial?'等待本机备份核对':count===1?'本次备注已有实际结果':'写入本次备注',evidence:[fact],previous:plan.previous?{id:plan.previous.id,status:count===1?'confirmed':'unknown',evidence:[fact]}:null,action:initial||count===1?null:{kind:'click',target:{role:'button',name:'写入备注 '+name,exact:true}}});
}
const samples=commands('http://127.0.0.1:4319');
for(const command of [{kind:'snapshot'},{kind:'quit'},samples.configure({}),...['A','B'].map(samples.create),samples.intent('fixture','start'),samples.intent('fixture','stop'),samples.intent('fixture','continue')])uiCommandSchema.parse(command);
for(const initial of [true,false])for(const name of ['A','B'])for(const count of [0,1])replyFor(name,count,{previous:count?{id:'prior'}:null},initial);
if(process.argv.length===3&&process.argv[2]==='--check'){console.log(JSON.stringify({valid:true,appStarts:0,models:0,effects:0}));process.exit(0);}
const build=Number(process.argv[2]?.match(/^--build=(\d+)$/)?.[1]);
assert(Number.isSafeInteger(build)&&[3,4].includes(process.argv.length),'BUILD_REQUIRED');
assert(process.argv.length!==4||process.argv[3]==='--preflight','INVALID_OPTION');
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,`build-${build}.json`)));
assert(manifest.prepared&&path.isAbsolute(manifest.app),'PREPARED_BUILD_REQUIRED');
for(const [file,hash]of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(manifest.app,file))).digest('hex'),hash,file);
const signature=verifyDevelopmentSignature(manifest.app);
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'pipe',timeout:65000});
const ps=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return {pid:+match[1],parent:+match[2],group:+match[3],command:match[4]};});
assert(!ps().some(row=>row.pid!==process.pid&&(/\/helpr\.app\/Contents\/MacOS\/helpr(?: |$)/.test(row.command)||/^(?:\S*\/)?node scripts\/validate-(?:backup|workspace-ui|recovery|lifecycle)\.mjs/.test(row.command))),'OTHER_VALIDATION_RUNNING');
const budget=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json')));
assert(budget.used.starts+2<=budget.limits.starts&&budget.used.cleanups+1<=budget.limits.cleanups,'ROUND_BUDGET_NOT_RESERVED');
const root=path.join(validationRoot,`backup-07-${build}`);
assert(!fs.existsSync(root),'ROUND_ALREADY_EXISTS');
if(process.argv[3]==='--preflight'){console.log(JSON.stringify({preflight:true,build,starts:2,models:12,effects:2,inputs:40,minutes:20,appStarts:0}));process.exit(0);}
fs.mkdirSync(root,{mode:0o700});
const profileRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(profileRoot),profileRoot);
const profile=fs.mkdtempSync(profileRoot+'/backup07-');
const exportFolder=path.join(root,'selected-backups');fs.mkdirSync(exportFolder,{mode:0o700});
const report={build,archive:manifest.hashes['Contents/Resources/app.asar'],certificate:signature.certificateSha256,started:new Date().toISOString(),scope:'07 packaged local fixtures; CUA native UI; no real model, remote writes, installation or injected faults',limits:{starts:2,models:12,effects:2,inputs:40,minutes:20},starts:[],models:[],effects:[],inputs:[],tasks:[],checks:[],stages:[],realModels:0,remoteWrites:0};
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const save=()=>write('result.json',report);
write('private-context.json',{profile,exportFolder,app:manifest.app});
const deadline=Date.now()+20*60000;
let failure,initial=true,current,finished=false,setup=false,coldBaseline;
const check=(name,condition)=>{assert(condition,name);if(!report.checks.includes(name))report.checks.push(name);save();};
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {failure ??= 'VALIDATOR_'+signal; save();});
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(fn,ms=15000,cleanup=false){const end=cleanup?Date.now()+ms:Math.min(deadline,Date.now()+ms);while(Date.now()<end){if(!cleanup&&failure)throw Error(failure);if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw Error('BACKUP_WAIT_EXPIRED');}
function limited(){assert(Date.now()<deadline,'ROUND_TIME_LIMIT');if(failure)throw Error(failure);}
const counts={A:0,B:0};
const server=http.createServer(async(req,res)=>{try{
 limited();const url=new URL(req.url,'http://127.0.0.1');const page=url.pathname.match(/^\/page\/([AB])$/),effect=url.pathname.match(/^\/effect\/([AB])$/),input=url.pathname.match(/^\/input\/([AB])$/);
 if(req.method==='GET'&&page){const name=page[1];res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>07 ${name} 备注</title><style>body{font:20px -apple-system;padding:32px;color:#244135;background:#f4f8f5}button{font:inherit;padding:12px}</style><h1>07 ${name} 备注</h1><p id="count">${name} 写入 ${counts[name]} 次</p><button onclick="fetch('/effect/${name}',{method:'POST'}).then(r=>r.json()).then(r=>document.querySelector('#count').textContent='${name} 写入 '+r.count+' 次')">写入备注 ${name}</button><p>本机虚构记录，仅核对备份与已有结果。</p><script>for(const kind of ['pointerdown','keydown'])document.addEventListener(kind,()=>fetch('/input/${name}',{method:'POST'}));</script></html>`);return;}
 if(req.method==='POST'&&effect){const name=effect[1];assert(report.starts.length===1,'COLD_START_WRITE_FORBIDDEN');assert(counts[name]===0&&report.effects.length<2,'EFFECT_LIMIT');counts[name]++;report.effects.push({name,count:counts[name],at:Date.now()});save();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:counts[name]}));return;}
 if(req.method==='POST'&&input){assert(report.inputs.length<40,'INPUT_LIMIT');report.inputs.push({name:input[1],at:Date.now()});save();res.end('OK');return;}
 if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
  assert(report.starts.length===1,'COLD_START_MODEL_FORBIDDEN');assert(report.models.length<12,'MODEL_LIMIT');const attempt={at:Date.now(),attempt:true};report.models.push(attempt);save();let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<200000,'MODEL_BODY_LIMIT');}
  limited();const value=JSON.parse(raw);const plan=value.messages.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.goal);assert(plan,'PLAN_REQUIRED');
  const observed=value.messages.findLast(m=>m.content?.startsWith('当前任务：'));assert(observed,'OBSERVATION_REQUIRED');const name=observed.content.match(/\nhttp:\/\/127\.0\.0\.1:\d+\/page\/([AB])\n/)?.[1];assert(name,'LOCAL_OBSERVATION_URL_REQUIRED');const count=Number(observed.content.match(new RegExp(name+' 写入 (\\d+) 次'))?.[1]);assert([0,1].includes(count),'COUNT_OBSERVATION_REQUIRED');
  const reply=replyFor(name,count,plan,initial);Object.assign(attempt,{name,count,decision:reply.decision});save();
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'fixture07',choices:[{index:0,delta:{content:JSON.stringify(reply)},finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id:'fixture07',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');return;
 }
 res.writeHead(404);res.end();
 }catch(error){failure??=error.message;save();if(!res.headersSent)res.writeHead(400);res.end('FIXTURE_REJECTED');}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`, command=commands(origin);
write('context.json',{root,origin,exportFolder,hostApp:path.join(manifest.app,'Contents/Frameworks/helpr Workspace.app')});
const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
function processes(app){const rows=ps(),ids=app.pids;let added=true;while(added){added=false;for(const row of rows)if(ids.has(row.parent)&&!ids.has(row.pid)){ids.add(row.pid);added=true;}}const own=rows.filter(row=>ids.has(row.pid));for(const row of own)if(ids.has(row.group))app.groups.add(row.group);Object.assign(app.report,{tree:own,pids:[...ids],groups:[...app.groups]});save();return rows.filter(row=>ids.has(row.pid)||app.groups.has(row.group));}
async function launch(){limited();assert(report.starts.length<2,'START_LIMIT');if(current)assert(current.cleared,'PREVIOUS_NOT_CLEARED');const used=spend('starts');
 const child=spawn(path.join(manifest.app,'Contents/MacOS/helpr'),['--workspace-validation','--workspace-fixture'],{env:{...env,HELPR_VALIDATION_DATA:profile,HELPR_FIXTURE_ORIGIN:origin},stdio:['ignore','ignore',fs.openSync(path.join(root,`stderr-${used.used.starts}.log`),'a',0o600),'ipc']});
 const row={start:used.used.starts,pid:child.pid,at:Date.now()},app={child,pids:new Set([child.pid]),groups:new Set(),pending:new Map(),sequence:0,ready:null,exit:null,report:row,cleared:false};current=app;report.starts.push(row);save();
 child.on('message',m=>{if(m.ready)app.ready=m;if(m.startupFailure)row.startupFailure=m.startupFailure;if(m.hostPid)app.pids.add(m.hostPid);if(m.launcherPid)app.pids.add(m.launcherPid);const pending=app.pending.get(m.id);if(pending){clearTimeout(pending.timer);app.pending.delete(m.id);m.error?pending.reject(Error(m.error)):pending.resolve(m.value);}});
 child.once('exit',(code,signal)=>{app.exit={code,signal};row.exit=app.exit;for(const p of app.pending.values()){clearTimeout(p.timer);p.reject(Error('APPLICATION_EXITED'));}app.pending.clear();save();});
 await until(()=>{processes(app);return app.ready||app.exit;},30000);assert(app.ready&&!app.exit,'APPLICATION_NOT_READY');write('ready.json',app.ready);await rpc({kind:'show'});console.log('BACKUP_READY '+JSON.stringify({root,origin,start:row.start,hostApp:path.join(manifest.app,'Contents/Frameworks/helpr Workspace.app')}));}
function rpc(command){if(command.kind!=='quit')limited();const app=current;if(command.kind!=='show')uiCommandSchema.parse(command);assert(app.child.connected,'NO_APPLICATION_CHANNEL');return new Promise((resolve,reject)=>{const id=++app.sequence;const timer=setTimeout(()=>{app.pending.delete(id);reject(Error('RPC_TIMEOUT'));},command.kind==='quit'?45000:15000);app.pending.set(id,{resolve,reject,timer});app.child.send({id,command});});}
async function snapshot(){const state=await rpc({kind:'snapshot'});write('snapshot.json',state);return state;}
async function gone(app){await until(()=>app.exit,45000,true);await until(()=>processes(app).length===0,8000,true);app.report.remaining=processes(app);app.cleared=true;check('owned-processes-cleared-'+app.child.pid,app.report.remaining.length===0);assert.equal(app.exit.code,0,'NORMAL_EXIT_REQUIRED');}
async function quit(){if(!current.exit)await rpc({kind:'quit'}).catch(error=>{if(error.message!=='APPLICATION_EXITED')throw error;});await gone(current);}
function archive(file){const parsed=JSON.parse(fs.readFileSync(file,'utf8')),raw=Buffer.from(JSON.stringify(parsed.payload));assert.equal(parsed.format,'helpr-backup');assert.equal(parsed.version,1);assert.equal(parsed.dataVersion,6);assert.equal(parsed.stateModel,1);assert.equal(parsed.files[0].bytes,raw.length);assert.equal(parsed.files[0].sha256,createHash('sha256').update(raw).digest('hex'));assert(!/ciphertext|local-fixture-not-a-secret|modelSettings|cookie|sessionToken/.test(JSON.stringify(parsed)),'PRIVATE_CONFIGURATION_EXPORTED');return parsed;}
async function inspect(stage){assert.equal(stage,['backup','restored','reviewed','completed'][report.stages.length],'STAGE_ORDER');const state=await snapshot(),status=await rpc({kind:'backup-status'});write(stage+'.json',{state,status,counts,models:report.models.length});
 if(stage==='backup'){assert.equal(status.phase,'complete');const saved=archive(status.archive.file);check('selected-logical-backup-and-exclusions',saved.payload.tasks.length===2&&status.archive.file.startsWith(exportFolder+path.sep));report.oldBackup=status.archive.file;}
 if(stage==='restored'){assert.equal(status.phase,'restored');assert.equal(status.archive.file,report.oldBackup);const safety=archive(status.safety.file),a=state.tasks.find(t=>t.id===report.tasks[0].id);check('new-stop-and-goal-preserved',a.execution.intent==='stopped'&&a.execution.goal.includes('保留新目标')&&a.execution.restoreReview==='required');check('safety-preserves-current-goal',safety.payload.tasks.some(t=>t.id===a.id&&t.execution.goal.includes('保留新目标')));check('restore-paused-all-and-no-repeated-result',state.tasks.every(t=>t.execution.restoreReview==='required')&&counts.A===0&&counts.B===1);report.safety=status.safety.file;}
 if(stage==='reviewed'){const a=state.tasks.find(t=>t.id===report.tasks[0].id),b=state.tasks.find(t=>t.id===report.tasks[1].id);check('readonly-review-does-not-write',counts.A===0&&counts.B===1&&a.execution.restoreReview==='ready'&&a.execution.intent==='stopped'&&b.execution.restoreReview==='complete');}
 if(stage==='completed'){const a=state.tasks.find(t=>t.id===report.tasks[0].id),b=state.tasks.find(t=>t.id===report.tasks[1].id);check('only-selected-A-continues-once',counts.A===1&&counts.B===1&&a.execution.phase==='complete'&&b.execution.restoreReview==='complete');coldBaseline={facts:state.tasks.map(t=>[t.id,t.goal,t.messages,t.execution.intent,t.execution.goal,t.execution.restoreReview,t.execution.actions]),models:report.models.length,effects:report.effects.length};}
 report.stages.push(stage);save();return {status,counts,models:report.models.length};}
let timer;
try{
 await launch();
 // OS/Node 计时兜底独立于网页 JS。退出或超时只处理本轮拥有实例。
 timer=setTimeout(()=>{failure??='ROUND_TIME_LIMIT';},Math.max(1,deadline-Date.now()));
 while(!finished){limited();processes(current);if(!current.exit)await snapshot();const file=path.join(root,'command.json');
  if(fs.existsSync(file)){const input=JSON.parse(fs.readFileSync(file));fs.unlinkSync(file);let value;
   try{switch(input.op){
    case 'setup':{assert(!setup&&report.starts.length===1,'SETUP_ALREADY_USED');setup=true;await rpc(command.configure(await snapshot()));for(const name of ['A','B']){const result=await rpc(command.create(name));report.tasks.push({name,id:result.taskId});await until(async()=>(await snapshot()).tasks.find(t=>t.id===result.taskId)?.phase==='manual');}for(const task of report.tasks)await rpc(command.intent(task.id,'start'));await until(async()=>(await snapshot()).tasks.every(t=>t.execution?.phase==='unknown'),60000);initial=false;check('two-tasks-wait-without-effects',report.models.length===2&&report.effects.length===0);value=report.tasks;break;}
    case 'inspect':assert(['backup','restored','reviewed','completed'].includes(input.stage),'INVALID_STAGE');value=await inspect(input.stage);break;
    case 'cold':{assert(coldBaseline,'COMPLETE_FIRST');await quit();await launch();const state=await snapshot();check('cold-retains-current-intent-goal-and-history',JSON.stringify(state.tasks.map(t=>[t.id,t.goal,t.messages,t.execution.intent,t.execution.goal,t.execution.restoreReview,t.execution.actions]))===JSON.stringify(coldBaseline.facts));check('cold-no-model-or-effect',report.models.length===coldBaseline.models&&report.effects.length===coldBaseline.effects);value={cold:true};break;}
    case 'finish':assert(report.starts.length===2&&coldBaseline&&report.stages.join(',')==='backup,restored,reviewed,completed','COLD_AND_ALL_STAGES_REQUIRED');await quit();check('cold-no-model-or-effect',report.models.length===coldBaseline.models&&report.effects.length===coldBaseline.effects);finished=true;value={finished:true};break;
    case 'abort':throw Error('CUA_ROUND_ABORTED');
    default:throw Error('INVALID_CONTROL');
   }write('command-result.json',{nonce:input.nonce,ok:true,value});}catch(error){write('command-result.json',{nonce:input.nonce,ok:false,error:error.message});throw error;}
  }
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;console.error(error.stack);}
finally{
 clearTimeout(timer);if(current&&!current.cleared){processes(current);try{await quit();}catch(error){report.normalCleanupError=error.message;}
  if(!current.cleared){spend('cleanups');const rows=processes(current);for(const group of current.groups)if(rows.some(row=>row.group===group))try{process.kill(-group,'SIGTERM');}catch{}
   for(const pid of current.pids)if(alive(pid))try{process.kill(pid,'SIGTERM');}catch{}
   try{await until(()=>processes(current).length===0,5000,true);}catch{for(const group of current.groups)try{process.kill(-group,'SIGKILL');}catch{}for(const pid of current.pids)if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
   report.cleanupRemaining=processes(current);if(report.cleanupRemaining.length)report.passed=false;
  }
 }
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));report.counts=counts;report.ended=new Date().toISOString();save();console.log('BACKUP_RESULT '+JSON.stringify({passed:report.passed,error:report.error,root}));
}
