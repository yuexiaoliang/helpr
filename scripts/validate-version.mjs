import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:https';
import { createServer as createHTTPServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { spend, validationRoot } from './workspace-budget.mjs';
import { verifyDevelopmentSignature } from './development-signing.mjs';

// 唯一受管入口；准备虚构任务或复用获准的原任务，切换独立服务并读取公开状态。
// 检查、提醒、设置及下载入口的产品交互由CUA完成。
const args=process.argv.slice(2);
const resume=args.length===2&&args[1]==='--resume';
const execution=args.length===2&&args[1]==='--execution-followup';
const checkOnly=args.length===1&&args[0]==='--check-execution';
const contractFile=path.join(validationRoot,'version-contracts.mjs');
fs.mkdirSync(validationRoot,{recursive:true,mode:0o700});
createRequire(import.meta.resolve('vite'))('esbuild').buildSync({stdin:{contents:"export {uiCommandSchema} from './app/shared/contracts';export {nextStepSchema} from './app/shared/execution';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:contractFile});
const {uiCommandSchema,nextStepSchema}=await import(pathToFileURL(contractFile).href);
const configure=(origin,state)=>({kind:'model-save',requestId:randomUUID(),expectedVersion:state.modelSettings?.version??0,protocol:'chat-completions',endpoint:origin+'/v1',model:'local-fixture-08',apiKey:'local-fixture-not-a-secret'});
const startTask=taskId=>({kind:'execution-intent',requestId:randomUUID(),taskId,intent:'start'});
const reply=name=>nextStepSchema.parse({decision:'complete',summary:'已只读核对'+name+'任务网页，保留原任务及草稿。',evidence:[name+'任务网页存在，未执行网页写入。'],previous:null,action:null});
uiCommandSchema.parse(configure('http://127.0.0.1:58902',{}));uiCommandSchema.parse(startTask('fixture-task'));reply('A');reply('B');
if(checkOnly){console.log(JSON.stringify({valid:true,appStarts:0,models:0,effects:0,requiredCases:['available','available-dismissed','offline','timeout']}));process.exit(0);}
assert(args[0]==='--candidate=version-08'&&(args.length===1||resume||execution),'FIXED_CANDIDATE_REQUIRED');
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'inherit',timeout:65000});
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,'build-36.json'),'utf8'));
assert.equal(manifest.build,36);assert.equal(manifest.prepared,true);
const appPath=path.resolve('dist/candidates/version-08/mac-arm64/helpr.app');
for(const [file,sha] of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(appPath,file))).digest('hex'),sha,file);
const prior=resume||execution?JSON.parse(fs.readFileSync(path.join(validationRoot,'version-08-batch.json'),'utf8')):null;
if(resume){assert(prior.start===93&&prior.requests===0&&prior.tasks===0&&prior.error==='STEP_TIMEOUT','EXACT_FIRST_FAILURE_REQUIRED');assert(prior.root.startsWith(validationRoot+'/version-08-'));const original=JSON.parse(fs.readFileSync(path.join(prior.root,'result.json'),'utf8'));assert(original.remaining.length===0&&original.exit.code===0);assert(Date.now()-prior.started<20*60*1000,'ORIGINAL_DEADLINE');fs.writeFileSync(path.join(prior.root,'resume-started'),'94\n',{flag:'wx',mode:0o600});}
if(execution){verifyDevelopmentSignature(appPath);assert(prior.start===94&&prior.passed&&prior.requests===10&&prior.tasks===2,'EXACT_94_SOURCE_REQUIRED');assert(prior.root===path.join(validationRoot,'version-08-1792741954239'),'FIXED_PRIOR_ROOT');const old=JSON.parse(fs.readFileSync(path.join(prior.root,'result-94.json')));assert(old.passed&&old.exit.code===0&&old.remaining.length===0);const b=JSON.parse(fs.readFileSync(path.join(validationRoot,'budget.json')));assert(b.used.starts===94&&b.limits.starts===95&&b.version08Execution?.approved===true,'EXPLICIT_95_APPROVAL_REQUIRED');}
const root=execution?path.join(prior.root,'execution-95'):resume?prior.root:path.join(validationRoot,'version-08-'+Date.now());
if(execution)fs.mkdirSync(root,{mode:0o700});else fs.mkdirSync(root,{recursive:true,mode:0o700});
const profileBase=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;fs.mkdirSync(profileBase,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(profileBase),profileBase);
const batchFile=path.join(validationRoot,'version-08-batch.json');
// 同一事项的批次身份持久保留；不允许换目录或重启此入口清零。
if(!resume&&!execution)fs.writeFileSync(batchFile,JSON.stringify({root,phase:'preparing',started:Date.now()})+'\n',{flag:'wx',mode:0o600});
const profile=resume||execution?prior.profile:fs.mkdtempSync(path.join(profileBase,'version-08-'));assert.equal(fs.realpathSync(profile),profile);assert(profile.startsWith(profileBase+'/version-08-'));
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const report={started:resume?prior.started:Date.now(),resumedFrom:execution?94:resume?93:null,models:[],webWrites:0,webGets:[],released:false,build:36,appPath,profile,requests:[],captures:[],opened:[],tasks:[],processes:[],groups:[],passed:false};
write('private-context.json',{profile});
const tlsRoot=execution?prior.root:root;
const key=path.join(tlsRoot,'key.pem'),certFile=path.join(tlsRoot,'cert.pem');
if(!resume&&!execution)execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',timeout:10000});
fs.chmodSync(key,0o600);
const base={schema:1,version:'0.2.0',platform:'darwin',arch:'arm64',minOS:'14.0.0',dataFormats:[6],stateModels:[1],notes:['08隔离验证的虚构新版，不代表实际Release。'],downloadURL:'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0'};
const cases={latest:{version:'0.1.0',downloadURL:null},available:{},offline:{},source:{},format:{},architecture:{arch:'x64'},system:{minOS:'99.0.0'},data:{dataFormats:[7]},link:{downloadURL:'https://example.invalid/denied'},timeout:{}};
let mode='latest',failed=null,child,exit=null,ready=null,baseline=null,seq=0,finished=false;
const pending=new Map(),pids=new Set(),groups=new Set(),held=new Map();
const original=execution?JSON.parse(fs.readFileSync(path.join(prior.root,'baseline.json'))):null;
const keep=s=>({active:s.active,tasks:s.tasks.map(t=>[t.id,t.goal,t.url,t.draft,t.hidden,t.minimized])});
const retained=original?{active:original.active,tasks:original.tasks.map(t=>[...t.slice(0,4),t[5],t[6]])}:null;
let flight=null,expectedRequests=0;
function sameFlight(state){assert.deepEqual(keep(state),retained,'ORIGINAL_TASK_OR_DRAFT_CHANGED');assert.equal(state.tasks.length,2);for(const t of state.tasks){assert(t.execution?.intent==='automatic'&&['checking','running'].includes(t.execution.phase),'TWO_EXECUTIONS_MUST_BE_IN_FLIGHT');assert(!t.executionControl?.blocked&&!t.execution.pauseReason,'EXECUTION_BLOCKED');assert.equal(t.execution.runId,flight[t.id],'EXECUTION_RUN_CHANGED');assert.equal(t.execution.actions.length,0,'UNEXPECTED_WEB_ACTION');}assert.equal(held.size,2,'TWO_INDEPENDENT_REQUESTS_REQUIRED');assert([...held.values()].every(h=>!h.res.destroyed&&!h.res.writableEnded),'MODEL_CONNECTION_ENDED');}
function releaseHeld(){for(const [name,h] of held){assert(!h.res.destroyed&&!h.res.writableEnded,'MODEL_CONNECTION_ENDED');h.res.writeHead(200,{'Content-Type':'text/event-stream'});h.res.write('data: '+JSON.stringify({id:'fixture08-'+name,choices:[{index:0,delta:{content:JSON.stringify(reply(name))},finish_reason:null}]})+'\n\n');h.res.end('data: '+JSON.stringify({id:'fixture08-'+name,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');h.row.releasedAt=Date.now();}report.released=true;}
const facts=s=>({active:s.active,tasks:s.tasks.map(t=>[t.id,t.goal,t.url,t.draft,t.messages,t.hidden,t.minimized,t.execution?.intent??null,t.execution?.actions??null])});
const save=()=>{write(resume?'result-94.json':'result.json',report);if(execution){const file=path.join(validationRoot,'budget.json'),b=JSON.parse(fs.readFileSync(file));b.version08Execution.used={starts:report.start?1:0,localModels:report.models.length,versionRequests:report.requests.length};b.version08Execution.run={root,started:report.started,ended:report.ended??null,passed:report.passed,error:report.error??null};fs.writeFileSync(file,JSON.stringify(b,null,2)+'\n',{mode:0o600});return;}fs.writeFileSync(batchFile,JSON.stringify({root,profile,started:report.started,ended:report.ended??null,start:report.start??null,requests:report.requests.length,tasks:report.tasks.length,passed:report.passed,error:report.error??null})+'\n',{mode:0o600});};
const website=createHTTPServer(async(req,res)=>{try{
 if(execution&&req.method==='POST'&&req.url==='/v1/chat/completions'){
  limited();assert(report.models.length<4,'LOCAL_MODEL_LIMIT');const row={at:Date.now(),closed:false};report.models.push(row);save();
  let raw='';for await(const chunk of req){raw+=chunk;assert(Buffer.byteLength(raw)<200000,'MODEL_BODY_LIMIT');}
  const value=JSON.parse(raw),observed=value.messages.findLast(m=>typeof m.content==='string'&&m.content.startsWith('当前任务：'));
  const name=observed?.content.match(/\nhttp:\/\/127\.0\.0\.1:58902\/([AB])\n/)?.[1];assert(name&&!held.has(name),'ORIGINAL_PAGE_OBSERVATION_REQUIRED');
  row.name=name;row.bytes=Buffer.byteLength(raw);res.once('close',()=>{row.closed=true;row.closedAt=Date.now();if(!report.released)failed??='MODEL_CANCELLED_DURING_VERSION';save();});held.set(name,{res,row});save();return;
 }
 if(req.method!=='GET'){report.webWrites++;throw Error('UNEXPECTED_WEB_WRITE');}
 report.webGets.push({at:Date.now(),url:req.url});save();assert(['/A','/B','/favicon.ico'].includes(req.url),'UNEXPECTED_PAGE_PATH');
 res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>08版本检查隔离网页</title><h1>任务网页保持</h1><p>这里不提供写入操作，也不调用模型。</p></html>');
 }catch(error){failed??=error.message;save();if(!res.headersSent)res.writeHead(400);res.end('FIXTURE_REJECTED');}});
const versions=createServer({key:fs.readFileSync(key),cert:fs.readFileSync(certFile)},(req,res)=>{
 report.requests.push({at:Date.now(),mode,method:req.method,url:req.url,headers:req.headers});save();
 if(report.requests.length>(execution?8:32)){failed='VERSION_REQUEST_LIMIT';res.destroy();return;}
 if(req.method!=='GET'||req.url!=='/stable.json'){failed='UNEXPECTED_VERSION_PATH';res.statusCode=404;res.end();return;}
 if(req.headers.authorization||req.headers.cookie||req.headers.referer){failed='VERSION_PRIVACY';res.destroy();return;}
 if(mode==='timeout')return;
 res.statusCode=mode==='offline'?503:mode==='source'?302:200;
 res.setHeader('content-type','application/json');res.setHeader('location','/must-not-follow');
 res.end(mode==='format'?'{broken':JSON.stringify({...base,...cases[mode]}));
});
const listen=(s,port=0)=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'127.0.0.1',resolve);});
const ps=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],parent:+m[2],group:+m[3],command:m[4]}:null;}).filter(Boolean);
function owned(){const rows=ps();let more=true;while(more){more=false;for(const row of rows)if(pids.has(row.parent)&&!pids.has(row.pid)){pids.add(row.pid);more=true;}}for(const row of rows)if(pids.has(row.pid)&&row.pid===row.group)groups.add(row.group);report.processes=rows.filter(r=>pids.has(r.pid)||groups.has(r.group));report.pids=[...pids];report.groups=[...groups];return report.processes;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function limited(){if(failed)throw Error(failed);if(Date.now()-report.started>(execution?12:20)*60*1000)throw Error('ROUND_TIME_LIMIT');}
async function until(fn,milliseconds=10000,cleanup=false){const end=cleanup?Date.now()+milliseconds:Math.min(report.started+(execution?12:20)*60*1000,Date.now()+milliseconds);while(Date.now()<end){if(!cleanup)limited();if(await fn())return;await delay(100);}throw Error('STEP_TIMEOUT');}
function rpc(command,maximum=10000){if(command.kind!=='quit')limited();return new Promise((resolve,reject)=>{if(!child?.connected){reject(Error('APPLICATION_DISCONNECTED'));return;}const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC_TIMEOUT'));},Math.min(command.kind==='quit'?20000:10000,maximum));pending.set(id,{resolve,reject,timer});child.send({id,command});});}
async function quit(){if(!exit)await rpc({kind:'quit'}).catch(error=>{if(!['APPLICATION_EXITED','APPLICATION_EXITING','APPLICATION_DISCONNECTED'].includes(error.message))throw error;});await until(()=>exit,20000,true);await until(()=>owned().length===0,8000,true);assert.equal(exit.code,0);}
const deadline=setTimeout(()=>{failed='ROUND_TIME_LIMIT';},Math.max(1,report.started+(execution?12:20)*60*1000-Date.now()));
process.on('SIGINT',()=>{failed='INTERRUPTED';});process.on('SIGTERM',()=>{failed='INTERRUPTED';});
try{
 if(execution){const rows=ps();assert(!rows.some(row=>row.pid!==process.pid&&(/^(?:\S*\/)?node scripts\/validate-/.test(row.command)||/^\/.*\/helpr(?: Workspace)?\.app\/Contents\/MacOS\//.test(row.command))),'OTHER_VALIDATION_RUNNING');const old=JSON.parse(fs.readFileSync(path.join(prior.root,'result-94.json')));assert(!rows.some(row=>old.pids.includes(row.pid)||old.groups.includes(row.group)),'PREVIOUS_NOT_CLEARED');}
 await listen(website,execution?58902:0);await listen(versions);
 const origin=`http://127.0.0.1:${website.address().port}`;
 fs.writeFileSync(path.join(profile,'version-fixture.json'),JSON.stringify({source:`https://127.0.0.1:${versions.address().port}/stable.json`,ca:fs.readFileSync(certFile,'utf8')}),{mode:0o600});
 const budget=spend('starts');report.start=budget.used.starts;assert.equal(report.start,execution?95:resume?94:93);save();
 const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 child=spawn(path.join(appPath,'Contents/MacOS/helpr'),['--workspace-validation','--workspace-fixture'],{env:{...env,HELPR_VALIDATION_DATA:profile,HELPR_FIXTURE_ORIGIN:origin},stdio:['ignore','ignore',fs.openSync(path.join(root,'stderr.log'),'a',0o600),'ipc']});pids.add(child.pid);
 child.on('message',message=>{
  if(message.ready)ready=message;if(message.startupFailure)failed='STARTUP_'+message.startupFailure.code;
  for(const key of ['hostPid','launcherPid'])if(Number.isSafeInteger(message[key]))pids.add(message[key]);
  if(message.versionExternalOpen)report.opened.push(message.versionExternalOpen);
  const entry=pending.get(message.id);if(entry){clearTimeout(entry.timer);pending.delete(message.id);message.error?entry.reject(Error(message.error)):entry.resolve(message.value);}
 });
 child.on('error',error=>{failed='SPAWN_'+error.code;});
 child.on('exit',(code,signal)=>{exit={code,signal};report.exit=exit;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('APPLICATION_EXITED'));}pending.clear();});
 const readyDeadline=Date.now()+15000;
 const readyTime=()=>{const left=readyDeadline-Date.now();assert(left>0,'READY_DEADLINE');return left;};
 if(resume||execution){await delay(1500);write('pre-show.json',await rpc({kind:'inspect'},readyTime()));await rpc({kind:'show'},readyTime());}
 await until(()=>{owned();return ready||exit;},readyTime());assert(ready&&!exit,'APPLICATION_NOT_READY');
 await until(async()=>(await rpc({kind:'version-status'})).phase==='done');
 assert.equal((await rpc({kind:'version-status'})).result.kind,'latest');
 write('ready.json',ready);save();console.log('VERSION_READY '+JSON.stringify({root,start:report.start,hostApp:path.join(appPath,'Contents/Frameworks/helpr Workspace.app')}));
 while(!finished){limited();owned();if(exit)throw Error('APPLICATION_EXITED_EARLY');const commandFile=path.join(root,'command.json');
  if(fs.existsSync(commandFile)){const command=JSON.parse(fs.readFileSync(commandFile));fs.unlinkSync(commandFile);let value;
   try{
    if(execution&&command.op==='setup'){
     assert(!baseline,'SETUP_ONCE');const state=await rpc({kind:'snapshot'});assert.deepEqual(keep(state),retained,'EXACT_ORIGINAL_TASKS_REQUIRED');assert(state.tasks.every(t=>t.execution===null),'PREVIOUSLY_UNEXECUTED_TASKS_REQUIRED');report.tasks=state.tasks.map(t=>t.id);await rpc(configure(origin,state));baseline=keep(await rpc({kind:'snapshot'}));write('retained.json',baseline);value=baseline;
    }else if(execution&&command.op==='start'){
     assert(baseline&&!flight,'SETUP_AND_SINGLE_START_REQUIRED');for(const id of report.tasks)await rpc(startTask(id));await until(async()=>held.size===2&&(await rpc({kind:'snapshot'})).tasks.every(t=>['checking','running'].includes(t.execution?.phase)),10000);const state=await rpc({kind:'snapshot'});flight=Object.fromEntries(state.tasks.map(t=>[t.id,t.execution.runId]));sameFlight(state);write('in-flight.json',{state,models:report.models});value={flight,models:report.models,releaseBefore:Math.min(...report.models.map(m=>m.at))+50000};
    }else if(execution&&command.op==='release'){
     assert(['available','available-dismissed','offline','timeout'].every(c=>report.captures.includes(c)),'ALL_IN_FLIGHT_CASES_REQUIRED');sameFlight(await rpc({kind:'snapshot'}));assert(Date.now()-Math.min(...report.models.map(m=>m.at))<50000,'MODEL_DEADLINE_RESERVE');releaseHeld();await until(async()=>(await rpc({kind:'snapshot'})).tasks.every(t=>t.execution?.phase==='complete'));const state=await rpc({kind:'snapshot'});assert.deepEqual(keep(state),retained);assert(state.tasks.every(t=>t.execution.intent==='automatic'&&t.execution.actions.length===0&&!t.executionControl?.blocked));assert.equal(report.models.length,2);write('complete.json',{state,models:report.models});value={complete:true,models:report.models.length};
    }else if(command.op==='setup'){
     assert(!baseline,'SETUP_ONCE');await rpc({kind:'resize',width:800,height:600});for(const name of ['A','B']){const created=await rpc({kind:'create',requestId:'version-08-'+name,goal:'08 '+name+' · 保留任务与草稿'});report.tasks.push(created.taskId);await rpc({kind:'navigate',taskId:created.taskId,requestId:'version-nav-'+name,url:origin+'/'+name});await until(async()=>(await rpc({kind:'snapshot'})).tasks.find(t=>t.id===created.taskId)?.phase==='manual');await rpc({kind:'draft',taskId:created.taskId,requestId:'version-draft-'+name,text:name+' 的未发送文字'});}await rpc({kind:'select',requestId:'version-select-a',taskId:report.tasks[0]});baseline=facts(await rpc({kind:'snapshot'}));write('baseline.json',baseline);value=baseline;
    }else if(command.op==='case'){
     assert(Object.hasOwn(cases,command.name)&&(!execution||['available','offline','timeout'].includes(command.name)),'UNKNOWN_CASE');mode=command.name;expectedRequests=report.requests.length+1;value={mode};
    }else if(command.op==='capture'){
     assert(baseline,'SETUP_REQUIRED');if(execution)await until(async()=>report.requests.length>=expectedRequests&&(await rpc({kind:'version-status'})).phase==='done',9500);const state=await rpc({kind:'snapshot'}),status=await rpc({kind:'version-status'}),inspection=await rpc({kind:'inspect'});assert.equal(inspection.nativeInputAvailable,true,'NATIVE_INPUT_MUST_REMAIN_AVAILABLE');assert.equal(status.phase,'done');assert.equal(status.result.kind,mode);if(execution){sameFlight(state);if(command.dismissed)assert.equal(status.noticeVisible,false,'NOTICE_NOT_DISMISSED');}else assert.deepEqual(facts(state),baseline,'TASK_OR_DRAFT_CHANGED');assert(report.requests.every(r=>r.url==='/stable.json'&&r.method==='GET'));const data={mode,status,state,inspection,requests:report.requests.length};const label=mode+(command.dismissed?'-dismissed':'');write('capture-'+label+'.json',data);report.captures.push(label);value={mode,status,requests:report.requests.length};
    }else if(command.op==='finish'){
     if(execution){assert(report.released&&['available','available-dismissed','offline','timeout'].every(name=>report.captures.includes(name)),'EXECUTION_CASES_REQUIRED');assert.deepEqual(report.opened,[],'NO_EXTERNAL_OPEN');assert.equal(report.webWrites,0);}else{assert(['latest','available','offline','source','format','architecture','system','data','link','timeout'].every(name=>report.captures.includes(name)),'ALL_CASES_REQUIRED');assert.deepEqual(report.opened,[base.downloadURL],'ONE_USER_OPEN_REQUIRED');}await quit();finished=true;value={finished:true};
    }else throw Error(command.op==='abort'?'CUA_ABORTED':'UNKNOWN_COMMAND');
    write('command-result.json',{nonce:command.nonce,ok:true,value});save();
   }catch(error){write('command-result.json',{nonce:command.nonce,ok:false,error:error.message});throw error;}
  }
  await delay(250);
 }
 report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.stack);}
finally{
 clearTimeout(deadline);
 if(child&&owned().length){try{await quit();}catch(error){report.cleanupError=error.message;}}
 if(child&&owned().length){spend('cleanups');for(const group of groups)try{process.kill(-group,'SIGTERM');}catch{}for(const pid of pids)if(owned().some(row=>row.pid===pid))try{process.kill(pid,'SIGTERM');}catch{}try{await until(()=>owned().length===0,5000,true);}catch{for(const group of groups)try{process.kill(-group,'SIGKILL');}catch{}for(const row of owned())if(pids.has(row.pid))try{process.kill(row.pid,'SIGKILL');}catch{}await delay(500);}}
 report.remaining=child?owned():[];if(report.remaining.length){report.passed=false;report.error??='OWNED_PROCESSES_REMAIN';process.exitCode=1;if(child.connected)child.disconnect();}
 website.closeAllConnections();versions.closeAllConnections();await Promise.all([new Promise(resolve=>website.close(resolve)),new Promise(resolve=>versions.close(resolve))]);
 report.ended=Date.now();save();console.log('VERSION_RESULT '+JSON.stringify({root,passed:report.passed,error:report.error,remaining:report.remaining}));
}
