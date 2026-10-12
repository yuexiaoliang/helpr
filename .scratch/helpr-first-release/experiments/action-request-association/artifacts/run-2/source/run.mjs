// 真实 Chromium / 本机 HTTP 探路。测试语义和期望属于夹具，不进入代理实现。
import { chromium } from '../runtime-flow-replay/node_modules/playwright/index.mjs';
import { mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openFixture } from './fixture.mjs';
import { openGate, save, sha, sleep } from './wire.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(root,'artifacts'); mkdirSync(artifacts,{recursive:true});
const ledgerPath = path.join(artifacts,'budget.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath)) : {
  startedAt:Date.now(), cases:0, launches:0, writes:0, uploads:0, sourceVersions:[], attempts:[], modelCalls:0, remotePreparations:0, remoteUploads:0, remotePublications:0
};
if (ledger.closedAt) throw new Error('experiment-closed; inspect saved evidence instead of starting more cases');
const sources = ['PLAN.md','wire.mjs','fixture.mjs','run.mjs'];
const fingerprints = Object.fromEntries(sources.map(name=>[name,sha(readFileSync(path.join(root,name)))]));
const version = sha(JSON.stringify(fingerprints));
if (!ledger.sourceVersions.includes(version)) {
  if (ledger.sourceVersions.length >= 3) throw new Error('source-revision-budget');
  ledger.sourceVersions.push(version);
}
function reserve(kind) {
  if (Date.now() - ledger.startedAt > 60*60*1000) throw new Error('time-budget');
  const limits = { cases:40, launches:5, writes:64, uploads:8 };
  if (ledger[kind] >= limits[kind]) throw new Error(`${kind}-budget`);
  ledger[kind]++; save(ledgerPath,ledger);
}
const CASES = [
  ['baseline-same-click','baseline','same-click',2],
  ['baseline-late','baseline','late',0],
  ['baseline-late-next','baseline','late-next',1],
  ['baseline-disk-upload','baseline','upload-disk',1],
  ['baseline-replaced-upload','baseline','upload-replaced',1],
  ['baseline-get','baseline','get',1],
  ['baseline-redirect','baseline','redirect',2],
  ['page-route-service-worker','page-route','service-worker',1],
  ['context-route-service-worker','context-route','service-worker',0],
  ['page-route-worker','page-route','worker',0],
  ['strict-same-click','strict','same-click',1],
  ['strict-extra-first','strict','extra-first',1],
  ['strict-xhr','strict','xhr',1],
  ['strict-disk-upload','strict','upload-disk',1],
  ['strict-replaced-upload','strict','upload-replaced',0],
  ['strict-late','strict','late',0],
  ['strict-matching-timer','strict','matching-timer',1],
  ['strict-frame-form','strict','form',1],
  ['strict-redirect','strict','redirect',1],
  ['strict-get','strict','get',0],
  ['strict-worker-unknown','strict','worker',0],
  ['strict-service-worker-unknown','strict','service-worker',0],
  ['strict-beacon-late','strict','beacon',0],
  ['strict-held-revoke','strict','held-revoke',0],
  ['strict-forward-stop','strict','forward-stop',1]
];
const requested = process.argv.slice(2);
if (requested.some(id=>!CASES.some(row=>row[0]===id))) throw new Error('unknown-case');
const selected = requested.length ? CASES.filter(row=>requested.includes(row[0])) : CASES;
reserve('launches');
const runId = `run-${ledger.launches}`;
const runDirectory = path.join(artifacts,runId); mkdirSync(path.join(runDirectory,'source'),{recursive:true});
for (const name of sources) copyFileSync(path.join(root,name),path.join(runDirectory,'source',name));
save(path.join(runDirectory,'source-hashes.json'),fingerprints);
const browser = await chromium.launch({headless:true,args:['--proxy-bypass-list=<-loopback>']});
const results = [];
save(path.join(runDirectory,'environment.json'),{node:process.version,chromium:browser.version(),playwright:JSON.parse(readFileSync(path.join(root,'../runtime-flow-replay/node_modules/playwright/package.json'))).version,sourceVersion:version});

