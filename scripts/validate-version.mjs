import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:https';
import { createServer as createHTTPServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spend, validationRoot } from './workspace-budget.mjs';

// 唯一受管入口；只准备虚构任务、切换独立版本服务的案例并读取公开状态。
// 检查、提醒、设置及下载入口的产品交互由CUA完成。
const args=process.argv.slice(2);
assert(args.length===1&&args[0]==='--candidate=version-08','FIXED_CANDIDATE_REQUIRED');
execFileSync(process.execPath,['scripts/validate-workspace.mjs','--preflight'],{stdio:'inherit',timeout:65000});
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,'build-36.json'),'utf8'));
assert.equal(manifest.build,36);assert.equal(manifest.prepared,true);
const appPath=path.resolve('dist/candidates/version-08/mac-arm64/helpr.app');
for(const [file,sha] of Object.entries(manifest.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(appPath,file))).digest('hex'),sha,file);
const root=path.join(validationRoot,'version-08-'+Date.now());fs.mkdirSync(root,{recursive:true,mode:0o700});
const profileBase=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;fs.mkdirSync(profileBase,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(profileBase),profileBase);
const profile=fs.mkdtempSync(path.join(profileBase,'version-08-'));
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const report={started:Date.now(),build:36,appPath,profile,requests:[],captures:[],opened:[],tasks:[],processes:[],groups:[],passed:false};
write('private-context.json',{profile});
const key=path.join(root,'key.pem'),certFile=path.join(root,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',timeout:10000});
fs.chmodSync(key,0o600);
const base={schema:1,version:'0.2.0',platform:'darwin',arch:'arm64',minOS:'14.0.0',dataFormats:[6],stateModels:[1],notes:['08隔离验证的虚构新版，不代表实际Release。'],downloadURL:'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0'};
const cases={latest:{version:'0.1.0',downloadURL:null},available:{},offline:{},source:{},format:{},architecture:{arch:'x64'},system:{minOS:'99.0.0'},data:{dataFormats:[7]},link:{downloadURL:'https://example.invalid/denied'},timeout:{}};
let mode='latest',failed=null,child,exit=null,ready=null,baseline=null,seq=0,finished=false;
const pending=new Map(),pids=new Set(),groups=new Set();
const facts=s=>({active:s.active,tasks:s.tasks.map(t=>[t.id,t.goal,t.url,t.draft,t.messages,t.hidden,t.minimized,t.execution?.intent??null,t.execution?.actions??null])});
const save=()=>write('result.json',report);
const website=createHTTPServer((req,res)=>{if(req.method!=='GET'){failed='UNEXPECTED_WEB_WRITE';res.statusCode=405;}res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><title>08版本检查隔离网页</title><h1>任务网页保持</h1><p>这里不提供写入操作，也不调用模型。</p></html>');});
const versions=createServer({key:fs.readFileSync(key),cert:fs.readFileSync(certFile)},(req,res)=>{
 report.requests.push({at:Date.now(),mode,method:req.method,url:req.url,headers:req.headers});save();
 if(report.requests.length>32){failed='VERSION_REQUEST_LIMIT';res.destroy();return;}
 if(req.method!=='GET'||req.url!=='/stable.json'){failed='UNEXPECTED_VERSION_PATH';res.statusCode=404;res.end();return;}
 if(req.headers.authorization||req.headers.cookie||req.headers.referer){failed='VERSION_PRIVACY';res.destroy();return;}
 if(mode==='timeout')return;
 res.statusCode=mode==='offline'?503:mode==='source'?302:200;
 res.setHeader('content-type','application/json');res.setHeader('location','/must-not-follow');
 res.end(mode==='format'?'{broken':JSON.stringify({...base,...cases[mode]}));
});
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const ps=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],parent:+m[2],group:+m[3],command:m[4]}:null;}).filter(Boolean);
function owned(){const rows=ps();let more=true;while(more){more=false;for(const row of rows)if(pids.has(row.parent)&&!pids.has(row.pid)){pids.add(row.pid);more=true;}}for(const row of rows)if(pids.has(row.pid)&&row.pid===row.group)groups.add(row.group);report.processes=rows.filter(r=>pids.has(r.pid)||groups.has(r.group));report.pids=[...pids];report.groups=[...groups];return report.processes;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function limited(){if(failed)throw Error(failed);if(Date.now()-report.started>20*60*1000)throw Error('ROUND_TIME_LIMIT');}
async function until(fn,milliseconds=10000,cleanup=false){const end=Date.now()+milliseconds;while(Date.now()<end){if(!cleanup)limited();if(await fn())return;await delay(100);}throw Error('STEP_TIMEOUT');}
function rpc(command){return new Promise((resolve,reject)=>{if(!child?.connected){reject(Error('APPLICATION_DISCONNECTED'));return;}const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC_TIMEOUT'));},command.kind==='quit'?20000:10000);pending.set(id,{resolve,reject,timer});child.send({id,command});});}
async function quit(){if(!exit)await rpc({kind:'quit'}).catch(error=>{if(!['APPLICATION_EXITED','APPLICATION_EXITING','APPLICATION_DISCONNECTED'].includes(error.message))throw error;});await until(()=>exit,20000,true);await until(()=>owned().length===0,8000,true);assert.equal(exit.code,0);}
const deadline=setTimeout(()=>{failed='ROUND_TIME_LIMIT';},20*60*1000);
process.on('SIGINT',()=>{failed='INTERRUPTED';});process.on('SIGTERM',()=>{failed='INTERRUPTED';});
try{
 await listen(website);await listen(versions);
 const origin=`http://127.0.0.1:${website.address().port}`;
 fs.writeFileSync(path.join(profile,'version-fixture.json'),JSON.stringify({source:`https://127.0.0.1:${versions.address().port}/stable.json`,ca:fs.readFileSync(certFile,'utf8')}),{mode:0o600});
 const budget=spend('starts');report.start=budget.used.starts;assert(report.start<=94);
 const env=Object.fromEntries(['HOME','PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 child=spawn(path.join(appPath,'Contents/MacOS/helpr'),['--workspace-validation','--workspace-fixture'],{env:{...env,HELPR_VALIDATION_DATA:profile,HELPR_FIXTURE_ORIGIN:origin},stdio:['ignore','ignore',fs.openSync(path.join(root,'stderr.log'),'a',0o600),'ipc']});pids.add(child.pid);
 child.on('message',message=>{
  if(message.ready)ready=message;if(message.startupFailure)failed='STARTUP_'+message.startupFailure.code;
  for(const key of ['hostPid','launcherPid'])if(Number.isSafeInteger(message[key]))pids.add(message[key]);
  if(message.versionExternalOpen)report.opened.push(message.versionExternalOpen);
  const entry=pending.get(message.id);if(entry){clearTimeout(entry.timer);pending.delete(message.id);message.error?entry.reject(Error(message.error)):entry.resolve(message.value);}
 });
 child.on('exit',(code,signal)=>{exit={code,signal};report.exit=exit;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('APPLICATION_EXITED'));}pending.clear();});
 await until(()=>{owned();return ready||exit;},15000);assert(ready&&!exit,'APPLICATION_NOT_READY');
 await until(async()=>(await rpc({kind:'version-status'})).phase==='done');
 assert.equal((await rpc({kind:'version-status'})).result.kind,'latest');
 write('ready.json',ready);save();console.log('VERSION_READY '+JSON.stringify({root,start:report.start,hostApp:path.join(appPath,'Contents/Frameworks/helpr Workspace.app')}));
 while(!finished){limited();owned();if(exit)throw Error('APPLICATION_EXITED_EARLY');const commandFile=path.join(root,'command.json');
  if(fs.existsSync(commandFile)){const command=JSON.parse(fs.readFileSync(commandFile));fs.unlinkSync(commandFile);let value;
   try{
    if(command.op==='setup'){
     assert(!baseline,'SETUP_ONCE');for(const name of ['A','B']){const created=await rpc({kind:'create',requestId:'version-08-'+name,goal:'08 '+name+' · 保留任务与草稿'});report.tasks.push(created.taskId);await rpc({kind:'navigate',taskId:created.taskId,requestId:'version-nav-'+name,url:origin+'/'+name});await until(async()=>(await rpc({kind:'snapshot'})).tasks.find(t=>t.id===created.taskId)?.phase==='manual');await rpc({kind:'draft',taskId:created.taskId,requestId:'version-draft-'+name,text:name+' 的未发送文字'});}await rpc({kind:'select',requestId:'version-select-a',taskId:report.tasks[0]});baseline=facts(await rpc({kind:'snapshot'}));write('baseline.json',baseline);value=baseline;
    }else if(command.op==='case'){
     assert(Object.hasOwn(cases,command.name),'UNKNOWN_CASE');mode=command.name;value={mode};
    }else if(command.op==='capture'){
     assert(baseline,'SETUP_REQUIRED');const state=await rpc({kind:'snapshot'}),status=await rpc({kind:'version-status'});assert.equal(status.phase,'done');assert.equal(status.result.kind,mode);assert.deepEqual(facts(state),baseline,'TASK_OR_DRAFT_CHANGED');assert(report.requests.every(r=>r.url==='/stable.json'&&r.method==='GET'));const data={mode,status,state,requests:report.requests.length};write('capture-'+mode+'.json',data);report.captures.push(mode);value={mode,status,requests:report.requests.length};
    }else if(command.op==='finish'){
     assert(['latest','available','offline','source','format','architecture','system','data','link','timeout'].every(name=>report.captures.includes(name)),'ALL_CASES_REQUIRED');await quit();finished=true;value={finished:true};
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
 if(child&&owned().length){spend('cleanups');for(const group of groups)try{process.kill(-group,'SIGTERM');}catch{}for(const pid of pids)if(owned().some(row=>row.pid===pid))try{process.kill(pid,'SIGTERM');}catch{}try{await until(()=>owned().length===0,5000,true);}catch{for(const group of groups)try{process.kill(-group,'SIGKILL');}catch{}await delay(500);}}
 report.remaining=child?owned():[];if(report.remaining.length)report.passed=false;
 website.closeAllConnections();versions.closeAllConnections();await Promise.all([new Promise(resolve=>website.close(resolve)),new Promise(resolve=>versions.close(resolve))]);
 report.ended=Date.now();save();console.log('VERSION_RESULT '+JSON.stringify({root,passed:report.passed,error:report.error,remaining:report.remaining}));
}
