import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fork,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(here,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const previous=fs.readdirSync(artifacts).filter(n=>/^run-\d+$/.test(n));assert(previous.length<8,'RUN_BUDGET');
const out=path.join(artifacts,`run-${previous.length+1}`);fs.mkdirSync(out);fs.mkdirSync(path.join(out,'source'));
const json=(n,v)=>fs.writeFileSync(path.join(out,n),JSON.stringify(v,null,2)+'\n'),sha=b=>createHash('sha256').update(b).digest('hex');
const sources={};for(const name of ['PLAN.md','broker.mjs','host.cjs','ui-preload.cjs','worker.mjs','controller.mjs','fixture.html','run.mjs']){const b=fs.readFileSync(path.join(here,name));sources[name]=sha(b);fs.writeFileSync(path.join(out,'source',name),b);}
const started=Date.now(),smoke=process.argv.includes('--smoke'),checks=[],ledger=[],holds=new Map();let requests=0;
json('manifest.json',{sources,started:new Date().toISOString(),node:process.version,mode:smoke?'smoke':'full',budget:{runs:8,cases:100,commands:20000,requests:1000,seconds:240,bytes:419430400},modelCalls:0,remoteUploads:0,remotePublications:0});
fs.writeFileSync(path.join(out,'selected-material.txt'),'选中的虚构素材');fs.writeFileSync(path.join(out,'unselected-canary.txt'),'NOT_SELECTED_DUMMY_DATA');
const record=e=>{ledger.push({time:Date.now(),...e});fs.appendFileSync(path.join(out,'website-events.jsonl'),JSON.stringify(ledger.at(-1))+'\n');};
const server=http.createServer((req,res)=>{
  requests++;if(requests>1000){res.writeHead(429).end();return;}
  const u=new URL(req.url,'http://fixture');record({kind:'request',method:req.method,path:req.url});
  if(u.pathname==='/effect'){const id=u.searchParams.get('id'),task=u.searchParams.get('task');record({kind:'accepted',id,task});holds.set(id,()=>{record({kind:'completed',id,task});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id,task,done:true}));holds.delete(id);});return;}
  if(u.pathname==='/download'){res.setHeader('Content-Disposition','attachment; filename="dummy.command"');res.end('This is inert fixture text.');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(u.pathname==='/frame'){res.end('<!doctype html><meta charset="utf-8"><input id="inner"><script>window.probe=()=>({require:typeof require,process:typeof process,helpr:typeof helpr,ipcRenderer:typeof ipcRenderer})</script>');return;}
  if(u.pathname==='/popup'){res.end('<!doctype html><meta charset="utf-8"><h1>所属弹窗</h1><input id="popupText">');return;}
  res.end(fs.readFileSync(path.join(here,'fixture.html')));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
// Only this run's loopback fixture is reachable.
server.on('connection',s=>{if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(s.remoteAddress))s.destroy();});
const child=fork(path.join(here,'controller.mjs'),[out,base],{stdio:['ignore','pipe','pipe','ipc']});child.stdout.pipe(fs.createWriteStream(path.join(out,'controller.stdout.log')));child.stderr.pipe(fs.createWriteStream(path.join(out,'controller.stderr.log')));
let seq=0,readyResolve;const ready=new Promise(r=>readyResolve=r),pending=new Map();
child.on('message',m=>{if(m.ready){json('environment.json',m);readyResolve(m);}if(m.seq!==undefined){const p=pending.get(m.seq);if(p){pending.delete(m.seq);clearTimeout(p.timer);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}}});
const ask=body=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CONTROL_TIMEOUT'));},14000);pending.set(id,{resolve,reject,timer});child.send({seq:id,...body});});
const job=(client,op,args={})=>ask({op:'job',client,body:{op,...args}});
const until=async f=>{const start=Date.now();while(!await f()){if(Date.now()-start>7000)throw new Error('WAIT_TIMEOUT');await new Promise(r=>setTimeout(r,40));}};
const rejected=async(p,pattern)=>{try{await p;throw new Error('UNEXPECTED_SUCCESS');}catch(e){assert.match(e.message,pattern);return e.message;}};
async function check(name,fn){assert(checks.length<100);let value,error;try{value=await fn();}catch(e){error=e.message;}checks.push({name,passed:!error,value,error,time:Date.now()});json('checks.json',checks);console.log(`${error?'FAIL':'PASS'} ${name}${error?': '+error:''}`);return !error;}
let pids=[],environment;
const terminate=()=>{try{child.kill('SIGKILL');}catch{}for(const pid of pids)if(pid!==process.pid)try{process.kill(pid,'SIGKILL');}catch{}};
const timer=setTimeout(()=>{json('timeout.json',{elapsed:Date.now()-started});terminate();process.exit(2);},240000);
try{
  environment=await Promise.race([ready,new Promise((_,rej)=>setTimeout(()=>rej(new Error('HOST_READY_TIMEOUT')),14000))]);pids=[child.pid,environment.hostPid];
  await check('private-pipe-startup',async()=>{const events=fs.readFileSync(path.join(out,'host-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);const r=events.find(e=>e.kind==='ready');assert.equal(r.switches.pipe,true);assert.equal(r.switches.port,false);assert.equal(r.switches.inspect,false);assert.equal(environment.versions.electron,'44.7.0');return r.switches;});
  await ask({op:'start',id:'pwA',task:'A'});await ask({op:'start',id:'pwB',task:'B'});
  const connected=await check('playwright-real-connections',async()=>{const [a,b]=await Promise.all([job('pwA','connect'),job('pwB','connect')]);assert.equal(a.length,1);assert.equal(b.length,1);assert(a[0].endsWith('task=A'));assert(b[0].endsWith('task=B'));return {a,b};});
  if(!connected)throw new Error('PREREQUISITE_PLAYWRIGHT_CONNECT');
  await check('playwright-fill-click-two-pages',async()=>{assert.equal(await job('pwA','fill',{selector:'#text',value:'A 的内容'}),'A 的内容');assert.equal(await job('pwB','fill',{selector:'#text',value:'B 的内容'}),'B 的内容');await Promise.all([job('pwA','click',{selector:'#add'}),job('pwB','click',{selector:'#add'})]);assert.equal(await job('pwA','evaluate',{expression:'document.querySelector("#count").textContent'}),'1');assert.equal(await job('pwB','evaluate',{expression:'document.querySelector("#count").textContent'}),'1');});
  if(smoke)throw new Error('SMOKE_COMPLETE');
  const state=await ask({op:'inspect'}),aTarget=state.targets.find(t=>t.task==='A').targetId,bTarget=state.targets.find(t=>t.task==='B').targetId;
  await ask({op:'start',id:'rawA',task:'A'});await ask({op:'start',id:'rawB',task:'B'});
  const aSession=(await job('rawA','raw',{method:'Target.attachToTarget',params:{targetId:aTarget,flatten:true}})).sessionId;
  const bSession=(await job('rawB','raw',{method:'Target.attachToTarget',params:{targetId:bTarget,flatten:true}})).sessionId;
  const raw=(method,params={},sessionId=aSession,client='rawA')=>job(client,'raw',{method,params,sessionId});
  await raw('Runtime.enable');await raw('Page.enable');const bFrame=(await raw('Page.getFrameTree',{},bSession,'rawB')).frameTree.frame.id;
  await check('missing-credential',()=>rejected(job('rawA','raw',{method:'Browser.getVersion',tokenMode:'missing'}),/QUALIFICATION_INVALID/));
  await check('forged-credential',()=>rejected(job('rawA','raw',{method:'Browser.getVersion',tokenMode:'forged'}),/QUALIFICATION_INVALID/));
  await check('independent-unqualified-client',async()=>{await ask({op:'start',id:'none',task:null});return rejected(job('none','raw',{method:'Browser.getVersion'}),/QUALIFICATION_INVALID/);});
  await check('credential-bound-to-process-channel',async()=>{await ask({op:'start',id:'borrowed',task:'B',credentialFrom:'rawA'});return rejected(job('borrowed','raw',{method:'Browser.getVersion'}),/QUALIFICATION_INVALID/);});
  await check('expired-credential-every-message',async()=>{await ask({op:'start',id:'expired',task:'A'});await job('expired','raw',{method:'Browser.getVersion'});await ask({op:'expire',client:'expired'});return rejected(job('expired','raw',{method:'Browser.getVersion'}),/QUALIFICATION_EXPIRED/);});
  await check('filtered-target-discovery',async()=>{const infos=(await raw('Target.getTargets',{},undefined)).targetInfos;assert(infos.length>=1);assert(infos.every(t=>t.targetId===aTarget));return infos.map(t=>t.targetId);});
  for(const [name,method,params,sid] of [
    ['other-task-target','Target.attachToTarget',{targetId:bTarget,flatten:true},undefined],
    ['nested-target-attach','Target.attachToTarget',{targetId:bTarget,flatten:true},aSession],
    ['host-dialog-target','Target.attachToTarget',{targetId:environment.uiTarget,flatten:true},undefined],
    ['other-task-session','Runtime.evaluate',{expression:'document.body.dataset.attacked="yes"'},bSession],
    ['other-task-frame','Page.navigate',{url:base+'/page?task=attacked',frameId:bFrame},aSession],
    ['legacy-nested-protocol','Target.sendMessageToTarget',{sessionId:bSession,message:JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'1'}})},aSession],
    ['browser-close','Browser.close',{},aSession],
    ['browser-context-create','Target.createBrowserContext',{},undefined],
    ['browser-file-access','Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out},undefined],
    ['shared-cookie-command','Network.getAllCookies',{},aSession],
    ['unsafe-navigation','Page.navigate',{url:'file://'+path.join(out,'unselected-canary.txt')},aSession]
  ])await check(name,()=>rejected(raw(method,params,sid),/NOT_OWNED|CAPABILITY_DENIED|NAVIGATION_DENIED/));
  await check('same-origin-frame',async()=>assert.equal(await job('pwA','frameFill',{frame:'#same',selector:'#inner',value:'same A'}),'same A'));
  await check('cross-site-frame',async()=>assert.equal(await job('pwA','frameFill',{frame:'#cross',selector:'#inner',value:'cross A'}),'cross A'));
  await check('popup-registered-and-owned',async()=>{await job('pwA','click',{selector:'#popup'});await until(async()=> (await job('pwA','pages')).some(u=>u.includes('/popup?')));assert.equal(await job('pwA','fill',{urlMatch:'/popup?',selector:'#popupText',value:'popup A'}),'popup A');const st=await ask({op:'inspect'});const pop=st.targets.find(t=>t.task==='A'&&t.targetId!==aTarget);assert(pop);await rejected(raw('Target.attachToTarget',{targetId:pop.targetId,flatten:true},null,'rawB'),/TARGET_NOT_OWNED/);return pop;});
  await check('selected-file-upload-adapter',async()=>assert.deepEqual(await job('pwA','upload',{file:path.join(out,'selected-material.txt')}),['selected-material.txt']));
  await check('unselected-file-denied',async()=>{await rejected(job('pwA','upload',{file:path.join(out,'unselected-canary.txt')}),/FILE_NOT_SELECTED|CAPABILITY_DENIED|Timeout/);assert(fs.readFileSync(path.join(out,'control-events.jsonl'),'utf8').includes('FILE_NOT_SELECTED'));assert.deepEqual(await job('pwA','evaluate',{expression:'Array.from(document.querySelector("input[type=file]").files).map(f=>f.name)'}),['selected-material.txt']);});
  await check('host-dialog-command-allowlist',async()=>{const r=await ask({op:'uiProbe'});assert.deepEqual(r,[{running:true},{denied:true}]);return r;});
  await check('remote-page-has-no-host-capabilities',async()=>{const r=await job('pwA','evaluate',{expression:'window.capabilities()'});assert.deepEqual(r,{require:'undefined',process:'undefined',helpr:'undefined',ipcRenderer:'undefined',credentialKeys:[]});return r;});
  await check('child-frame-has-no-host-capabilities',async()=>{const r=await job('pwA','evaluate',{expression:'document.querySelector("#same").contentWindow.probe()'});assert(Object.values(r).every(v=>v==='undefined'));return r;});
  await check('file-fetch-denied',async()=>{const r=await job('pwA','evaluate',{expression:`fetch(${JSON.stringify('file://'+path.join(out,'unselected-canary.txt'))}).then(r=>r.text()).catch(()=>"denied")`});assert.equal(r,'denied');});
  await check('external-protocol-and-host-popup-denied',async()=>{await job('pwA','evaluate',{expression:'[window.open("helpr://ui/index"),window.open("x-helpr-probe://inert"),window.open("file:///not-a-real-file")].map(x=>x===null)'});const ev=fs.readFileSync(path.join(out,'host-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(ev.filter(e=>e.kind==='popup-denied').length>=3);});
  await check('frame-host-navigation-denied',async()=>{await job('pwA','evaluate',{expression:'document.querySelector("#same").src="helpr://ui/index"'});await new Promise(r=>setTimeout(r,120));assert.equal(await job('pwA','evaluate',{expression:'typeof document.querySelector("#same").contentWindow.helpr'}),'undefined');});
  await check('download-not-executed-or-saved',async()=>{await job('pwA','click',{selector:'#download'});await until(()=>fs.readFileSync(path.join(out,'host-events.jsonl'),'utf8').includes('download-denied'));assert.equal(fs.existsSync(path.join(out,'dummy.command')),false);});
  await check('permission-request-denied',async()=>{const r=await job('pwA','evaluate',{expression:'Notification.requestPermission()'});assert.equal(r,'denied');return r;});
  await check('navigation-and-reload-keep-ownership',async()=>{await job('pwA','goto',{url:base+'/page?task=A&v=2'});await job('pwA','reload');assert.equal(await job('pwA','fill',{selector:'#text',value:'导航后 A'}),'导航后 A');assert.equal(await job('pwB','evaluate',{expression:'document.querySelector("#text").value'}),'B 的内容');});
  await check('two-real-overlapping-requests',async()=>{const settle=p=>p.then(value=>({value}),error=>({error:error.message}));const a=settle(job('pwA','evaluate',{expression:'effect("overlapA")'})),b=settle(job('pwB','evaluate',{expression:'effect("overlapB")'}));await until(()=>holds.has('overlapA')&&holds.has('overlapB'));const completed=ledger.filter(e=>e.kind==='completed');assert.equal(completed.length,0);holds.get('overlapA')();holds.get('overlapB')();const r=await Promise.all([a,b]);assert(r.every(x=>x.value?.done));return r;});
  await check('network-listener-inventory',async()=>{const st=await ask({op:'inspect'});pids=st.pids;let text='';for(const pid of pids){try{text+=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-iTCP','-sTCP:LISTEN'],{encoding:'utf8'});}catch(e){if(e.status!==1)throw e;}}fs.writeFileSync(path.join(out,'listeners.txt'),text||'No TCP listeners in controller, host and workers.\n');assert.equal(text,'');return {pids};});
  await check('screenshots',async()=>{for(const id of ['pwA','pwB'])fs.writeFileSync(path.join(out,id+'.png'),Buffer.from(await job(id,'screenshot'),'base64'));});
  await check('stop-A-keeps-B-and-host-late-effects',async()=>{const late=job('pwA','evaluate',{expression:'effect("lateA")'}).then(value=>({value}),e=>({error:e.message}));await until(()=>holds.has('lateA'));await ask({op:'revoke',task:'A'});await rejected(raw('Runtime.evaluate',{expression:'effect("forbiddenAfterStop")'}),/QUALIFICATION_REVOKED/);await rejected(job('rawA','raw',{method:'Browser.getVersion'}),/QUALIFICATION_REVOKED/);holds.get('lateA')();await until(()=>ledger.some(e=>e.kind==='completed'&&e.id==='lateA'));await job('pwB','click',{selector:'#add'});assert.equal(await job('pwB','evaluate',{expression:'document.querySelector("#count").textContent'}),'2');process.kill(environment.hostPid,0);assert(!ledger.some(e=>e.id==='forbiddenAfterStop'));return {late:await late,hostAlive:true};});
  await check('revoked-reconnect-denied',()=>rejected(job('pwA','connect'),/QUALIFICATION_REVOKED|closed/));
  await check('new-qualification-old-session-denied',async()=>{await ask({op:'start',id:'newA',task:'A'});return rejected(job('newA','raw',{method:'Runtime.evaluate',sessionId:aSession,params:{expression:'1'}}),/SESSION_NOT_OWNED/);});
  await check('worker-death-leaves-B-and-host',async()=>{await ask({op:'killWorker',client:'newA'});await job('pwB','click',{selector:'#add'});assert.equal(await job('pwB','evaluate',{expression:'document.querySelector("#count").textContent'}),'3');process.kill(environment.hostPid,0);});
  await check('credentials-not-in-shareable-evidence',async()=>{const r=await ask({op:'secretAudit'});assert.equal(r.matches.length,0);return r;});
  const finalState=await ask({op:'inspect'});pids=finalState.pids;json('final-state.json',finalState);
  await check('controller-death-closes-private-pipe-and-workers',async()=>{child.kill('SIGKILL');await until(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}));return {pids,allExited:true};});
}catch(e){if(e.message!=='SMOKE_COMPLETE'){json('fatal.json',{message:e.message});console.log('FATAL '+e.message);}}
finally{
  clearTimeout(timer);for(const release of holds.values())release();try{if(child.connected)await ask({op:'close'});}catch{}terminate();server.closeAllConnections();server.close();
  json('summary.json',{checks:checks.length,passed:checks.filter(c=>c.passed).length,requests,elapsedMs:Date.now()-started,modelCalls:0,remoteUploads:0,remotePublications:0});console.log(out);
}
