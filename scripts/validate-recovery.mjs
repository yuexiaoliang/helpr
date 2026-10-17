// 05 实际签名候选的有限核对；仅本机虚构模型／网站，不操作正式资料或系统凭据。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {spend,validationRoot} from './workspace-budget.mjs';
import {verifyDevelopmentSignature} from './development-signing.mjs';

const build=Number(process.argv[2]?.match(/^--build=(\d+)$/)?.[1]);
assert(process.argv.length===3&&Number.isSafeInteger(build),'BUILD_REQUIRED');
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,`build-${build}.json`)));
assert(manifest.prepared&&path.isAbsolute(manifest.app),'PREPARED_BUILD_REQUIRED');
for(const [name,hash] of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(manifest.app,name))).digest('hex'),hash);
const signature=verifyDevelopmentSignature(manifest.app);
const root=path.join(validationRoot,`recovery-05-${build}`);
assert(!fs.existsSync(root),'ROUND_ALREADY_EXISTS');fs.mkdirSync(root,{mode:0o700});
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'pipe'});
const profileRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(profileRoot),profileRoot);
const profile=fs.mkdtempSync(profileRoot+'/recovery05-');
const report={build,archive:manifest.hashes['Contents/Resources/app.asar'],certificateSha256:signature.certificateSha256,started:new Date().toISOString(),scope:'packaged local fixtures; no real credential/login, IME, sleep or power-loss acceptance',limits:{starts:5,faults:3,cleanups:1,models:10,effects:2,tasks:3,minutes:8},starts:[],faults:[],effects:[],models:[],tasks:[],checks:[],realModelCalls:0,remoteWrites:0};
const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const snapshots={};const capture=(name,value)=>{snapshots[name]=value;fs.writeFileSync(path.join(root,'snapshots.json'),JSON.stringify(snapshots,null,2)+'\n',{mode:0o600});};
const check=(name,condition)=>{assert(condition,name);report.checks.push(name);save();};
const counts={A:0,B:0,C:0},heldModels=[];
let holdA=true,holdC=true,current,failed;
const deadline=Date.now()+report.limits.minutes*60000;
async function until(fn,ms=15000){const end=Math.min(deadline,Date.now()+ms);while(Date.now()<end){if(failed)throw Error(failed);if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('RECOVERY_WAIT_EXPIRED');}
function modelReply(res,value){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'fixture05',choices:[{index:0,delta:{content:JSON.stringify(value)},finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id:'fixture05',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');}
async function body(req){let value='';for await(const chunk of req){value+=chunk;assert(value.length<200000,'FIXTURE_REQUEST_TOO_LARGE');}return JSON.parse(value);}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');const page=url.pathname.match(/^\/page\/([ABC])$/),effect=url.pathname.match(/^\/effect\/([ABC])$/);
 if(req.method==='GET'&&page){const name=page[1];res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>05 ${name} 记录</title><style>body{font:20px -apple-system;padding:40px;color:#244135;background:#f4f8f5}button{font:inherit;padding:12px}</style><h1>05 ${name} 记录</h1><p>本次目标 ${name}-05</p><p id="count">${name} 写入 ${counts[name]} 次</p><button onclick="fetch('/effect/${name}',{method:'POST'}).then(r=>r.json()).then(r=>document.querySelector('#count').textContent='${name} 写入 '+r.count+' 次')">写入备注 ${name}</button><p>本机虚构记录，仅核对生命周期和重复操作。</p></html>`);return;}
 if(req.method==='POST'&&effect){const name=effect[1];counts[name]++;report.effects.push({name,count:counts[name],at:Date.now()});save();assert(report.effects.length<=report.limits.effects,'EFFECT_LIMIT');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:counts[name]}));return;}
 if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
  report.models.push({at:Date.now()});save();assert(report.models.length<=report.limits.models,'MODEL_LIMIT');const input=await body(req);
  const plan=input.messages.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.goal);
  const name=plan?.goal.match(/05 ([ABC])/)?.[1];assert(name,'PLAN_REQUIRED');
  const text=input.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');const count=Number(text.match(new RegExp(name+' 写入 (\\d+) 次'))?.[1]);assert(Number.isSafeInteger(count),'OBSERVATION_REQUIRED');
  Object.assign(report.models.at(-1),{name,count});save();
  const fact=`${name} 写入 ${count} 次`, value={decision:count===1?'complete':'act',summary:count===1?'本次备注已核对完成':'写入本次备注',evidence:[fact],previous:plan.previous?{id:plan.previous.id,status:count===1?'confirmed':'unknown',evidence:[fact]}:null,action:count===1?null:{kind:'click',target:{role:'button',name:'写入备注 '+name,exact:true}}};
  if((name==='A'&&count===1&&holdA)||(name==='C'&&count===0&&holdC))heldModels.push({name,count,res,value});else modelReply(res,value);return;
 }
 res.writeHead(404);res.end();
}catch(error){failed??=error.message;save();res.writeHead(400);res.end('FIXTURE_REJECTED');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function processRows(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));}
function descendants(rootPid){const rows=processRows();const found=new Set([rootPid]);let change=true;while(change){change=false;for(const [pid,parent]of rows)if(found.has(parent)&&!found.has(pid)){found.add(pid);change=true;}}return [...found];}
function snapshotProcesses(app){for(const pid of descendants(app.child.pid))app.pids.add(pid);const rows=processRows().filter(([pid])=>app.pids.has(pid));for(const [,,group]of rows){assert(app.pids.has(group),'UNOWNED_PROCESS_GROUP');app.groups.add(group);}Object.assign(report.starts.find(row=>row.pid===app.child.pid),{pids:[...app.pids],groups:[...app.groups],tree:rows});save();}
const groupMembers=app=>processRows().filter(([,,group])=>app.groups.has(group));
async function start({holdRecovery=false,duplicate=false}={}){
 assert(report.starts.length<report.limits.starts,'START_LIMIT');const used=spend('starts');
 const child=spawn(path.join(manifest.app,'Contents/MacOS/helpr'),['--workspace-validation','--workspace-fixture'],{env:{...env,HELPR_VALIDATION_DATA:profile,HELPR_FIXTURE_ORIGIN:origin,...(holdRecovery?{HELPR_VALIDATION_HOLD_RECOVERY:'1'}:{})},stdio:['ignore','ignore',fs.openSync(path.join(root,`stderr-${used.used.starts}.log`),'a',0o600),'ipc']});
 const app={child,pids:new Set([child.pid]),groups:new Set(),messages:[],pending:new Map(),sequence:0,ready:null,exit:null};
 report.starts.push({start:used.used.starts,pid:child.pid,duplicate,at:Date.now()});save();
 child.on('message',m=>{app.messages.push(m);if(m.ready)app.ready=m;const p=app.pending.get(m.id);if(p){clearTimeout(p.timer);app.pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}});
 child.once('exit',(code,signal)=>{app.exit={code,signal};for(const p of app.pending.values()){clearTimeout(p.timer);p.reject(Error('APPLICATION_EXITED'));}app.pending.clear();});
 if(duplicate){await until(()=>app.exit);check('competing-start-exits-without-new-owner',app.exit.code===0&&!app.ready);return app;}
 current=app;await until(()=>app.ready||app.exit);assert(app.ready&&!app.exit,'APPLICATION_NOT_READY');snapshotProcesses(app);return app;
}
function rpc(app,command){assert(app.child.connected,'NO_APPLICATION_CHANNEL');return new Promise((resolve,reject)=>{const id=++app.sequence;const timer=setTimeout(()=>{app.pending.delete(id);reject(Error('RPC_TIMEOUT'));},12000);app.pending.set(id,{resolve,reject,timer});app.child.send({id,command});});}
const snapshot=app=>rpc(app,{kind:'snapshot'});
async function configure(app){await rpc(app,{kind:'model-save',requestId:randomUUID(),endpoint:origin+'/v1',model:'local-fixture-05',apiKey:'local-fixture-not-a-secret'});}
async function create(app,name){assert(report.tasks.length<report.limits.tasks,'TASK_LIMIT');report.tasks.push({name,attempt:true});save();const result=await rpc(app,{kind:'create',requestId:randomUUID(),goal:`05 ${name} 写入一条核对备注并核对完成 ${origin}/page/${name}`});Object.assign(report.tasks.at(-1),{id:result.taskId});save();await until(async()=>(await snapshot(app)).tasks.find(t=>t.id===result.taskId)?.phase==='manual');return result.taskId;}
const intent=(app,taskId,value)=>rpc(app,{kind:'execution-intent',taskId,requestId:randomUUID(),intent:value});
async function barrier(app){await until(async()=>{const s=await rpc(app,{kind:'validation-barrier',control:{action:'status'}});return s.waits.some(w=>w.key==='recovery:*'&&w.reached);});await configure(app);await rpc(app,{kind:'validation-barrier',control:{action:'release',point:'recovery',taskId:'*'}});}
async function gone(app){await until(()=>app.exit,10000);await until(()=>[...app.pids].every(pid=>!alive(pid))&&groupMembers(app).length===0,8000);const remaining=groupMembers(app);Object.assign(report.starts.find(row=>row.pid===app.child.pid),{exit:app.exit,remaining});check('owned-tree-cleared-'+app.child.pid,[...app.pids].every(pid=>!alive(pid))&&remaining.length===0);}
async function quit(app){snapshotProcesses(app);await rpc(app,{kind:'quit'}).catch(error=>{if(error.message!=='APPLICATION_EXITED')throw error;});await gone(app);assert.equal(app.exit.code,0,'NORMAL_EXIT_REQUIRED');}
function fault(pid,signal,label){assert(report.faults.length<report.limits.faults,'FAULT_LIMIT');spend('faults');report.faults.push({pid,signal,label,at:Date.now()});save();process.kill(pid,signal);}
try{
 console.log('05 first start: interrupted result and owner cleanup');
 const first=await start();await configure(first);const a=await create(first,'A'),b=await create(first,'B');
 await intent(first,b,'stop');await intent(first,a,'start');
 await until(()=>counts.A===1&&heldModels.some(m=>m.name==='A'&&!m.res.destroyed));capture('before-owner-exit',await snapshot(first));snapshotProcesses(first);
 fault(first.ready.recordsPid,'SIGSTOP','records-unresponsive');fault(first.child.pid,'SIGKILL','owner-exits-with-effect-unrecorded');await gone(first);holdA=false;for(const item of heldModels)if(item.name==='A'&&!item.res.destroyed)modelReply(item.res,item.value);
 console.log('05 cold reopen: reconcile existing effect and retain stop');
 const second=await start({holdRecovery:true});await barrier(second);await until(async()=>(await snapshot(second)).tasks.find(t=>t.id===a)?.execution?.phase==='complete');
 const recovered=await snapshot(second);capture('after-cold-recovery',recovered);check('one-effect-after-cold-recovery',counts.A===1&&counts.B===0);check('original-stop-retained',recovered.tasks.find(t=>t.id===b)?.execution?.intent==='stopped');
 await start({duplicate:true});
 await rpc(second,{kind:'validation-barrier',control:{action:'arm',point:'exit-checkpoint',taskId:'*'}});
 const exiting=rpc(second,{kind:'quit'}).then(()=>({accepted:true}),error=>({error:error.message}));
 await until(async()=>{const status=await rpc(second,{kind:'validation-barrier',control:{action:'status'}});return status.waits.some(w=>w.key==='exit-checkpoint:*'&&w.reached);});
 const recordsPid=second.ready.recordsPid;fault(recordsPid,'SIGKILL','record-process-exits-during-quit-checkpoint');await until(()=>second.messages.some(m=>m.recordsUnavailable&&m.duringExit));
 await rpc(second,{kind:'validation-barrier',control:{action:'release',point:'exit-checkpoint',taskId:'*'}});const interrupted=await exiting;check('exit-failure-retains-application',Boolean(interrupted.error)&&!second.exit);
 await until(()=>second.messages.some(m=>m.recordsRestored));snapshotProcesses(second);capture('after-record-reconnect',await snapshot(second));check('new-record-process',second.messages.some(m=>m.recordsRestored&&m.recordsPid!==recordsPid));await quit(second);
 console.log('05 normal reopen and exit with undispatched remaining work');
 const third=await start();capture('normal-reopen',await snapshot(third));const c=await create(third,'C');await configure(third);await intent(third,c,'start');await until(()=>heldModels.some(m=>m.name==='C'&&!m.res.destroyed));capture('before-normal-quit',await snapshot(third));await quit(third);holdC=false;
 console.log('05 final reopen: resume only undispatched remainder');
 const fourth=await start({holdRecovery:true});await barrier(fourth);await until(async()=>(await snapshot(fourth)).tasks.find(t=>t.id===c)?.execution?.phase==='complete');capture('final',await snapshot(fourth));check('only-remaining-work-written-once',counts.A===1&&counts.B===0&&counts.C===1);await quit(fourth);
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
finally{
 if(current&&!current.exit){try{await quit(current);}catch(error){report.quitFailure=error.message;}}
 if(current){const left=[...current.pids].filter(alive);if(left.length){spend('cleanups');report.cleanup={pids:left};for(const pid of left.reverse())if(alive(pid))process.kill(pid,'SIGKILL');const cleanupDeadline=Date.now()+5000;while(left.some(alive)&&Date.now()<cleanupDeadline)await new Promise(r=>setTimeout(r,40));report.cleanup.remaining=left.filter(alive);}}
 for(const item of heldModels)if(!item.res.destroyed)item.res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));
 report.finished=new Date().toISOString();report.counts=counts;report.global=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json'))).used;save();
 console.log(JSON.stringify({passed:report.passed,error:report.error,build,starts:report.starts.map(s=>s.start),models:report.models.length,effects:report.effects.length,checks:report.checks,cleanup:report.cleanup}));
}
