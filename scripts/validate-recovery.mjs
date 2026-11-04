// 05 实际签名候选的有限核对；仅本机虚构模型／网站，不操作正式资料或系统凭据。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spend as debit,validationRoot} from './workspace-budget.mjs';
import {verifyDevelopmentSignature} from './development-signing.mjs';
import {confirmUpgradeUI,requireUpgradeNativePreflight} from './upgrade-validation-state.mjs';
const upgrade09=process.argv.includes('--upgrade09');
const coordination=process.argv.includes('--coordination');
const coordinationTail=process.argv.includes('--tail');
assert(!coordinationTail||coordination,'COORDINATION_TAIL_REQUIRED');
assert(!coordination||upgrade09,'UPGRADE09_COORDINATION_REQUIRED');
const spend=kind=>debit(kind,upgrade09?'upgrade09Repair':undefined);

// 直接加载正式公开契约；预检不启动产品、不访问网站或凭据。
function commandsFor(origin){return {
 snapshot:()=>({kind:'snapshot'}), quit:()=>({kind:'quit'}),
 configure:state=>({kind:'model-save',requestId:randomUUID(),protocol:'chat-completions',expectedVersion:state.modelSettings?.version??0,endpoint:origin+'/v1',model:'local-fixture-05',apiKey:'local-fixture-not-a-secret'}),
 create:name=>({kind:'create',requestId:randomUUID(),goal:`05 ${name} 写入一条核对备注并核对完成 ${origin}/page/${name}`}),
 intent:(taskId,intent)=>({kind:'execution-intent',taskId,requestId:randomUUID(),intent}),
};}
fs.mkdirSync(validationRoot,{recursive:true,mode:0o700});
const schemaFile=path.join(validationRoot,'recovery-command-contracts.mjs');
createRequire(import.meta.resolve('vite'))('esbuild').buildSync({stdin:{contents:"export {uiCommandSchema} from './app/shared/contracts';export {nextStepSchema} from './app/shared/execution';export {ValidationBarriers} from './app/desktop/validation-barriers';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:schemaFile});
const {uiCommandSchema,nextStepSchema,ValidationBarriers}=await import(pathToFileURL(schemaFile).href);
const samples=commandsFor('http://127.0.0.1:4319');
assert.equal(samples.configure({modelSettings:null}).expectedVersion,0);assert.equal(samples.configure({modelSettings:{version:7}}).expectedVersion,7);
for(const command of [samples.snapshot(),samples.quit(),samples.configure({modelSettings:null}),samples.configure({modelSettings:{version:7}}),...['A','B','C'].map(name=>samples.create(name)),samples.intent('fixture-task','start'),samples.intent('fixture-task','stop'),samples.intent('fixture-task','continue')])uiCommandSchema.parse(command);
for(const point of ['recovery','exit-checkpoint']){const barrier=new ValidationBarriers();barrier.control({action:'arm',point,taskId:'*'});const waiting=barrier.pass(point,'*');barrier.control({action:'status'});barrier.control({action:'release',point,taskId:'*'});await waiting;}
if(process.argv.length===3&&process.argv[2]==='--check-commands'){console.log(JSON.stringify({commandsValid:true,configurationVersions:[0,7],barriers:['recovery','exit-checkpoint'],appStarts:0,modelCalls:0,effects:0}));process.exit(0);}

const args=process.argv.slice(2),preflight=args.at(-1)==='--preflight';if(preflight)args.pop();
if(upgrade09)args.splice(args.indexOf('--upgrade09'),1);
if(coordination)args.splice(args.indexOf('--coordination'),1);
if(coordinationTail)args.splice(args.indexOf('--tail'),1);
const build=Number(args[0]?.match(/^--build=(\d+)$/)?.[1]);
const quitFollowup=args[1]==='--resume=planned-control-close';
const signingFollowup=args[2]==='--signing-followup';
const freshC=args[3]==='--fresh-c-after-profile-loss';
const resume=args[1]==='--resume=startup-evidence'?'startup-evidence':args[1]==='--resume=configuration-contract'?'configuration-contract':upgrade09&&args[1]==='--resume=show-contract'?'show-contract':coordination&&args[1]==='--resume=coordination-version'?'coordination-version':null;
assert((args.length===1||(args.length===2&&(resume||quitFollowup))||(args.length===3&&quitFollowup&&signingFollowup&&build===32)||(args.length===4&&freshC&&quitFollowup&&signingFollowup&&build===32))&&Number.isSafeInteger(build),'BUILD_REQUIRED');
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,`build-${build}${signingFollowup?'-signing-followup':''}.json`)));
if(upgrade09){assert(build===41&&(args.length===1||['show-contract','coordination-version'].includes(resume)),'FIXED_UPGRADE09_BUILD_REQUIRED');manifest.app=path.join(validationRoot,'upgrade09-final-migration/helpr.app');}
if(signingFollowup){
 const original=path.join(validationRoot,'build-32.json');
 assert(manifest.origin==='signing-followup'&&manifest.build===32&&manifest.sourceManifestSha256===createHash('sha256').update(fs.readFileSync(original)).digest('hex'),'SIGNING_FOLLOWUP_SOURCE_CHANGED');
 assert.equal(manifest.hashes?.['Contents/Resources/app.asar'],manifest.sourceArchiveSha256,'SIGNING_FOLLOWUP_ARCHIVE_CHANGED');
}
assert(manifest.prepared&&path.isAbsolute(manifest.app),'PREPARED_BUILD_REQUIRED');
for(const [name,hash] of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(manifest.app,name))).digest('hex'),hash);
const signature=verifyDevelopmentSignature(manifest.app);
const originalRoot=path.join(validationRoot,coordination?`upgrade09-coordination-${build}${coordinationTail?'-tail':''}`:upgrade09?`upgrade09-recovery-${build}`:`recovery-05-${build}`);
let carry=null,followup=null,previous=null;
if(quitFollowup){
 followup=JSON.parse(fs.readFileSync(path.join(validationRoot,'recovery-05-quit-followup.json')));
 assert(path.resolve(followup.source).startsWith(validationRoot+path.sep),'INVALID_SOURCE_ROOT');
 assert.equal(createHash('sha256').update(fs.readFileSync(followup.source)).digest('hex'),followup.sourceSha256);
 previous=JSON.parse(fs.readFileSync(followup.source));
 assert(previous.build<build&&previous.certificateSha256===signature.certificateSha256&&previous.error==='RECOVERY_WAIT_EXPIRED'&&previous.counts.A===1&&previous.counts.B===0&&previous.counts.C===0&&previous.models.length===4&&previous.effects.length===1&&previous.tasks.length===3&&previous.faults.length===3&&previous.starts.every(s=>s.remaining?.length===0),'INVALID_QUIT_FOLLOWUP');
 assert(previous.tasks.some(t=>t.name==='C'&&t.id===followup.taskId),'INVALID_FOLLOWUP_TASK');
 if(freshC)assert(!fs.existsSync(followup.profile),'ORIGINAL_PROFILE_STILL_EXISTS');
 else assert(fs.existsSync(followup.profile),'ORIGINAL_PROFILE_MISSING');
 const origin=new URL(followup.origin);assert(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&origin.port&&origin.origin===followup.origin,'LOCAL_ORIGIN_REQUIRED');
 carry={source:followup.source,sha256:followup.sourceSha256,starts:[...previous.carry.starts,...previous.starts.map(s=>s.start)],models:previous.models.length,effects:previous.effects.length,tasks:previous.tasks.length,faults:previous.faults.length,cleanups:previous.carry.cleanups+(previous.cleanup?1:0)};
}
if(resume){
 const previousFile=path.join(['startup-evidence','show-contract','coordination-version'].includes(resume)?originalRoot:originalRoot+'-resume','result.json');previous=JSON.parse(fs.readFileSync(previousFile));
 if(resume==='coordination-version')assert(previous.build===41&&previous.archive===manifest.hashes['Contents/Resources/app.asar']&&!previous.passed&&previous.error==='RECOVERY_WAIT_EXPIRED'&&previous.starts.length===1&&previous.starts[0].start===123&&previous.starts[0].exit.code===0&&previous.starts[0].remaining.length===0&&previous.models.length===3&&previous.effects.length===1&&previous.tasks.length===3&&previous.counts.A===1&&previous.counts.B===0&&previous.counts.C===0&&previous.faults.length===0&&!previous.cleanup,'EXACT_COORDINATION_CHECKPOINT_REQUIRED');
 else assert(previous.build===build&&previous.archive===manifest.hashes['Contents/Resources/app.asar']&&!previous.passed&&(resume==='show-contract'?previous.error.includes('invalid_union')&&previous.starts[0].start===118&&previous.starts[0].exit.code===0&&previous.starts[0].remaining.length===0:previous.error===(resume==='startup-evidence'?'UNOWNED_PROCESS_GROUP':'INVALID_REQUEST'))&&previous.starts.length===1&&previous.models.length===0&&previous.effects.length===0&&previous.tasks.length===0&&previous.faults.length===0&&(previous.cleanup?.remaining??[]).length===0,'UNEXPECTED_RESUME_STATE');
 if(resume==='configuration-contract')assert(previous.starts[0].start===71&&previous.checks.includes('owned-tree-cleared-'+previous.starts[0].pid),'UNCLEARED_PREVIOUS_RUN');
 carry={source:path.relative(process.cwd(),previousFile),sha256:createHash('sha256').update(fs.readFileSync(previousFile)).digest('hex'),starts:[...(previous.carry?.starts??[]),...previous.starts.map(s=>s.start)],models:previous.models.length,effects:previous.effects.length,tasks:previous.tasks.length,faults:previous.faults.length,cleanups:(previous.carry?.cleanups??0)+(previous.cleanup?1:0)};
}
const root=freshC?originalRoot+'-quit-followup-after-profile-loss':quitFollowup?originalRoot+'-quit-followup':resume?originalRoot+(resume==='startup-evidence'?'-resume':resume==='show-contract'?'-show-contract':resume==='coordination-version'?'-version-resume':'-contract-resume'):originalRoot;
assert(!fs.existsSync(root),'ROUND_ALREADY_EXISTS');
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'pipe'});
const profileRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(profileRoot),profileRoot);
if(quitFollowup&&!freshC)assert(followup.profile.startsWith(profileRoot+'/recovery05-')&&fs.realpathSync(followup.profile)===followup.profile,'INVALID_PROFILE_ROOT');
const limits=quitFollowup?{starts:2,faults:0,cleanups:1,models:6,effects:1,tasks:freshC?1:0,minutes:8}:{starts:4,faults:3,cleanups:1,models:10,effects:2,tasks:3,minutes:8};
if(coordination)Object.assign(limits,{starts:2,faults:0,models:10,effects:1});
const remainingBudget=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json')));
if(upgrade09){
 assert(remainingBudget.upgrade09Repair?.approved&&remainingBudget.upgrade09Repair?.unlimited&&remainingBudget.upgrade09Repair?.active,'UPGRADE09_APPROVAL_REQUIRED');
 requireUpgradeNativePreflight(remainingBudget.upgrade09Repair.nativePreflight);
 limits.minutes=20;
 const others=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(r=>{const m=r.trim().match(/^(\d+)\s+(.*)$/);return{pid:+m[1],command:m[2]};});
 const conflicts=others.filter(r=>r.pid!==process.pid&&(/^\S+\/helpr\.app\/Contents\/MacOS\/helpr(?: |$)/.test(r.command)||/^\/.*\/Contents\/MacOS\/helpr Workspace Helper(?: |$)/.test(r.command)||/^(?:\S*\/)?node\s+(?:\S*\/)?(?:validate-\S+|capture-upgrade-legacy)\.mjs(?:\s|$)/.test(r.command)));
 if(conflicts.length)console.log(JSON.stringify({validationConflicts:conflicts,self:process.pid}));
 assert.equal(conflicts.length,0,'OTHER_VALIDATION_RUNNING');
}else for(const kind of ['starts','faults','cleanups'])assert(remainingBudget.used[kind]+limits[kind]<=remainingBudget.limits[kind],'ROUND_BUDGET_NOT_RESERVED');
if(preflight){console.log(JSON.stringify({preflightPassed:true,build,preparation:signingFollowup?'signing-followup':'original',freshC,limits,carry,appStarts:0,modelCalls:0,effects:0}));process.exit(0);}
fs.mkdirSync(root,{mode:0o700});
const profile=resume==='coordination-version'?previous.profile:resume==='show-contract'?JSON.parse(fs.readFileSync(path.join(validationRoot,'auth09/show-contract-profile-recovery.json'))).profile:quitFollowup&&!freshC?followup.profile:fs.mkdtempSync(profileRoot+'/recovery05-');
assert(profile.startsWith(profileRoot+'/recovery05-')&&fs.realpathSync(profile)===profile,'INVALID_PROFILE_ROOT');
const report={build,preparation:signingFollowup?'signing-followup':'original',profileState:freshC?'fresh-after-profile-loss':'retained',archive:manifest.hashes['Contents/Resources/app.asar'],certificateSha256:signature.certificateSha256,started:new Date().toISOString(),scope:'packaged local fixtures; no real credential/login, IME, sleep or power-loss acceptance',carry,limits,starts:[],faults:[],effects:[],models:[],tasks:[],checks:[],realModelCalls:0,remoteWrites:0};
if(upgrade09)report.profile=profile;
if(coordinationTail)report.scope='remaining coordination cases in fresh isolated dataset; real safeStorage for one virtual local API key, no original credential/session substitution, no IME or power-loss claim';
const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const snapshots={};const capture=(name,value)=>{snapshots[name]=value;fs.writeFileSync(path.join(root,'snapshots.json'),JSON.stringify(snapshots,null,2)+'\n',{mode:0o600});};
const check=(name,condition)=>{assert(condition,name);report.checks.push(name);save();};
const counts=resume==='coordination-version'||quitFollowup&&!freshC?{...previous.counts}:{A:0,B:0,C:0},heldModels=[];
let holdA=true,holdC=true,current,failed,waitOnA=false,versions;
const deadline=Date.now()+report.limits.minutes*60000;
async function until(fn,ms=60000,cleanup=false){const end=cleanup?Date.now()+ms:Math.min(deadline,Date.now()+ms);while(Date.now()<end){if(failed&&!cleanup)throw Error(failed);if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('RECOVERY_WAIT_EXPIRED');}
function fixtureWork(){if(Date.now()>=deadline){failed??='ROUND_TIME_LIMIT';throw Error('ROUND_TIME_LIMIT');}}
function modelReply(res,value){fixtureWork();nextStepSchema.parse(value);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'fixture05',choices:[{index:0,delta:{content:JSON.stringify(value)},finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id:'fixture05',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');}
async function body(req){let value='';for await(const chunk of req){value+=chunk;assert(value.length<200000,'FIXTURE_REQUEST_TOO_LARGE');}return JSON.parse(value);}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');const page=url.pathname.match(/^\/page\/([ABC])$/),effect=url.pathname.match(/^\/effect\/([ABC])$/);
 if(req.method==='GET'&&page){const name=page[1];res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>05 ${name} 记录</title><style>body{font:20px -apple-system;padding:40px;color:#244135;background:#f4f8f5}button{font:inherit;padding:12px}</style><h1>05 ${name} 记录</h1><p>本次目标 ${name}-05</p><p id="count">${name} 写入 ${counts[name]} 次</p><button onclick="fetch('/effect/${name}',{method:'POST'}).then(r=>r.json()).then(r=>document.querySelector('#count').textContent='${name} 写入 '+r.count+' 次')">写入备注 ${name}</button>${upgrade09?`<label>原生输入核对<textarea aria-label="原生输入核对">${report.nativeInputSaves?.some(s=>s.name===name)?'接管后保留中文':''}</textarea></label>`:''}${coordinationTail?`<button onclick="fetch('/input/${name}',{method:'POST',body:JSON.stringify({text:document.querySelector('textarea').value})}).then(r=>{if(r.ok)document.querySelector('#saved').textContent='原生文字已保存'})">保存输入文字</button><p id="saved"></p>`:''}<p>本机虚构记录，仅核对生命周期和重复操作。</p></html>`);return;}
 if(coordinationTail&&req.method==='POST'&&/^\/input\/[ABC]$/.test(url.pathname)){const name=url.pathname.at(-1),input=await body(req);assert(name==='C'&&input.text==='接管后保留中文'&&!report.nativeInputSaves?.length,'ONE_NAMED_MANUAL_INPUT_SAVE_REQUIRED');report.nativeInputSaves=[{name,at:Date.now(),sha256:createHash('sha256').update(input.text).digest('hex')}];save();res.end('saved');return;}
 if(req.method==='POST'&&effect){fixtureWork();const name=effect[1];counts[name]++;report.effects.push({name,count:counts[name],at:Date.now()});save();assert(report.effects.length<=report.limits.effects,'EFFECT_LIMIT');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:counts[name]}));return;}
 if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
  fixtureWork();report.models.push({at:Date.now()});save();assert(report.models.length+(carry?.models??0)<=report.limits.models,'MODEL_LIMIT');const input=await body(req);fixtureWork();
  const plan=input.messages.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.goal);
  const name=plan?.goal.match(/05 ([ABC])/)?.[1];assert(name,'PLAN_REQUIRED');if(quitFollowup)assert.equal(name,'C','ONLY_REMAINING_TASK_ALLOWED');
  const text=input.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');const count=Number(text.match(new RegExp(name+' 写入 (\\d+) 次'))?.[1]);assert(Number.isSafeInteger(count),'OBSERVATION_REQUIRED');
  Object.assign(report.models.at(-1),{name,count});save();
  const fact=`${name} 写入 ${count} 次`, value={decision:waitOnA&&name==='A'?'wait':count===1?'complete':'act',summary:waitOnA&&name==='A'?'等待用户确认下一步':count===1?'本次备注已核对完成':'写入本次备注',evidence:[fact],previous:plan.previous?{id:plan.previous.id,status:count===1?'confirmed':'unknown',evidence:[fact]}:null,action:waitOnA&&name==='A'||count===1?null:{kind:'click',target:{role:'button',name:'写入备注 '+name,exact:true}}};
  if((name==='A'&&count===1&&holdA)||(name==='C'&&count===0&&holdC))heldModels.push({name,count,res,value});else modelReply(res,value);return;
 }
 res.writeHead(404);res.end();
}catch(error){failed??=error.message;save();res.writeHead(400);res.end('FIXTURE_REJECTED');}});
const reusedOrigin=resume==='coordination-version'?new URL(JSON.parse(fs.readFileSync(path.join(originalRoot,'snapshots.json')))['two-active-before-upgrade'].tasks[0].url).origin:null;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(reusedOrigin?Number(new URL(reusedOrigin).port):quitFollowup?Number(new URL(followup.origin).port):0,'127.0.0.1',resolve);});const origin=`http://127.0.0.1:${server.address().port}`;const commands=commandsFor(origin);if(quitFollowup)assert.equal(origin,followup.origin);
const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function processRows(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));}
function descendants(rootPid){const rows=processRows();const found=new Set([rootPid]);let change=true;while(change){change=false;for(const [pid,parent]of rows)if(found.has(parent)&&!found.has(pid)){found.add(pid);change=true;}}return [...found];}
function snapshotProcesses(app){for(const pid of descendants(app.child.pid))app.pids.add(pid);const rows=processRows().filter(([pid])=>app.pids.has(pid));for(const [,,group]of rows)if(app.pids.has(group))app.groups.add(group);Object.assign(report.starts.find(row=>row.pid===app.child.pid),{pids:[...app.pids],groups:[...app.groups],tree:rows,inheritedGroups:[...new Set(rows.map(row=>row[2]).filter(group=>!app.pids.has(group)))]});save();}
const groupMembers=app=>processRows().filter(([,,group])=>app.groups.has(group));
async function start({holdRecovery=false,duplicate=false}={}){
 assert(Date.now()<deadline,'ROUND_TIME_LIMIT');assert(report.starts.length<report.limits.starts,'START_LIMIT');const used=spend('starts');
 const child=spawn(path.join(manifest.app,'Contents/MacOS/helpr'),['--workspace-validation',...(!coordinationTail?['--workspace-fixture']:[])],{env:{...env,HELPR_VALIDATION_DATA:profile,...(!coordinationTail?{HELPR_FIXTURE_ORIGIN:origin}:{}),...(holdRecovery?{HELPR_VALIDATION_HOLD_RECOVERY:'1'}:{})},stdio:['ignore','ignore',fs.openSync(path.join(root,`stderr-${used.used.starts}.log`),'a',0o600),'ipc']});
 const app={child,pids:new Set([child.pid]),groups:new Set(),messages:[],pending:new Map(),sequence:0,ready:null,exit:null};
 report.starts.push({start:used.used.starts,pid:child.pid,duplicate,at:Date.now()});save();
 child.on('message',m=>{app.messages.push(m);if(m.ready)app.ready=m;const p=app.pending.get(m.id);if(p){clearTimeout(p.timer);app.pending.delete(m.id);m.error?p.reject(Object.assign(Error(m.error),{commandKind:p.commandKind})):p.resolve(m.value);}});
 child.once('exit',(code,signal)=>{app.exit={code,signal};for(const p of app.pending.values()){clearTimeout(p.timer);p.reject(Error('APPLICATION_EXITED'));}app.pending.clear();});
 if(duplicate){await until(()=>{snapshotProcesses(app);return app.exit;});await gone(app);check('competing-start-exits-without-new-owner',app.exit.code===0&&!app.ready);return app;}
 current=app;
 if(upgrade09)await until(async()=>{try{await rpc(app,{kind:'show'});return true;}catch(e){if(e.message!=='RECORDS_UNAVAILABLE')throw e;return false;}},30000);
 await until(()=>app.ready||app.exit);assert(app.ready&&!app.exit,'APPLICATION_NOT_READY');snapshotProcesses(app);return app;
}
async function nativeCheckpoint(app,stage){
 if(!upgrade09)return;
 await rpc(app,{kind:'show'});
 const row=report.starts.find(r=>r.pid===app.child.pid);
 fs.writeFileSync(path.join(root,'ui-context.json'),JSON.stringify({stage,start:row.start,hostPid:app.ready.hostPid,hostApp:path.join(manifest.app,'Contents/Frameworks/helpr Workspace.app')}),{mode:0o600});
 console.log('CUA_CHECKPOINT '+JSON.stringify({stage,start:row.start}));
 await until(()=>{const file=path.join(root,'ui-ready.json');if(!fs.existsSync(file))return false;const receipt=JSON.parse(fs.readFileSync(file));assert.equal(receipt.stage,stage);row.nativeUI=confirmUpgradeUI({...row,ready:app.ready},receipt);fs.unlinkSync(file);save();return true;},120000);
}
function rpc(app,command){if(command.kind!=='quit'&&Date.now()>=deadline)throw Error('ROUND_TIME_LIMIT');if(!['validation-barrier','show'].includes(command.kind))uiCommandSchema.parse(command);assert(app.child.connected,'NO_APPLICATION_CHANNEL');return new Promise((resolve,reject)=>{const id=++app.sequence;const timer=setTimeout(()=>{app.pending.delete(id);reject(Error('RPC_TIMEOUT'));},command.kind==='quit'?45000:Math.min(45000,Math.max(1,deadline-Date.now())));app.pending.set(id,{resolve,reject,timer,commandKind:command.kind});app.child.send({id,command});});}
const snapshot=app=>rpc(app,commands.snapshot());
async function configure(app){await rpc(app,commands.configure(await snapshot(app)));}
async function create(app,name){assert(report.tasks.length<report.limits.tasks,'TASK_LIMIT');report.tasks.push({name,attempt:true});save();const result=await rpc(app,commands.create(name));Object.assign(report.tasks.at(-1),{id:result.taskId});save();await until(async()=>(await snapshot(app)).tasks.find(t=>t.id===result.taskId)?.phase==='manual');return result.taskId;}
const intent=(app,taskId,value)=>rpc(app,commands.intent(taskId,value));
async function barrier(app){await until(async()=>{const s=await rpc(app,{kind:'validation-barrier',control:{action:'status'}});return s.waits.some(w=>w.key==='recovery:*'&&w.reached);});await configure(app);await rpc(app,{kind:'validation-barrier',control:{action:'release',point:'recovery',taskId:'*'}});}
async function gone(app,cleanup=false){await until(()=>app.exit,10000,cleanup);await until(()=>[...app.pids].every(pid=>!alive(pid))&&groupMembers(app).length===0,8000,cleanup);const remaining=groupMembers(app);Object.assign(report.starts.find(row=>row.pid===app.child.pid),{exit:app.exit,remaining});check('owned-tree-cleared-'+app.child.pid,[...app.pids].every(pid=>!alive(pid))&&remaining.length===0);app.cleared=true;}
async function quit(app,cleanup=true){snapshotProcesses(app);await rpc(app,commands.quit()).catch(error=>{if(error.message!=='APPLICATION_EXITED')throw error;});await gone(app,cleanup);assert.equal(app.exit.code,0,'NORMAL_EXIT_REQUIRED');}
function fault(pid,signal,label){assert(report.faults.length<report.limits.faults,'FAULT_LIMIT');spend('faults');report.faults.push({pid,signal,label,at:Date.now()});save();process.kill(pid,signal);}
try{
 if(coordination){
  const backupDirectory=path.join(root,'selected-backups'),readonlyDirectory=path.join(root,'readonly-backups');
  fs.mkdirSync(backupDirectory,{mode:0o700});fs.mkdirSync(readonlyDirectory,{mode:0o500});
  const keyFile=path.join(root,'tls-key.pem'),certFile=path.join(root,'tls-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',timeout:10000});fs.chmodSync(keyFile,0o600);
  versions=https.createServer({key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)},(req,res)=>{assert(req.url==='/stable.json'&&req.method==='GET');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schema:1,version:'0.3.0',platform:'darwin',arch:'arm64',minOS:'14.0.0',dataFormats:[6,7],stateModels:[1],notes:['仅本机准备协调夹具，不代表实际Release。'],downloadURL:'https://github.com/yuexiaoliang/helpr/releases/tag/v0.3.0'}));});
  await new Promise(r=>versions.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(profile,'version-fixture.json'),JSON.stringify({source:`https://127.0.0.1:${versions.address().port}/stable.json`,ca:fs.readFileSync(certFile,'utf8')}),{mode:0o600});
  const first=await start();await configure(first);
  const a=resume==='coordination-version'?previous.tasks.find(t=>t.name==='A').id:await create(first,'A'),b=resume==='coordination-version'?previous.tasks.find(t=>t.name==='B').id:await create(first,'B'),c=resume==='coordination-version'?previous.tasks.find(t=>t.name==='C').id:await create(first,'C');
  if(resume==='coordination-version')report.reusedTasks=previous.tasks;
  await intent(first,b,'stop');await intent(first,a,resume==='coordination-version'?'continue':'start');await intent(first,c,resume==='coordination-version'?'continue':'start');
  await until(()=>counts.A===1&&heldModels.some(m=>m.name==='A'&&!m.res.destroyed)&&heldModels.some(m=>m.name==='C'&&!m.res.destroyed));
  capture('two-active-before-upgrade',await snapshot(first));await nativeCheckpoint(first,'coordination-inflight');
  await rpc(first,{kind:'version-check'});await until(async()=>{const v=await rpc(first,{kind:'version-status'});return v.phase==='done'&&v.result?.kind==='available';},10000);
  const prepare=async(stage)=>{
    const version=await rpc(first,{kind:'version-status'});
    assert.equal(version.phase,'done');assert.equal(version.result.kind,'available');
    let settled;
    const preparing=rpc(first,{kind:'upgrade-prepare',requestId:randomUUID(),versionRevision:version.revision}).then(value=>({value}),error=>({error:error.message}));
    preparing.then(result=>{settled=result;report.prepareResults??=[];report.prepareResults.push({stage,result});save();});
    await until(async()=>{if(settled)throw Error(settled.error??settled.value?.error??'PREPARATION_SETTLED_EARLY');const u=await rpc(first,{kind:'upgrade-status'});report.lastPrepareStatus=u;save();return u.phase==='preparing'&&u.working;},15000);
    return {preparing,stage};
  };
  let p,backupFile,backupBytes;
  if(!coordinationTail){
  p=await prepare('coordination-cancel-picker');
  await intent(first,a,'stop');await rpc(first,{kind:'draft',requestId:randomUUID(),taskId:c,text:'准备期间较新的中文草稿'});
  await nativeCheckpoint(first,p.stage);const cancelled=await p.preparing;check('native-picker-cancel-is-not-ready',cancelled.value?.phase!=='ready'&&cancelled.value?.error==='UPGRADE_PENDING');
  await rpc(first,{kind:'upgrade-cancel'});
  p=await prepare('coordination-ready-picker');await nativeCheckpoint(first,p.stage);const ready=(await p.preparing).value;assert(ready?.phase==='ready'&&ready.backup,'ACTUAL_BACKUP_READY_REQUIRED');
  backupFile=ready.backup.file;backupBytes=fs.readFileSync(backupFile);const archive=JSON.parse(backupBytes);assert.equal(archive.dataVersion,7);assert.equal(archive.payload.tasks.length,3);
  const s=await snapshot(first);check('latest-stop-and-draft-in-ready',s.tasks.find(t=>t.id===a).execution.intent==='stopped'&&s.tasks.find(t=>t.id===c).draft==='准备期间较新的中文草稿');
  assert.equal(archive.payload.tasks.find(t=>t.id===c).draft,'准备期间较新的中文草稿');
  report.upgradeBackup={sha256:createHash('sha256').update(backupBytes).digest('hex'),tasks:3,dataVersion:7};
  await rpc(first,{kind:'draft',requestId:randomUUID(),taskId:c,text:'备份完成后再变化的中文草稿'});
  const stale=await rpc(first,{kind:'upgrade-exit',revision:ready.revision});assert.equal(stale.error,'UPGRADE_CHANGED');check('stale-backup-cannot-exit',!first.exit);await nativeCheckpoint(first,'coordination-stale-backup');await rpc(first,{kind:'upgrade-cancel'});
  }
  p=await prepare('coordination-readonly-picker');await nativeCheckpoint(first,p.stage);const unavailable=(await p.preparing).value;check('readonly-backup-target-is-not-ready',unavailable?.phase!=='ready'&&unavailable?.error==='BACKUP_STORAGE_UNAVAILABLE');
  if(!coordinationTail)assert.deepEqual(fs.readFileSync(backupFile),backupBytes);await rpc(first,{kind:'upgrade-cancel'});holdA=false;waitOnA=true;await intent(first,a,'continue');
  await until(async()=>(await snapshot(first)).tasks.find(t=>t.id===a).execution.phase==='unknown');
  await nativeCheckpoint(first,'coordination-takeover');
  if(coordinationTail){assert.equal(report.nativeInputSaves?.length,1);const u=await rpc(first,{kind:'upgrade-status'}),page=u.pages.find(p=>p.taskId===c);assert(page?.dirty);await rpc(first,{kind:'upgrade-page-saved',taskId:c,epoch:page.epoch,generation:page.generation});}
  const before=await snapshot(first);capture('coordination-before-quit',before);check('stop-takeover-and-wait-before-quit',before.tasks.find(t=>t.id===b).execution.intent==='stopped'&&before.tasks.find(t=>t.id===c).execution.pauseReason==='takeover'&&before.tasks.find(t=>t.id===a).execution.phase==='unknown');
  await quit(first);const second=await start();await nativeCheckpoint(second,'coordination-cold');const after=await snapshot(second);capture('coordination-cold',after);
  check('stop-takeover-and-wait-survive-cold',after.tasks.find(t=>t.id===b).execution.intent==='stopped'&&after.tasks.find(t=>t.id===c).execution.pauseReason==='takeover'&&after.tasks.find(t=>t.id===a).execution.phase==='unknown');check('no-duplicate-or-unapproved-effects',counts.A===1&&counts.B===0&&counts.C===0);await quit(second);
 }else if(quitFollowup){
  console.log('05 follow-up: normal quit with undispatched work');
  const first=await start();const initial=await snapshot(first);let c=followup.taskId;capture('followup-initial',initial);
  if(freshC)check('fresh-profile-has-no-old-tasks',initial.tasks.length===0);
  else check('old-pause-preserved-before-explicit-setup',initial.tasks.find(t=>t.id===c)?.execution?.phase==='paused');
  await configure(first);if(freshC)c=await create(first,'C');await intent(first,c,freshC?'start':'continue');await until(()=>heldModels.some(m=>m.name==='C'&&!m.res.destroyed));
  const pending=await snapshot(first);capture('followup-before-quit',pending);check('no-action-before-normal-quit',counts.C===0&&pending.tasks.find(t=>t.id===c)?.execution?.actions.length===0);
  await quit(first);holdC=false;
  console.log('05 follow-up: cold reopen without continue');
  const second=await start({holdRecovery:true});const reopened=await snapshot(second);capture('followup-cold-before-recovery',reopened);
  const restored=reopened.tasks.find(t=>t.id===c)?.execution;check('normal-quit-preserved-active-intent',restored?.phase==='queued'&&restored.intent==='automatic'&&restored.recoveryPending&&!restored.pauseReason);
  await barrier(second);await until(async()=>(await snapshot(second)).tasks.find(t=>t.id===c)?.execution?.phase==='complete');
  const final=await snapshot(second);capture('followup-final',final);
  if(freshC)check('fresh-C-effect-once',counts.C===1&&counts.A===0&&counts.B===0&&report.effects.length===1&&report.effects[0].name==='C');
  else check('remaining-effect-once-and-stop-retained',counts.A===1&&counts.B===0&&counts.C===1&&final.tasks.find(t=>t.id===previous.tasks.find(t=>t.name==='B').id)?.execution?.intent==='stopped');await quit(second);
 }else{
 console.log('05 first start: interrupted result and owner cleanup');
 const first=await start();await configure(first);const a=await create(first,'A'),b=await create(first,'B');
 await intent(first,b,'stop');await intent(first,a,'start');
 await until(()=>counts.A===1&&heldModels.some(m=>m.name==='A'&&!m.res.destroyed));capture('before-owner-exit',await snapshot(first));snapshotProcesses(first);await nativeCheckpoint(first,'before-interrupt');
 fault(first.ready.recordsPid,'SIGSTOP','records-unresponsive');fault(first.child.pid,'SIGKILL','owner-exits-with-effect-unrecorded');await gone(first);holdA=false;for(const item of heldModels)if(item.name==='A'&&!item.res.destroyed)modelReply(item.res,item.value);
 console.log('05 cold reopen: reconcile existing effect and retain stop');
 const second=await start({holdRecovery:true});await barrier(second);await until(async()=>(await snapshot(second)).tasks.find(t=>t.id===a)?.execution?.phase==='complete');
 const recovered=await snapshot(second);capture('after-cold-recovery',recovered);check('one-effect-after-cold-recovery',counts.A===1&&counts.B===0);check('original-stop-retained',recovered.tasks.find(t=>t.id===b)?.execution?.intent==='stopped');
 await nativeCheckpoint(second,'recovered');
 await start({duplicate:true});
 const c=await create(second,'C');await intent(second,c,'start');await until(()=>heldModels.some(m=>m.name==='C'&&!m.res.destroyed));capture('before-normal-quit',await snapshot(second));
 await rpc(second,{kind:'validation-barrier',control:{action:'arm',point:'exit-checkpoint',taskId:'*'}});
 const exiting=rpc(second,commands.quit()).then(()=>({accepted:true}),error=>({error:error.message}));
 await until(async()=>{const status=await rpc(second,{kind:'validation-barrier',control:{action:'status'}});return status.waits.some(w=>w.key==='exit-checkpoint:*'&&w.reached);});
 const recordsPid=second.ready.recordsPid;fault(recordsPid,'SIGKILL','record-process-exits-during-quit-checkpoint');await until(()=>second.messages.some(m=>m.recordsUnavailable&&m.duringExit));
 await rpc(second,{kind:'validation-barrier',control:{action:'release',point:'exit-checkpoint',taskId:'*'}});const interrupted=await exiting;check('exit-failure-retains-application',Boolean(interrupted.error)&&!second.exit);
 await until(()=>second.messages.some(m=>m.recordsRestored));snapshotProcesses(second);capture('after-record-reconnect',await snapshot(second));check('new-record-process',second.messages.some(m=>m.recordsRestored&&m.recordsPid!==recordsPid));await quit(second);holdC=false;
 console.log('05 final reopen: resume only undispatched remainder');
 const fourth=await start({holdRecovery:true});await barrier(fourth);await until(async()=>(await snapshot(fourth)).tasks.find(t=>t.id===c)?.execution?.phase==='complete');capture('final',await snapshot(fourth));check('only-remaining-work-written-once',counts.A===1&&counts.B===0&&counts.C===1);await nativeCheckpoint(fourth,'final');await quit(fourth);
 }
 fixtureWork();report.passed=true;
}catch(error){report.passed=false;report.error=error.message;report.failedCommand=error.commandKind;process.exitCode=1;}
finally{
 if(current&&!current.cleared){try{if(current.exit)await gone(current,true);else await quit(current,true);}catch(error){report.quitFailure=error.message;}}
 if(current){const left=[...current.pids].filter(alive);if(left.length){spend('cleanups');report.cleanup={pids:left};for(const pid of left.reverse())if(alive(pid))process.kill(pid,'SIGKILL');const cleanupDeadline=Date.now()+5000;while(left.some(alive)&&Date.now()<cleanupDeadline)await new Promise(r=>setTimeout(r,40));report.cleanup.remaining=left.filter(alive);}}
 for(const item of heldModels)if(!item.res.destroyed)item.res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));
 if(versions){versions.closeAllConnections();await new Promise(r=>versions.close(r));}
 if(coordination)fs.chmodSync(path.join(root,'readonly-backups'),0o700);
 report.finished=new Date().toISOString();report.counts=counts;report.cumulative={models:(carry?.models??0)+report.models.length,effects:(carry?.effects??0)+report.effects.length,tasks:(carry?.tasks??0)+report.tasks.length,faults:(carry?.faults??0)+report.faults.length};report.global=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json'))).used;save();
 console.log(JSON.stringify({passed:report.passed,error:report.error,build,starts:report.starts.map(s=>s.start),models:report.models.length,effects:report.effects.length,checks:report.checks,cleanup:report.cleanup}));
}