async function until(check, timeout=8000) {
  const stop=Date.now()+timeout;
  while (Date.now()<stop) { if (await check()) return; await sleep(25); }
  throw new Error('observation-timeout');
}

try {
  for (const [id,mode,kind,expectedReceipts] of selected) {
    reserve('cases');
    const directory = path.join(runDirectory,id); mkdirSync(directory,{recursive:true});
    const attempt = {id,mode,kind,run:runId,startedAt:Date.now(),sourceVersion:version};
    ledger.attempts.push(attempt); save(ledgerPath,ledger);
    const result = {...attempt,expectedReceipts,checks:[]};
    const check = (name,ok,details) => result.checks.push({name,ok:!!ok,...(details===undefined?{}:{details})});
    let fixture,gate,context,active=null;
    const routes=[],requests=[],cdpRequests=[],dom=[],pending=[];
    try {
      fixture = await openFixture({id,kind,directory,reserve:kind=>{reserve('writes');if(kind==='upload')reserve('uploads');}});
      if (mode==='strict') gate=await openGate({origin:fixture.origin,resourcePaths:fixture.resources,directory,hold:kind==='held-revoke'});
      context=await browser.newContext({serviceWorkers:'allow',...(gate?{proxy:{server:gate.origin}}:{})});
      context.setDefaultTimeout(8000);
      await context.exposeBinding('recordDom',(_source,event)=>dom.push(event));
      await context.addInitScript(()=> {
        for(const type of ['click','change','submit']) document.addEventListener(type,e=>window.recordDom({type,trusted:e.isTrusted,tag:e.target?.tagName,at:Date.now(),document:location.href}),true);
      });
      context.on('request',request=> {
        if (!/\/(sink|redirect)\//.test(request.url())) return;
        let frame,frameError;
        try { frame=request.frame().url(); } catch(error) { frameError=error.message; }
        const bytes=request.postDataBuffer();
        requests.push({at:Date.now(),method:request.method(),url:request.url(),frame,frameError,serviceWorker:!!request.serviceWorker(),
          navigation:request.isNavigationRequest(),redirectedFrom:request.redirectedFrom()?.url(),postData:bytes?{bytes:bytes.length,sha256:sha(bytes),filenames:[...bytes.toString().matchAll(/filename="([^"]+)"/g)].map(m=>m[1])}:null});
      });
      const page=await context.newPage();
      const cdp=await context.newCDPSession(page);
      await cdp.send('Network.enable',{maxPostDataSize:1024*1024}); await cdp.send('Debugger.enable');
      await cdp.send('Debugger.setAsyncCallStackDepth',{maxDepth:8});
      cdp.on('Network.requestWillBeSent',event=> {
        if (!/\/(sink|redirect)\//.test(event.request.url)) return;
        const request=event.request;
        const row={at:Date.now(),requestId:event.requestId,frameId:event.frameId,loaderId:event.loaderId,type:event.type,url:request.url,
          initiator:event.initiator,hasPostData:request.hasPostData,postDataBytes:request.postData===undefined?null:Buffer.byteLength(request.postData),
          entries:request.postDataEntries?.map(entry=>entry.bytes?{bytes:Buffer.from(entry.bytes,'base64').length,sha256:sha(Buffer.from(entry.bytes,'base64'))}:{missing:true})};
        cdpRequests.push(row);
        if (request.hasPostData) pending.push(cdp.send('Network.getRequestPostData',{requestId:event.requestId}).then(data=>{
          const bytes=Buffer.from(data.postData,data.base64Encoded?'base64':'utf8');row.getPostData={bytes:bytes.length,sha256:sha(bytes)};
        }).catch(error=>{row.getPostDataError=error.message;}));
      });
      const routeHandler = async route=> {
        const request=route.request(),url=new URL(request.url());
        if (!/\/(sink|redirect)\//.test(url.pathname)) { await route.continue(); return; }
        let decision='blocked',reason='no-active-action';
        if (mode==='baseline') {
          if(['GET','HEAD','OPTIONS'].includes(request.method())) {decision='allowed';reason='method-bypass';}
          else if (active && url.origin===fixture.origin) {
            if (kind.startsWith('upload')) {
              const selection=await page.evaluate(()=>window.selection);
              const names=[...(request.postDataBuffer()||Buffer.alloc(0)).toString().matchAll(/filename="([^"]+)"/g)].map(m=>m[1]);
              if(selection?.sha256===fixture.sourceHash && names.length===1 && names[0]==='sample.bin') {decision='allowed';reason='selected-hash-and-request-name';}
            } else {decision='allowed';reason='current-action-window';}
          }
        }
        routes.push({at:Date.now(),url:request.url(),method:request.method(),active,decision,reason,serviceWorker:!!request.serviceWorker()});
        if(decision==='allowed') await route.continue(); else await route.fulfill({status:403,body:reason});
      };
      if(mode==='baseline'||mode==='page-route') await page.route('**/*',routeHandler);
      else if(mode==='context-route') await context.route('**/*',routeHandler);
      await page.goto(`${fixture.origin}/fixture/${id}`);
      if(kind==='service-worker') await page.evaluate(()=>window.ready);
      save(`${directory}/fixture-contract.json`,{source:'experiment-injected',contract:fixture.contract,sourceFile:{bytes:fixture.sourceBytes,sha256:fixture.sourceHash}});
      const unknownChannel=id.includes('-unknown');
      if(kind==='matching-timer') {
        await page.evaluate(()=>{window.actor.push({source:'old-action',at:Date.now()});window.scheduleOld();});
        await sleep(50);
      }
      if(gate&&!unknownChannel) result.generation=gate.arm(fixture.contract);
      active='action-1'; result.actionStart=Date.now();
      if(kind==='matching-timer') {
        await until(()=>fixture.rows.length===1);
        result.timerReceivedBeforeClick=true;
        await page.locator('#go').click();
      } else if(kind.startsWith('upload')) await page.locator('#file').setInputFiles(fixture.filePath);
      else if(kind==='form') await page.frameLocator('iframe').locator('#submit').click();
      else await page.locator('#go').click();
      result.primitiveReturnedAt=Date.now();
      if(kind==='late'||kind==='beacon') {active=null;gate?.revoke();result.revokedAt=Date.now();}
      if(kind==='late-next') {active=null;result.oldActionEndedAt=Date.now();await sleep(50);active='action-2';result.nextActionStartedAt=Date.now();}
      if(kind==='held-revoke') {await gate.held;gate.revoke();result.revokedAt=Date.now();gate.release();}
      if(kind==='forward-stop') {await until(()=>fixture.rows.length===1);gate.revoke();result.revokedAt=Date.now();result.stateAtStop='dispatched-result-unknown';}
      if(kind==='form') await until(()=>fixture.rows.length===1);
      else await page.waitForFunction(expected=>window.done>=expected,(['same-click','extra-first','xhr','matching-timer'].includes(kind))?2:1);
      await sleep(150); active=null;
      await Promise.allSettled(pending);
      result.selection=await page.evaluate(()=>window.selection||null);
      result.actors=await page.evaluate(()=>window.actor||[]);
      result.serverReceipts=fixture.rows.length;
      result.stored=fixture.rows.filter(r=>r.effect==='stored').length;
      check('server-receipt-count',fixture.rows.length===expectedReceipts,{actual:fixture.rows.length,expected:expectedReceipts});
      if(id==='baseline-same-click') {
        check('unrelated-write-reached-server',fixture.rows.some(row=>row.body===fixture.bad));
        const stacks=cdpRequests.map(row=>JSON.stringify(row.initiator.stack?.callFrames));
        check('same-click-same-synchronous-stack',stacks.length===2 && stacks[0]===stacks[1],stacks.length);
      }
      if(kind.startsWith('upload')) {
        check('selected-original-bytes',result.selection?.sha256===fixture.sourceHash);
        if(expectedReceipts) {
          const uploaded=fixture.rows[0].file;
          const download=Buffer.from(await (await fetch(`${fixture.origin}/download/${fixture.rows[0].id}`)).arrayBuffer());
          result.download={bytes:download.length,sha256:sha(download)};
          check('download-agrees-with-server',sha(download)===uploaded?.sha256);
          check(kind==='upload-disk'?'original-upload-arrived':'same-name-wrong-bytes-arrived',uploaded?.sha256===fixture.sourceHash ? kind==='upload-disk' : kind==='upload-replaced');
        }
        if(gate&&kind==='upload-disk') check('full-entity-agrees',gate.rows.some(row=>row.sha256===fixture.rows[0]?.sha256&&row.parts?.some(p=>p.sha256===fixture.sourceHash)));
      }
      if(id==='baseline-redirect') check('only-initial-hop-routed',routes.length===1&&fixture.rows.length===2);
      if(id==='context-route-service-worker') check('worker-frame-throws',requests.some(r=>r.serviceWorker&&r.frameError));
      if(id==='page-route-service-worker') check('page-route-missed-worker-network',routes.length===0&&fixture.rows.length===1);
      if(id==='strict-matching-timer') check('matching-old-timer-consumed-new-permit',result.timerReceivedBeforeClick&&gate.rows.some(row=>row.reason==='contract-consumed'));
      if(id==='strict-held-revoke') check('held-request-revoked-before-forward',gate.rows.some(row=>row.reason==='revoked-before-forward')&&fixture.rows.length===0);
      if(id==='strict-forward-stop') check('stop-after-dispatch-cannot-unsend',fixture.rows[0]?.receivedAt<=result.revokedAt&&gate.rows.some(row=>row.responseAt>result.revokedAt));
      if(gate&&['same-click','extra-first','xhr'].includes(kind)) check('only-expected-content-stored',fixture.rows[0]?.body===fixture.good);
      if(gate&&kind==='extra-first') check('wrong-body-refused-with-permit-still-unused',gate.rows.some(row=>row.reason==='body-mismatch')&&fixture.rows[0]?.body===fixture.good);
      if(gate&&kind==='redirect') check('redirected-final-target-blocked',result.stored===0&&gate.rows.some(row=>row.reason==='contract-consumed'));
      result.status=result.checks.every(c=>c.ok)?'observed-as-specified':'check-failed';
    } catch(error) {result.status='error';result.error={message:error.message,stack:error.stack};}
    finally {
      gate?.release();
      if(context) await context.close().catch(()=>{});
      await Promise.allSettled(pending);
      save(`${directory}/browser-requests.json`,requests); save(`${directory}/routes.json`,routes);
      save(`${directory}/cdp.json`,cdpRequests);save(`${directory}/dom-events.json`,dom);
      if(gate){save(`${directory}/proxy.json`,gate.rows);await gate.close();}
      if(fixture){save(`${directory}/server.json`,fixture.rows);await fixture.close();}
      result.finishedAt=Date.now();save(`${directory}/result.json`,result);
      results.push(result);save(`${runDirectory}/results.json`,results);
      attempt.status=result.status;attempt.finishedAt=result.finishedAt;save(ledgerPath,ledger);
      console.log(JSON.stringify({id,status:result.status,receipts:result.serverReceipts,failed:result.checks.filter(c=>!c.ok).map(c=>c.name),error:result.error?.message}));
    }
  }
} finally {await browser.close();}
console.log(JSON.stringify({run:runId,cases:results.length,budget:{cases:ledger.cases,launches:ledger.launches,writes:ledger.writes,uploads:ledger.uploads,sourceVersions:ledger.sourceVersions.length},errors:results.filter(r=>r.status!=='observed-as-specified').length}));
