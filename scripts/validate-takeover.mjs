// 实际候选的有界接管核对；UI 输入由桌面工具/真人产生，禁止注入网页脚本。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spend, validationRoot } from './workspace-budget.mjs';
import { verifyDevelopmentSignature } from './development-signing.mjs';
import { readLifecycleProgress } from './lifecycle-progress-reuse.mjs';

const lifecycle = process.argv.includes('--lifecycle');
const label = lifecycle ? '06' : '04';
const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8);
assert(round && /^[a-z0-9-]{1,40}$/.test(round), 'ROUND_REQUIRED');
const out = path.resolve(validationRoot, round);
assert(!fs.existsSync(out), 'ROUND_ALREADY_STARTED');
const build = Number(process.argv.find((arg) => arg.startsWith('--build='))?.slice(8) ?? 22);
assert(Number.isSafeInteger(build) && build > 0, 'INVALID_BUILD');
let manifest = JSON.parse(fs.readFileSync(path.join(validationRoot, `build-${build}.json`)));
let candidateReview;
const postchecked = process.argv.find((arg) => arg.startsWith('--postchecked-candidate='))?.slice(24);
if (postchecked !== undefined) {
  assert(/^[a-z0-9-]{1,40}$/.test(postchecked) && manifest.prepared === false, 'POSTCHECKED_FAILED_BUILD_REQUIRED');
  const source = 'docs/testing/evidence/development-signing/result.json';
  const proof = JSON.parse(fs.readFileSync(source));
  const original = proof.builds.find((entry) => entry.build === build);
  assert(original?.originalPrepared === false && original.originalError === manifest.error && proof.postcheck.build === build && proof.postcheck.passed === true, 'POSTCHECK_BUILD_MISMATCH');
  const app = path.resolve(`dist/candidates/${postchecked}/mac-arm64/helpr.app`);
  const hashes = {};
  for (const file of ['Contents/MacOS/helpr', 'Contents/Resources/app.asar', 'Contents/Resources/watch-owner', 'Contents/Frameworks/helpr Workspace.app/Contents/MacOS/helpr Workspace Helper', 'Contents/Frameworks/helpr Workspace.app/Contents/Info.plist'])
    hashes[file] = createHash('sha256').update(fs.readFileSync(path.join(app,file))).digest('hex');
  assert(hashes['Contents/Resources/app.asar'] === proof.postcheck.archive && hashes['Contents/MacOS/helpr'] === proof.postcheck.controller, 'POSTCHECK_ARTIFACT_CHANGED');
  const signing = verifyDevelopmentSignature(app);
  assert(signing.certificateSha256 === proof.identity.certificateSha256 && JSON.stringify(signing.images) === JSON.stringify(proof.images), 'POSTCHECK_SIGNATURE_CHANGED');
  execFileSync(process.execPath, ['scripts/validate-host-package.mjs',app], {stdio:'pipe'});
  candidateReview = {source,build,originalPrepared:false,originalError:manifest.error,checkedAt:new Date().toISOString(),certificateSha256:signing.certificateSha256};
  // 只生成本轮内存入口，原失败清单保持不动；本轮另外保存完整候选检查记录。
  manifest = {...manifest,app,prepared:true,hashes};
}
const built = manifest.app;
assert(typeof built === 'string' && path.isAbsolute(built), 'INVALID_CANDIDATE');
assert(manifest.prepared && manifest.app === built, 'CANDIDATE_NOT_READY');
for (const [file, hash] of Object.entries(manifest.hashes))
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(built, file))).digest('hex'), hash);
const carryName = process.argv.find((arg) => arg.startsWith('--carry='))?.slice(8);
const reuseInputPreparation = process.argv.includes('--reuse-input-preparation');
const reuseInputProgress = process.argv.includes('--reuse-input-progress');
assert(!reuseInputProgress || (lifecycle && !reuseInputPreparation && carryName==='lifecycle-06-input-verified'),'INPUT_PROGRESS_REUSE_REQUIRES_SOURCE');
assert(!reuseInputPreparation || (lifecycle && ['lifecycle-06-input-final','lifecycle-06-input-ready'].includes(carryName)), 'INPUT_PREPARATION_REUSE_REQUIRES_SOURCE');
let preparationReuse;
const taskLimit = Number(process.argv.find((arg) => arg.startsWith('--task-limit='))?.slice(13) ?? (lifecycle ? 4 : 12));
assert((lifecycle && (taskLimit === 4 || ([6,8].includes(taskLimit) && carryName))) || (!lifecycle && [12,14,16,18,20,22,24,26].includes(taskLimit)), 'INVALID_TASK_LIMIT');
const lifecycleInputArgument = process.argv.find((arg) => arg.startsWith('--lifecycle-input-limit='))?.slice(24);
const lifecycleInputs = Number(lifecycleInputArgument ?? 16);
assert(lifecycleInputArgument === undefined || (lifecycle && carryName && [160,224].includes(lifecycleInputs)), 'LIFECYCLE_INPUT_EXTENSION_REQUIRES_CARRY');
const lifecycleModelArgument = process.argv.find((arg) => arg.startsWith('--lifecycle-model-limit='))?.slice(24);
const lifecycleModels = Number(lifecycleModelArgument ?? 24);
assert(lifecycleModelArgument === undefined || (lifecycle && carryName && lifecycleModels === 32), 'LIFECYCLE_MODEL_EXTENSION_REQUIRES_CARRY');
const maximum = lifecycle ? {effects:8, inputs:lifecycleInputs, models:lifecycleModels, tasks:taskLimit} : { effects: 24, inputs: 160, models: 64, tasks: taskLimit };
assert(lifecycle || taskLimit === 12 || carryName !== undefined, 'EXTENDED_TASK_LIMIT_REQUIRES_CARRY');
const repairOf = process.argv.find((arg) => arg.startsWith('--repair-of='))?.slice(12);
assert(repairOf === undefined || (carryName && /^[0-9a-f]{64}$/.test(repairOf)), 'INVALID_REPAIR_LINEAGE');
const derivedFrom = process.argv.find((arg) => arg.startsWith('--derived-from='))?.slice(15);
assert(derivedFrom === undefined || (carryName && !repairOf && /^[0-9a-f]{64}$/.test(derivedFrom)), 'INVALID_DERIVATION_LINEAGE');
let carry;
if (carryName !== undefined) {
  assert(/^[a-z0-9-]{1,40}$/.test(carryName) && carryName !== round, 'INVALID_CARRY_ROUND');
  const priorRoot = path.join(validationRoot, carryName);
  const priorBytes = fs.readFileSync(path.join(priorRoot, 'result.json'));
  const prior = JSON.parse(priorBytes);
  if (lifecycle) assert(prior.purpose === 'lifecycle-06', 'LIFECYCLE_CARRY_REQUIRED');
  const postcheckFile = path.join(priorRoot, 'hidden-check.json');
  const postcheck = lifecycle && fs.existsSync(postcheckFile) ? JSON.parse(fs.readFileSync(postcheckFile)) : undefined;
  if (postcheck) assert(postcheck.failure === 'HIDDEN_TASKS_MUST_ADVANCE_WITHOUT_PAUSING' && postcheck.archive === prior.archive && postcheck.resultSHA256 === createHash('sha256').update(priorBytes).digest('hex'), 'INVALID_HIDDEN_POSTCHECK');
  const repaired = repairOf === prior.archive && Number.isSafeInteger(prior.build) && prior.build < build && Boolean(prior.controlFailure || prior.failure || prior.fixtureFailure || postcheck?.failure);
  const derived = derivedFrom === prior.archive && Number.isSafeInteger(prior.build) && prior.build < build && prior.exitCode === 0 && !prior.failure && !prior.controlFailure && !prior.fixtureFailure && !postcheck?.failure;
  assert(prior.finished && (prior.archive === manifest.hashes['Contents/Resources/app.asar'] || repaired || derived), 'CARRY_CANDIDATE_NOT_FINISHED');
  const normalExit = prior.exitCode === 0 && Array.isArray(prior.survivors) && prior.survivors.length === 0;
  const checkedCleanup = typeof prior.postCleanup?.checkedAt === 'string' && Array.isArray(prior.postCleanup.survivors) && prior.postCleanup.survivors.length === 0;
  assert(normalExit || checkedCleanup, 'CARRY_CANDIDATE_NOT_STOPPED');
  // 缺少发送前预留的旧记录不能凭成功返回的 ID 数推定没有回执不明的创建。
  assert(Number.isSafeInteger(prior.taskAttempts) && prior.taskAttempts >= 0, 'CARRY_TASK_ATTEMPTS_REQUIRED');
  carry = { round: carryName, counts: {}, ...(repaired ? {repair:{build:prior.build,archive:prior.archive,...(postcheck?{postcheck:postcheck.failure}:{})}} : {}), ...(derived ? {derivation:{build:prior.build,archive:prior.archive}} : {}) };
  for (const kind of Object.keys(maximum)) {
    const used = (prior.carry?.counts[kind] ?? 0) + (kind === 'tasks' ? prior.taskAttempts : prior[kind].length);
    assert(Number.isSafeInteger(used) && used >= 0 && used <= maximum[kind], 'INVALID_CARRY_COUNTS');
    carry.counts[kind] = used;
  }
}
if (reuseInputPreparation) {
  // 原始81资料证明保持不变；82的正常冷打开另有退出后的字节依据。
  const priorRoot=path.join(validationRoot,'lifecycle-06-input-final');
  const proof=JSON.parse(fs.readFileSync('docs/testing/evidence/lifecycle-06/INPUT-PREPARATION-FAILURE.json'));
  let databaseProof=proof;
  if(carryName==='lifecycle-06-input-ready') {
    databaseProof=JSON.parse(fs.readFileSync('docs/testing/evidence/lifecycle-06/REUSE-PRELAUNCH-PROOF.json'));
    const openedRoot=path.join(validationRoot,carryName);
    for(const [file,sha] of Object.entries(databaseProof.sourceFiles))
      assert(['result.json','context.json','ids.json'].includes(file) && createHash('sha256').update(fs.readFileSync(path.join(openedRoot,file))).digest('hex')===sha,'INPUT_PREPARATION_OPENED_SOURCE_CHANGED');
    assert(Object.keys(databaseProof.sourceFiles).sort().join(',')==='context.json,ids.json,result.json','INPUT_PREPARATION_OPENED_FILES_REQUIRED');
    const opened=JSON.parse(fs.readFileSync(path.join(openedRoot,'result.json')));
    const gateFailure=JSON.parse(fs.readFileSync('docs/testing/evidence/lifecycle-06/REUSE-GATE-FAILURE.json'));
    assert(databaseProof.source==='lifecycle-06-input-ready' && opened.start===82 && opened.build===build && opened.archive===manifest.hashes['Contents/Resources/app.asar'] && opened.failure===gateFailure.failure && databaseProof.sourceFiles['result.json']===gateFailure.resultSHA256,'INPUT_PREPARATION_GATE_FAILURE_REQUIRED');
    assert(opened.taskAttempts===0 && ['models','effects','inputs'].every(kind=>opened[kind].length===0) && !opened.validationStarted && !opened.humanSteps && !opened.controlFailure && !opened.fixtureFailure,'INPUT_PREPARATION_OPENED_UNUSED_REQUIRED');
    assert(opened.finished && opened.exitCode===0 && opened.survivors.length===0 && opened.groupSurvivors.length===0 && opened.processTree.every(row=>!alive(row.pid)) && databaseProof.independentExit.pidSurvivors.length===0 && databaseProof.independentExit.groupSurvivors.length===0,'INPUT_PREPARATION_OPENED_EXIT_REQUIRED');
    assert(opened.preparationReuse?.source==='lifecycle-06-input-final' && opened.preparationReuse.resultSHA256===proof.resultSHA256 && databaseProof.parentResultSHA256===proof.resultSHA256 && databaseProof.audit.unusedTasksPreserved===true,'INPUT_PREPARATION_PARENT_REQUIRED');
    for(const file of ['context.json','ids.json']) assert(fs.readFileSync(path.join(openedRoot,file)).equals(fs.readFileSync(path.join(priorRoot,file))),'INPUT_PREPARATION_IDENTITY_CHANGED');
    assert.deepEqual(opened.carry.counts,carry.counts,'INPUT_PREPARATION_COUNTS_CHANGED');
  }
  for(const [file,key] of [['result.json','resultSHA256'],['context.json','contextSHA256'],['ids.json','idsSHA256'],['snapshot.json','snapshotSHA256']])
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(priorRoot,file))).digest('hex'),proof[key],'INPUT_PREPARATION_SOURCE_CHANGED');
  const previous=JSON.parse(fs.readFileSync(path.join(priorRoot,'result.json')));
  const context=JSON.parse(fs.readFileSync(path.join(priorRoot,'context.json')));
  const previousIds=JSON.parse(fs.readFileSync(path.join(priorRoot,'ids.json')));
  const previousState=JSON.parse(fs.readFileSync(path.join(priorRoot,'snapshot.json')));
  assert(previous.build===build && previous.archive===manifest.hashes['Contents/Resources/app.asar'] && previous.failure==='VALIDATION_WAIT_EXPIRED' && previous.models.length===0 && previous.effects.length===0 && previous.taskAttempts===2 && previous.humanSteps.length===1 && !previous.humanSteps[0].armSentAt,'INPUT_PREPARATION_NEVER_STARTED_REQUIRED');
  assert(previous.exitCode===0 && previous.survivors.length===0 && previous.groupSurvivors.length===0 && proof.independentExit.pidSurvivors.length===0 && proof.independentExit.groupSurvivors.length===0,'INPUT_PREPARATION_EXIT_REQUIRED');
  assert(previous.processTree.every(row=>!alive(row.pid)),'INPUT_PREPARATION_PROCESS_STILL_ALIVE');
  const root=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
  assert(context.built===built && context.profile.startsWith(root+'/lifecycle06-') && path.dirname(context.profile)===root && fs.realpathSync(root)===root && fs.realpathSync(context.profile)===context.profile,'INPUT_PREPARATION_PROFILE_REQUIRED');
  const stat=fs.statSync(context.profile); assert(stat.uid===process.getuid() && (stat.mode&0o077)===0,'INPUT_PREPARATION_PROFILE_OWNER_REQUIRED');
  const databaseFiles=['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm'];
  assert.deepEqual(databaseFiles.filter(file=>fs.existsSync(path.join(context.profile,file))).sort(),Object.keys(databaseProof.profileFiles).sort(),'INPUT_PREPARATION_DATABASE_FILES_CHANGED');
  for(const [file,sha] of Object.entries(databaseProof.profileFiles)) {
    assert(['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm'].includes(file),'INPUT_PREPARATION_FILE_DENIED');
    assert(!fs.lstatSync(path.join(context.profile,file)).isSymbolicLink(),'INPUT_PREPARATION_FILE_SYMLINK');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(context.profile,file))).digest('hex'),sha,'INPUT_PREPARATION_DATABASE_CHANGED');
  }
  assert(databaseProof.profileFiles['workspace.sqlite'],'INPUT_PREPARATION_DATABASE_REQUIRED');
  const origin=new URL(context.base); assert(origin.origin===context.base && origin.protocol==='http:' && origin.hostname==='127.0.0.1' && origin.port,'INPUT_PREPARATION_LOCAL_ORIGIN_REQUIRED');
  assert(Object.keys(previousIds).sort().join(',')==='A,B' && previousState.tasks.length===2 && ['A','B'].every(name=>previousState.tasks.some(task=>task.id===previousIds[name] && task.url===context.base+'/page/'+name && !task.execution)),'INPUT_PREPARATION_UNUSED_TASKS_REQUIRED');
  assert(previousState.modelSettings?.endpoint===context.base+'/v1' && previousState.modelSettings.model==='controlled-local-04' && previousState.modelSettings.hasCredential && previousState.modelSettings.version>=1,'INPUT_PREPARATION_CONFIGURATION_REQUIRED');
  preparationReuse={source:carryName,resultSHA256:databaseProof.sourceFiles?.['result.json'] ?? proof.resultSHA256,parentResultSHA256:proof.resultSHA256,profile:context.profile,base:context.base,ids:previousIds};
}
if(reuseInputProgress) preparationReuse=readLifecycleProgress({root:validationRoot,source:carryName,build,built,archive:manifest.hashes['Contents/Resources/app.asar']});
if (process.argv.includes('--check-carry')) {
  assert(carry, 'CARRY_ROUND_REQUIRED');
  console.log(JSON.stringify({...carry,maximum,remaining:Object.fromEntries(Object.entries(maximum).map(([kind,total])=>[kind,total-carry.counts[kind]])),reusedTasks:preparationReuse?2:0}));
  process.exit(0);
}
execFileSync(process.execPath, ['scripts/validate-workspace.mjs', '--preflight'], { stdio: 'pipe' });
fs.mkdirSync(out, { mode: 0o700 });
const profileRoot = `/private/tmp/helpr-workspace-validation-${process.getuid()}`;
fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
assert.equal(fs.realpathSync(profileRoot), profileRoot);
const stat = fs.statSync(profileRoot);
assert(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'INVALID_PROFILE_ROOT');
const profile = preparationReuse?.profile ?? fs.mkdtempSync(profileRoot + (lifecycle ? '/lifecycle06-' : '/takeover04-'));
const evidence = {
  purpose: lifecycle ? 'lifecycle-06' : 'takeover-04',
  build, archive: manifest.hashes['Contents/Resources/app.asar'],
  scope: 'packaged local fixtures; no system credential or persistent website-session acceptance; tool input is not real IME/paste acceptance',
  credentials: 'in-process public fixture sentinel; system keychain not tested',
  started: new Date().toISOString(), carry, candidateReview, preparationReuse,
  limits: { minutes: 20, ...Object.fromEntries(Object.entries(maximum).map(([kind, total]) => [kind, total - (carry?.counts[kind] ?? 0)])) },
  realModelCalls: 0, remoteWrites: 0, taskAttempts: 0, effects: [], inputs: [], models: [], checkpoints: [], checks: [], deferred: {},
};
const write = (file, value) => {
  const target = path.join(out, file), temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
};
const save = () => write('result.json', evidence);
if (candidateReview) write('candidate.json', {...manifest,review:candidateReview});
const ownedGroups = new Set();
const ids = {}, held = [], holds = new Map(), pending = new Map(), pids = new Set(), humanSignals = new Map();
if(preparationReuse) {Object.assign(ids,preparationReuse.ids);for(const name of Object.keys(ids))holds.set(name,preparationReuse.initialCounts?.[name] ?? 0);write('ids.json',ids);}
let activeHuman, humanRun, humanAbort;
let storageReader, resourceTimer;
if (lifecycle) evidence.performance = {scope:"OS RSS sums and public IPC round trips; not paint latency",samples:[],commands:[]};
let gate, child, sequence = 0, busy = false, expired = false, poll, finishing;
const gates = () => gate ? Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, gate.state(id)])) : null;
function trace() {
  const value = gate?.traceRead?.();
  if (value) {
    write('native-trace.json', value);
    if (value.overflow) { evidence.fixtureFailure ??= 'NATIVE_TRACE_OVERFLOW'; save(); expired = true; queueMicrotask(() => void finish()); }
  }
  return value?.rows.length;
}
function reply(item) {
  item.receipt.releasedAt = Date.now();
  item.receipt.connectionClosed = item.res.destroyed;
  save();
  if (item.res.destroyed) return;
  item.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  item.res.write('data: ' + JSON.stringify({ id: 'local04', choices: [{ index: 0, delta: { content: JSON.stringify(item.value) }, finish_reason: null }] }) + '\n\n');
  item.res.end('data: ' + JSON.stringify({ id: 'local04', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
}
function release(name, holdNext) {
  if (holdNext === undefined) holds.delete(name); else holds.set(name, holdNext);
  for (let i = held.length - 1; i >= 0; i--)
    if (held[i].name === name) reply(held.splice(i, 1)[0]);
}
function trackPids() {
  if (!child?.pid) return;
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  pids.add(child.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
  }
  if (lifecycle) {
    evidence.processTree = rows.filter(([pid]) => pids.has(pid)).map(([pid,parent,group]) => ({pid,parent,group}));
    for (const [, , group] of rows.filter(([pid]) => pids.has(pid))) if (pids.has(group)) ownedGroups.add(group);
    evidence.ownedGroups = [...ownedGroups];
    save();
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function request(command, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (!child?.connected) { reject(Error('APPLICATION_EXITED')); return; }
    const id = ++sequence;
    const timer = ms === null ? undefined : setTimeout(() => { pending.delete(id); reject(Error('REQUEST_TIMEOUT')); }, ms);
    pending.set(id, { resolve, reject, timer, kind:command.kind, sentAt:Date.now() });
    child.send({ id, command });
  });
}
async function snapshot() { const value = await request({ kind: 'snapshot' }); write('snapshot.json', value); return value; }
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert(!expired, 'ROUND_TIME_LIMIT');
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('VALIDATION_WAIT_EXPIRED');
}
function check(name, condition) { assert(condition, name); evidence.checks.push({ name, at: Date.now(), passed: true }); save(); }
async function body(req) {
  let value = '';
  for await (const chunk of req) { value += chunk; assert(value.length < 200000, 'REQUEST_TOO_LARGE'); }
  return JSON.parse(value);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/clock') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({at:Date.now()})); return;
    }
    const humanSignal = url.pathname.match(/^\/human-stage\/([A-Z])$/);
    if (req.method === 'GET' && lifecycle && humanSignal) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(humanSignals.get(humanSignal[1]) ?? {phase:'idle',text:'本机输入核对尚未开始，请等待。'}));
      return;
    }
    const match = url.pathname.match(/^\/page\/([A-Z])$/);
    if (req.method === 'GET' && match) {
      const name = match[1];
      const initialCount=preparationReuse?.initialCounts?.[name] ?? 0;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${label} 任务 ${name}</title><style>body{font:20px -apple-system;padding:36px;color:#244135;background:#f4f8f5}button,input,a{font:inherit;padding:12px;margin:10px 0;display:block}input{width:400px}iframe{height:120px;width:440px}</style><h1>${label} 任务 ${name}</h1><p id="progress">${name} 自动完成 0</p><button id="advance">自动推进 ${name}</button><button id="manual">手动接管 ${name}</button>${lifecycle ? '<p id="human-status" role="status" style="max-width:520px"></p>' : ''}<input aria-label="人工文字" placeholder="接管后文字应保留"><button id="frame">加载子页面 ${name}</button><a id="popup" href="/popup/${name}" target="_blank">打开所属弹窗 ${name}</a><div id="slot"></div><p>本机虚构页面；不使用真实网站、账号或模型。</p><script>
      let count=${initialCount};const name=${JSON.stringify(name)};
      document.querySelector('#progress').textContent=name+' 自动完成 '+count;
      ${lifecycle ? `setInterval(async()=>{try{const s=await(await fetch('/human-stage/'+name,{cache:'no-store'})).json();const el=document.querySelector('#human-status');if(el.textContent!==s.text){el.textContent=s.text;el.style.color=s.phase==='armed'?'#087b32':'#5c665e';}}catch{}},250);` : ''}
      const clock=(async()=>{const sent=performance.timeOrigin+performance.now();const response=await fetch('/clock');const value=await response.json();return{sent,server:value.at,received:performance.timeOrigin+performance.now()};})();
      const send=async(route,data)=>{const clientWallAt=Date.now(),clientAt=performance.timeOrigin+performance.now();return fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,clientAt,clientWallAt,...data,clock:await clock})});};
      let moves=0;document.addEventListener('mousemove',e=>{if(moves++<8)send('/input',{kind:'mousemove',trusted:e.isTrusted,x:e.clientX,y:e.clientY});},true);
      for(const kind of ['mousedown','keydown','beforeinput','input','paste','compositionstart','compositionend'])document.addEventListener(kind,e=>{if(e.target.id!=='advance')send('/input',{kind,modifierOnly:kind==='keydown'&&['Meta','Shift','Control','Alt'].includes(e.key),keyCode:e.keyCode,isComposing:e.isComposing,inputType:e.inputType,target:e.target.id||e.target.tagName,trusted:e.isTrusted,clientAt:performance.timeOrigin+performance.now(),value:document.querySelector('input').value});},true);
      document.querySelector('#advance').onclick=()=>{count++;document.querySelector('#progress').textContent=name+' 自动完成 '+count;send('/effect',{count})};
      document.querySelector('#frame').onclick=()=>{document.querySelector('#slot').innerHTML='<iframe title="任务子页面" src="/frame/'+name+'"></iframe>'};
      send('/probe',{node:typeof process,require:typeof require,bridge:typeof window.workspace});
      </script></html>`);
      return;
    }
    if (req.method === 'GET' && /^\/(frame|popup)\/[A-Z]$/.test(url.pathname)) {
      const [kind, name] = url.pathname.slice(1).split('/');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${kind} ${name}</title><p>${name} 的${kind === 'frame' ? '子页面' : '所属弹窗'}</p><input aria-label="${kind} 人工文字"><button onclick="window.close()">关闭所属弹窗</button></html>`);
      return;
    }
    if (req.method === 'POST' && ['/probe', '/input', '/effect'].includes(url.pathname)) {
      const input = await body(req);
      assert(/^[A-Z]$/.test(input.name), 'INVALID_FIXTURE_NAME');
      const row = { ...input, at: Date.now(), gates: gates() };
      const list = url.pathname === '/effect' ? evidence.effects : evidence.inputs;
      // 导致越界的真实收件也必须保存，不能把页面已经发生的效果藏掉。
      const receipt = { route: url.pathname, ...row };
      list.push(receipt); save();
      receipt.traceLength = trace(); save();
      assert(list.length <= (list === evidence.effects ? evidence.limits.effects : evidence.limits.inputs), 'FIXTURE_LIMIT');
      assert(!finishing, 'ROUND_CLOSING');
      res.end('accepted'); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      // 先登记请求已到达；无效或越界请求同样不能从实际用量中消失。
      const receipt = { at: Date.now(), gates: gates() };
      evidence.models.push(receipt); save();
      assert(evidence.models.length <= evidence.limits.models, 'MODEL_FIXTURE_LIMIT');
      assert(!finishing, 'ROUND_CLOSING');
      const input = await body(req);
      const plan = input.messages.map((m) => { try { return JSON.parse(m.content); } catch { return null; } }).findLast((m) => m?.goal);
      const name = plan?.goal.match(new RegExp(label + ' ([A-Z])'))?.[1];
      assert(name && ids[name], 'PLANNING_ONLY');
      const text = input.messages.findLast(m=>m.role==='user' && m.content.startsWith('当前任务：') && m.content.includes('\n页面观察（'))?.content;
      assert(typeof text==='string','CURRENT_OBSERVATION_REQUIRED');
      const count = Number(text.match(new RegExp(name + ' 自动完成 (\\d+)'))?.[1]);
      assert(Number.isFinite(count) && count <= 2, 'OBSERVATION_REQUIRED');
      const fact = name + ' 自动完成 ' + count;
      const value = { decision: count === 2 ? 'complete' : 'act', summary: count === 2 ? '已核对本页两次推进。' : '推进本页下一步。', evidence: [fact], previous: plan.previous ? { id: plan.previous.id, status: count > 0 ? 'confirmed' : 'unknown', evidence: [fact] } : null, action: count === 2 ? null : { kind: 'click', target: { role: 'button', name: '自动推进 ' + name, exact: true } } };
      Object.assign(receipt, { name, count }); save();
      const item = { name, res, value, receipt };
      res.on('close', () => {
        receipt.closedAt = performance.timeOrigin + performance.now();
        receipt.closedWallAt = Date.now();
        // 高精度墙钟与CLOCK_REALTIME未经校准；用同一共享记录的位置核对先后。
        try { receipt.closedNative={traceLength:gate.traceRead().rows.length,gate:gate.state(ids[name])}; }
        catch(error) { receipt.closedNativeError=error.message; }
        save();
      });
      if (holds.get(name) === count) held.push(item); else reply(item);
      return;
    }
    res.writeHead(404); res.end();
  } catch (error) {
    evidence.fixtureFailure ??= error.code || error.message; save();
    res.writeHead(400); res.end('FIXTURE_REJECTED');
    expired = true;
    void finish();
  }
});
await new Promise((resolve,reject) => {server.once('error',reject);server.listen(preparationReuse?Number(new URL(preparationReuse.base).port):0, '127.0.0.1', resolve);});
const base = `http://127.0.0.1:${server.address().port}`;
if(preparationReuse) assert.equal(base,preparationReuse.base,'INPUT_PREPARATION_ORIGIN_CHANGED');
write('context.json', { built, profile, base }); save();
let budget;
try { budget = spend('starts'); }
catch (error) { server.close(); throw error; }
evidence.start = budget.used.starts;
const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const inputGateNamesBefore = new Set(fs.readdirSync(profile).filter(name=>/^\.input-gate-[0-9a-f-]+$/.test(name)));
const spawnedAt = Date.now();
child = spawn(path.join(built, 'Contents/MacOS/helpr'), ['--workspace-validation','--workspace-fixture'], { env: { ...env, HELPR_VALIDATION_DATA: profile, HELPR_FIXTURE_ORIGIN:base }, stdio: ['ignore', fs.openSync(path.join(out, 'stdout.log'), 'a', 0o600), fs.openSync(path.join(out, 'stderr.log'), 'a', 0o600), 'ipc'] });
child.on('message', (m) => {
  if (m.ready) { if (lifecycle) evidence.performance.readyMs = Date.now()-spawnedAt; evidence.ready = m; pids.add(m.hostPid); pids.add(m.recordsPid); save(); }
  const entry = pending.get(m.id);
  if (entry) { if (lifecycle && ['select','hide','snapshot'].includes(entry.kind) && evidence.performance.commands.length<200) evidence.performance.commands.push({kind:entry.kind,durationMs:Date.now()-entry.sentAt}); clearTimeout(entry.timer); pending.delete(m.id); m.error ? entry.reject(Error(m.error)) : entry.resolve(m.value); }
});
let deadline;
function finish() {
  finishing ??= closeRound();
  return finishing;
}
async function closeRound() {
  const end = Date.now() + 45000;
  clearTimeout(deadline); clearInterval(poll); clearInterval(resourceTimer);
  humanAbort?.abort(Error('ROUND_CLOSING'));
  if (humanRun) await humanRun;
  releaseStorage();
  if (storageReader) {
    const end=Date.now()+1000;
    while(storageReader.exitCode===null && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,20));
    if(storageReader.exitCode===null) { evidence.cleanupFailure='STORAGE_READER_DID_NOT_EXIT';process.exitCode=1; }
  }
  try { trace(); } catch (error) { evidence.traceFailure = error.message; save(); }
  try {
    trackPids();
    let accepted=false;
    while ((child.exitCode === null || [...pids].some(alive)) && Date.now() < end) {
      if (child.exitCode === null && !accepted) {
        try { await request({kind:'quit'},1500); accepted=true; }
        catch(error) {
          (evidence.quitReceipts??=[]).push({at:Date.now(),error:error.message});save();
          // 释放读锁后仍可能有正在保存的公开操作；只对此精确拒绝重试退出。
          if(error.message !== 'UNSAVED_CHANGES') accepted=true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    evidence.exitCode = child.exitCode;
    evidence.survivors = [...pids].filter(alive);
    if (lifecycle) {
      const rows = execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8',timeout:3000}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
      evidence.groupSurvivors = rows.filter(([, , group])=>ownedGroups.has(group));
      check('owned-process-groups-cleared',evidence.groupSurvivors.length===0);
    }
    check('normal-exit-and-no-owned-survivors', child.exitCode === 0 && evidence.survivors.length === 0);
  } catch (error) { evidence.cleanupFailure = error.message; process.exitCode = 1; }
  evidence.finished = new Date().toISOString(); save();
  server.closeAllConnections(); server.close();
}
child.once('exit', () => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('APPLICATION_EXITED')); }
  pending.clear();
});
try {
  await waitFor(() => evidence.ready);
  assert(evidence.ready.fixture === true && evidence.ready.fixtureSession?.persistent === false && evidence.ready.fixtureSession?.origin === base, 'LOCAL_FIXTURE_MODE_REQUIRED');
  trackPids();
  const files = fs.readdirSync(profile).filter((name) => /^\.input-gate-[0-9a-f-]+$/.test(name) && !inputGateNamesBefore.has(name));
  evidence.inputGateLineage={retained:[...inputGateNamesBefore],newCandidates:files};save();
  assert.equal(files.length, 1, 'ONE_NEW_NATIVE_INPUT_GATE_REQUIRED');
  gate = createRequire(import.meta.url)(path.join(built, 'Contents/Resources/input-bridge.node'));
  gate.open(path.join(profile, files[0]), false);
  // 只保存公开虚构哨兵；不再让接管测试依赖真人系统授权。
  evidence.phase = 'saving-local-fixture-configuration'; save();
  console.log('SAVING_LOCAL_FIXTURE_CONFIGURATION ' + out);
  const configurationVersion=preparationReuse?(await snapshot()).modelSettings?.version:0;
  await request({ kind: 'model-save', requestId: randomUUID(), expectedVersion: configurationVersion, protocol: 'chat-completions', endpoint: base + '/v1', model: 'controlled-local-04', apiKey: 'local-fixture-not-a-secret' }, 10000);
  if(preparationReuse) {
    const restored=await snapshot();
    if(preparationReuse.progress) {
      const a=restored.tasks.find(task=>task.id===ids.A)?.execution,b=restored.tasks.find(task=>task.id===ids.B)?.execution;
      assert(restored.tasks.length===2 && a?.phase==='paused' && a.pauseReason==='takeover' && a.intent==='automatic' && a.actions.length===0 && b?.phase==='complete' && b.actions.length===2 && b.actions.every(action=>action.status==='confirmed') && !a.recoveryPending && !b.recoveryPending && evidence.models.length===0 && evidence.effects.length===0,'INPUT_PROGRESS_RESTORE_MUST_PRESERVE_EXECUTIONS');
    } else assert(restored.tasks.length===2 && Object.values(ids).every(id=>restored.tasks.some(task=>task.id===id && !task.execution)) && evidence.models.length===0 && evidence.effects.length===0,'INPUT_PREPARATION_RESTORE_MUST_REMAIN_MANUAL');
  }
  evidence.phase = 'ready'; evidence.validationStarted = new Date().toISOString(); save();
  deadline = setTimeout(() => { expired = true; evidence.failure = 'ROUND_TIME_LIMIT'; save(); void finish(); }, evidence.limits.minutes * 60000);
  if (lifecycle) resourceTimer = setInterval(() => {
    try {
      trackPids();
      const rows=execFileSync('/bin/ps',['-axo','pid=,rss='],{encoding:'utf8',timeout:3000}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
      const rssKiB=rows.filter(([pid])=>pids.has(pid)).reduce((total,[,rss])=>total+rss,0);
      evidence.performance.samples.push({at:Date.now(),rssKiB,stage:activeHuman?.input ?? evidence.performance.stage ?? 'preparation'});
      if(evidence.performance.samples.length>420) evidence.performance.samples.shift();
      save();
    } catch(error) {evidence.performance.error=error.message;evidence.failure??='RESOURCE_SAMPLING_FAILED';save();void finish();}
  },3000);
  console.log('READY ' + out);
} catch (error) { evidence.failure = error.message; save(); await finish(); throw error; }
// 一次组合：真实记录事务等待提交期间，延迟暂停通知并释放两项已排队输入。
function releaseStorage() {
  if (storageReader && !storageReader.stdin.destroyed && !storageReader.stdin.writableEnded) storageReader.stdin.end('release\n');
}
async function beginTiming(job) {
  assert(!evidence.timing && ids[job.name] && ids[job.other] && job.name !== job.other, 'NEW_TIMING_PAIR_REQUIRED');
  spend('faults');
  const timing = evidence.timing = { name:job.name, other:job.other, startedAt:Date.now(), storage:[] };
  const status = () => request({kind:'validation-barrier',control:{action:'status'}});
  const releaseBarrier = (point,name) => request({kind:'validation-barrier',control:{action:'release',point,taskId:ids[name]}});
  const initial = await status();
  check('two-real-input-packets-waiting', [job.name,job.other].every(name=>initial.waits.some(w=>w.key === 'input:'+ids[name] && w.reached)));
  timing.before = {snapshot:await snapshot(),gates:gates(),traceLength:trace(),barriers:initial}; save();
  check('both-actions-live-before-storage', [job.name,job.other].every(name=>timing.before.snapshot.tasks.find(t=>t.id===ids[name])?.execution?.phase==='running' && timing.before.gates[name].available && !timing.before.gates[name].blocked));
  storageReader = spawn('python3', ['scripts/takeover-storage-reader.py',path.join(profile,'workspace.sqlite')], {stdio:['pipe','pipe','pipe']});
  timing.storagePid=storageReader.pid;save();
  let buffer='';
  storageReader.stdout.on('data',chunk=>{
    buffer+=chunk;
    for(let index;(index=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);timing.storage.push(JSON.parse(line));save();}
  });
  storageReader.on('error',error=>{timing.storageError=error.message;save();});
  storageReader.stdin.on('error',error=>{timing.storageError=error.message;save();});
  storageReader.stderr.on('data',chunk=>{timing.storageError=(timing.storageError??'')+chunk;save();});
  storageReader.on('exit',(code)=>{timing.storageExit=code;save();});
  await waitFor(()=>timing.storage.some(e=>e.stage==='reader-held'),2000);
  // 公开 draft 写入经过真正的记录事务；不在数据库中制造任务状态。
  const draft = request({kind:'draft',requestId:randomUUID(),taskId:ids[job.name],text:'04 slow commit timing'},10000).then(value=>{timing.draftAck={at:Date.now(),value};save();},error=>{timing.draftError=error.message;save();throw error;});
  void draft.catch(()=>{});
  await waitFor(()=>timing.storage.some(e=>e.stage==='writer-waiting'),2000);
  check('actual-commit-pending-before-input', !timing.draftAck && !timing.draftError);
  timing.readyAt=Date.now();save();
  void (async()=>{
    try {
      await waitFor(()=>evidence.inputs.some(row=>row.name===job.name && row.kind==='keydown' && row.at>=timing.readyAt),6000);
      const delayed=await status();
      check('pause-notification-still-delayed',delayed.waits.some(w=>w.key==='suspension:'+ids[job.name] && w.reached));
      check('commit-still-pending-at-web-receipt',!timing.draftAck && !timing.draftError && !timing.storage.some(e=>e.stage==='reader-released'));
      timing.receipt={at:Date.now(),gates:gates(),traceLength:trace(),barriers:delayed};save();
      await releaseBarrier('input',job.name);
      await releaseBarrier('input',job.other);
      await waitFor(()=>evidence.effects.some(row=>row.name===job.other),1500);
      check('other-effect-during-commit-wait',!timing.draftAck && !timing.draftError && !timing.storage.some(e=>e.stage==='reader-released'));
      check('revoked-task-no-effect',!evidence.effects.some(row=>row.name===job.name));
      timing.effects={at:Date.now(),gates:gates(),traceLength:trace()};save();
      await releaseBarrier('suspension',job.name);
      timing.notificationReleasedAt=Date.now();save();
      releaseStorage();
      await draft;
      await waitFor(()=>timing.storageExit===0,2000);
      check('reader-released-without-expiry',!timing.storage.some(e=>e.stage==='expired') && !timing.storageError);
      await waitFor(async()=>{const state=await snapshot();return state.tasks.find(t=>t.id===ids[job.name])?.execution?.phase==='paused';});
      timing.after={at:Date.now(),snapshot:await snapshot(),gates:gates(),traceLength:trace(),barriers:await status()};
      timing.finishedAt=Date.now();save();
    } catch(error) {timing.failure=error.message;evidence.failure??=error.message;save();await finish();}
  })();
  return {ready:true,at:timing.readyAt};
}
function beginHuman(job) {
  assert(lifecycle && ['ime','paste'].includes(job.input) && ids[job.name] && !activeHuman, 'HUMAN_STEP_REQUIRED');
  const visibleAcknowledgement=evidence.humanWindowReady;
  assert(visibleAcknowledgement && !visibleAcknowledgement.consumedAt && Date.now()-visibleAcknowledgement.at<30000,'HUMAN_WINDOW_ACKNOWLEDGEMENT_REQUIRED');
  assert(!job.other || (ids[job.other] && job.other !== job.name), 'HUMAN_OTHER_REQUIRED');
  assert(!(evidence.humanSteps ?? []).some(step=>step.input===job.input), 'HUMAN_STEP_ALREADY_ATTEMPTED');
  visibleAcknowledgement.consumedAt=Date.now();
  const step = {input:job.input,name:job.name,other:job.other,actor:'human',startedAt:Date.now(),phase:'preparation',intentId:randomUUID(),inputOffset:evidence.inputs.length,visibleAcknowledgement:{...visibleAcknowledgement}};
  (evidence.humanSteps ??= []).push(step); activeHuman=step;
  humanAbort=new AbortController(); const signal=humanAbort.signal;
  const checked=async fn=>{signal.throwIfAborted();const value=await fn();signal.throwIfAborted();return value;};
  const read=()=>checked(snapshot), send=command=>checked(()=>request(command));
  const until=(fn,ms)=>waitFor(()=>checked(fn),ms);
  humanSignals.set(job.name,{phase:'preparation',text:'准备：请点击下方输入框一次，然后留在这里等待绿色提示，先不输入。'}); save();
  humanRun=(async()=>{
    const own = state => state.tasks.find(task=>task.id===ids[job.name]);
    let preparation;
    await until(()=>{
      const rows=evidence.inputs.slice(step.inputOffset).filter(row=>row.name===job.name && row.kind!=='mousemove');
      assert(!rows.some(row=>['input','paste'].includes(row.kind)), 'HUMAN_INPUT_BEFORE_READY');
      preparation=rows.find(row=>row.kind==='mousedown' && row.target==='INPUT' && row.trusted===true);
      return Boolean(preparation);
    },90000);
    step.preparation=preparation;
    // 准备点击不属于正式样本；等待公开停止回执与稳定的阻断状态后才授予新资格。
    await send({kind:'execution-intent',taskId:ids[job.name],intent:'stop',requestId:randomUUID()});
    await until(async()=>{
      const state=await read(), task=own(state), ticket=gate.state(ids[job.name]);
      return task?.execution?.intent==='stopped' && task.executionControl?.stopSaved && ticket.available && ticket.blocked;
    },5000);
    step.prepared={at:Date.now(),snapshot:await read(),gates:gates(),traceLength:trace()}; save();
    holds.set(job.name,0);
    step.armSentAt=Date.now(); save();
    await send({kind:'execution-intent',taskId:ids[job.name],intent:'continue',requestId:step.intentId});
    if(job.other) await send({kind:'execution-intent',taskId:ids[job.other],intent:'start',requestId:randomUUID()});
    let current, model;
    await until(async()=>{
      current=await read(); const task=own(current), ticket=gate.state(ids[job.name]);
      assert(current.runtime.conditions.length===0, 'HUMAN_SYSTEM_NOT_READY');
      model=held.findLast(item=>item.name===job.name && item.receipt.at>=step.armSentAt && !item.res.destroyed && !item.receipt.closedAt && !item.receipt.releasedAt);
      const call=task?.messages.findLast(message=>message.call)?.call;
      const other=job.other && current.tasks.find(task=>task.id===ids[job.other]);
      const otherReady=!job.other || (other?.execution?.phase==='checking' && held.some(item=>item.name===job.other && !item.res.destroyed && !item.receipt.closedAt));
      if(task?.execution?.intentId!==step.intentId || task.execution.phase!=='checking' || !ticket.available || ticket.blocked || call?.phase!=='sending' || !model || !otherReady) return false;
      assert(Date.now()-model.receipt.at<20000, 'HUMAN_MODEL_TOO_OLD');
      step.callId=call.id; return true;
    },20000);
    step.armedAt=Date.now(); step.phase='armed';
    step.qualified={at:step.armedAt,inputOffset:evidence.inputs.length,snapshot:current,gates:gates(),traceLength:trace(),model:model.receipt};
    humanSignals.set(job.name,{phase:'armed',text:job.input==='ime'?'现在直接输入 a，选出“啊”上屏；不要再点击。完成后回 Codex 回复。':'现在直接按一次 ⌘V；不要再点击。完成后回 Codex 回复。'}); save();
    let releasedOther=false, committed;
    await until(async()=>{
      const rows=evidence.inputs.slice(step.qualified.inputOffset).filter(row=>row.name===job.name && row.kind!=='mousemove');
      assert(!rows.some(row=>row.kind==='mousedown'), 'HUMAN_EXTRA_CLICK');
      if(job.input==='ime') assert(!rows.some(row=>row.kind==='paste'), 'HUMAN_IME_WAS_PASTE');
      const first=rows.find(row=>!row.modifierOnly && ['keydown','beforeinput','paste','input'].includes(row.kind));
      if(!first) {
        const native=gate.traceRead().rows.slice(step.qualified.traceLength).find(row=>row.owner==='web:'+ids[job.name] && row.stage==='identified');
        // 正确的原生阻断会先取消模型，网页收件随后异步到达；不能把这段先后窗口误判为失败。
        if(native) assert(Date.now()-native.at<3000, 'HUMAN_WEB_RECEIPT_MISSING');
        else {
          const live=own(await read()), call=live?.messages.findLast(message=>message.call)?.call;
          const afterSnapshot=gate.traceRead().rows.slice(step.qualified.traceLength).some(row=>row.owner==='web:'+ids[job.name] && row.stage==='identified');
          assert(afterSnapshot || (live?.execution?.phase==='checking' && live.execution.intentId===step.intentId && call?.id===step.callId && call.phase==='sending' && !model.res.destroyed && !model.receipt.closedAt), 'HUMAN_MODEL_NO_LONGER_LIVE');
        }
      }
      if(first && job.other && !releasedOther) { release(job.other); releasedOther=true; step.otherReleasedAt=Date.now(); }
      committed=rows.find(row=>row.kind==='input' && row.target==='INPUT' && row.trusted && (job.input==='ime'?row.value.endsWith('啊'):row.value.includes('粘贴核对')));
      if(committed) {
        if(job.input==='paste') assert(rows.some(row=>row.kind==='paste' && row.trusted), 'HUMAN_PASTE_EVENT_REQUIRED');
        step.receipts=rows; return true;
      }
      return false;
    },30000);
    await until(async()=>{const task=own(await read());return task?.execution?.phase==='paused' && task.execution.pauseReason==='takeover' && task.executionControl?.stopSaved;},5000);
    assert(!evidence.effects.some(row=>row.name===job.name), 'HUMAN_REVOKED_TASK_EFFECT');
    if(job.other) await until(async()=>{const state=await read();return state.tasks.find(task=>task.id===ids[job.other])?.execution?.phase==='complete';},10000);
    const first=step.receipts.find(row=>!row.modifierOnly && ['keydown','beforeinput','paste','input'].includes(row.kind));
    assert(first?.trusted===true && first.target==='INPUT', 'HUMAN_TRUSTED_FIRST_OPERATION_REQUIRED');
    const rows=gate.traceRead().rows.slice(0,first.traceLength);
    // AppKit 不把单独的修饰键视为接管；Electron仍为每个keyDown写一个收件记号。
    // 只逐个跳过网页已证实的前置修饰键，首个真正操作缺少阻断仍必须失败。
    const modifierCount=step.receipts.slice(0,step.receipts.indexOf(first)).filter(row=>row.kind==='keydown' && row.modifierOnly).length;
    const prefix=rows.slice(step.qualified.traceLength).filter(row=>row.owner==='web:'+ids[job.name]);
    const delivered=prefix.filter(row=>row.stage==='web-before-input')[modifierCount];
    // 输入法可能绕过Electron的keyDown标记。仅首个真实操作明确属于组合输入、
    // 且首条网页收件前恰有唯一原生事件时采用AppKit交付证据；不挑后续合格事件。
    const compositionStart=step.receipts.slice(0,step.receipts.findIndex(row=>row.kind==='input')).some(row=>row.kind==='compositionstart' && row.trusted && row.target==='INPUT');
    const composition=job.input==='ime' && (first.isComposing===true || first.inputType==='insertCompositionText' || (first.keyCode===229 && compositionStart));
    assert(job.input!=='ime' || composition,'HUMAN_IME_FIRST_OPERATION_REQUIRED');
    const identifiedRows=prefix.filter(row=>row.stage==='identified');
    const compositionHandoff=!delivered && modifierCount===0 && composition && identifiedRows.length===1 && ['blocked','handoff'].every(stage=>prefix.filter(row=>row.stage===stage).length===1) && !prefix.some(row=>row.stage==='web-before-input');
    assert(delivered || compositionHandoff, 'HUMAN_NATIVE_DELIVERY_REQUIRED');
    const identified=compositionHandoff?identifiedRows[0]:rows.find(row=>row.owner===delivered.owner && row.serial===delivered.serial && row.stage==='identified');
    const blocked=rows.find(row=>row.owner===identified?.owner && row.serial===identified.serial && row.stage==='blocked');
    const handoff=rows.find(row=>row.owner===identified?.owner && row.serial===identified.serial && row.stage==='handoff');
    const deliveryAt=delivered?.at ?? first.clientWallAt;
    assert(Number.isFinite(deliveryAt) && identified && prefix.includes(identified) && blocked && handoff && identified.at<=blocked.at && blocked.at<=handoff.at && handoff.at<deliveryAt && blocked.epoch>step.qualified.gates[job.name].epoch && first.gates[job.name].blocked, 'HUMAN_NATIVE_ORDER_REQUIRED');
    if(model.receipt.closedAt) {
      const closed=model.receipt.closedNative;
      assert(!model.receipt.closedNativeError && Number.isSafeInteger(closed?.traceLength) && closed.traceLength>rows.indexOf(blocked) && closed.gate.available && closed.gate.blocked && closed.gate.epoch>=blocked.epoch,'HUMAN_MODEL_CLOSED_BEFORE_INPUT');
    }
    let after;
    await until(async()=>{
      after=await read();
      const call=own(after)?.messages.find(message=>message.call?.id===step.callId)?.call;
      if(!call || ['queued','sending'].includes(call.phase)) return false;
      assert(call.phase==='cancelled' && call.error==='MODEL_CANCELLED','HUMAN_INPUT_CANCELLED_CALL_REQUIRED');
      return true;
    },5000);
    step.nativeOrder={identified,blocked,handoff,...(delivered?{delivered}:{compositionReceipt:{kind:first.kind,at:first.at,clientWallAt:first.clientWallAt,traceLength:first.traceLength,keyCode:first.keyCode,isComposing:first.isComposing,inputType:first.inputType},method:'unique-AppKit-handoff-and-trusted-composition-receipt'})};
    step.after={at:Date.now(),snapshot:after,gates:gates(),traceLength:trace()};
    step.phase='complete'; step.finishedAt=Date.now();
    humanSignals.set(job.name,{phase:'complete',text:'本步记录完成。请回 Codex 回复，保留当前文字。'}); save();
  })().catch(async error=>{
    if(signal.aborted) {step.cancelledAt=Date.now();step.phase='cancelled';save();return;}
    step.failure=error.message; step.phase='failed'; evidence.failure??=error.message;
    humanSignals.set(job.name,{phase:'failed',text:'本步已停止，请回 Codex 查看结果，不再输入。'}); save();
    void finish();
  }).finally(()=>{activeHuman=undefined;});
  return {pending:step.input};
}
const allowed = new Set(['select', 'hide-task', 'minimize', 'execution-intent', 'snapshot', 'inspect', 'observe', 'show', 'panel', 'draft', 'reload', 'validation-fault', 'capture', 'validation-move']);
poll = setInterval(async () => {
  if (expired || finishing || busy || !fs.existsSync(path.join(out, 'command.json'))) return;
  busy = true; let job;
  try {
    job = JSON.parse(fs.readFileSync(path.join(out, 'command.json'))); fs.unlinkSync(path.join(out, 'command.json'));
    assert(!activeHuman || ['state','finish'].includes(job.kind), 'HUMAN_STEP_STILL_RUNNING');
    let value;
    if (job.kind === 'pair') {
      assert(Array.isArray(job.names) && job.names.length === 2 && job.names.every((n) => /^[A-Z]$/.test(n) && !ids[n]), 'NEW_PAIR_REQUIRED');
      assert(job.names[0] !== job.names[1] && [0, 1].includes(job.holdAt ?? 0), 'INVALID_PAIR');
      assert(evidence.taskAttempts + 2 <= evidence.limits.tasks, 'TASK_LIMIT');
      for (const [index, name] of job.names.entries()) {
        holds.set(name, index === 0 ? (job.holdAt ?? 0) : 0);
        evidence.taskAttempts++; save();
        const created = await request({ kind: 'create', requestId: randomUUID(), goal: `${label} ${name}，完成本页两次自动推进，保留人工文字 ${base}/page/${name}` });
        ids[name] = created.taskId;
        write('ids.json', ids);
      }
      await waitFor(async () => { const state = await snapshot(); return job.names.every((name) => state.tasks.find((t) => t.id === ids[name])?.phase === 'manual'); });
      await request({ kind: 'select', requestId: randomUUID(), taskId: ids[job.names[0]] });
      await request({ kind: 'show' });
      value = ids; write('ids.json', ids);
    } else if (job.kind === 'human-window-ready') {
      assert(lifecycle && job.userConfirmed===true && typeof job.reply==='string' && job.reply.length>0 && job.reply.length<=200,'HUMAN_VISIBLE_CONFIRMATION_REQUIRED');
      assert((await request({kind:'inspect'})).window?.visible===true,'HUMAN_WINDOW_NOT_VISIBLE');
      value={at:Date.now(),reply:job.reply}; evidence.humanWindowReady=value; save();
    }
    else if (job.kind === 'human-input') value=beginHuman(job);
    else if (job.kind === 'release') {
      assert(job.holdNext === undefined || [0,1,2].includes(job.holdNext), 'INVALID_NEXT_MODEL_HOLD');
      for (const name of job.names) release(name, job.holdNext);
      value = { released: job.names, holdNext: job.holdNext };
    }
    else if (job.kind === 'timing') {
      value = await beginTiming(job);
    }
    else if (job.kind === 'performance-stage') {
      assert(lifecycle && ['empty','two-tasks','active','settled','switching'].includes(job.stage), 'PERFORMANCE_STAGE_REQUIRED');
      evidence.performance.stage=job.stage;
      value={stage:job.stage,at:Date.now()}; (evidence.performance.stages??=[]).push(value); save();
    }
    else if (job.kind === 'state') value = { snapshot: await snapshot(), gates: gates(), traceLength: trace(), deferred: evidence.deferred, barriers: build > 22 ? await request({kind:'validation-barrier',control:{action:'status'}}) : undefined, held: held.map((item) => ({ name: item.name, count: item.receipt.count, closed: item.res.destroyed })) };
    else if (job.kind === 'native-check') {
      assert(typeof job.available === 'boolean' && typeof job.label === 'string', 'NATIVE_CHECK_REQUIRED');
      // 固定的诊断槽只读取全局能力，不创建业务任务或授予执行资格。
      value = {label:job.label,at:Date.now(),state:gate.state('validation-capability-probe')};
      (evidence.nativeChecks ??= []).push(value); save();
      check(job.label,value.state.available === job.available);
    }
    else if (job.kind === 'barrier') {
      assert(ids[job.name], 'TASK_REQUIRED');
      if (job.action === 'arm') spend('faults');
      value = await request({ kind: 'validation-barrier', control: { action: job.action, point: job.point, taskId: ids[job.name] } });
    }
    else if (job.kind === 'checkpoint') {
      value = { label: job.label, at: Date.now(), snapshot: await snapshot(), gates: gates(), traceLength: trace(), barriers: build > 22 ? await request({kind:'validation-barrier',control:{action:'status'}}) : undefined };
      if (lifecycle) value.window = (await request({kind:'inspect'})).window;
      evidence.checkpoints.push(value); save();
    } else if (job.kind === 'check') {
      const state = await snapshot();
      for (const [name, phase] of Object.entries(job.phases ?? {})) check(job.label + '-' + name + '-phase', state.tasks.find((t) => t.id === ids[name])?.execution?.phase === phase);
      for (const [name, counts] of Object.entries(job.effects ?? {})) check(job.label + '-' + name + '-effects', JSON.stringify(evidence.effects.filter((row) => row.name === name).map((row) => row.count)) === JSON.stringify(counts));
      for (const [name, reason] of Object.entries(job.reasons ?? {})) check(job.label + '-' + name + '-reason', state.tasks.find((t) => t.id === ids[name])?.execution?.pauseReason === reason);
      for (const [name, intent] of Object.entries(job.intents ?? {})) check(job.label + '-' + name + '-intent', state.tasks.find((t) => t.id === ids[name])?.execution?.intent === intent);
      value = { passed: true };
    } else if (job.kind === 'finish') { await finish(); value = { finished: true }; }
    else {
      assert(allowed.has(job.command?.kind), 'COMMAND_DENIED');
      const command = { ...job.command };
      if (job.name) { assert(ids[job.name], 'TASK_REQUIRED'); command.taskId = ids[job.name]; }
      if (command.kind === 'validation-fault') spend('faults');
      if (job.defer) {
        assert(typeof job.defer === 'string' && /^[a-z0-9-]{1,40}$/.test(job.defer) && !evidence.deferred[job.defer], 'NEW_DEFERRED_REQUIRED');
        assert(command.kind === 'execution-intent', 'DEFERRED_INTENT_ONLY');
        assert(job.allowError === undefined || ['INPUT_CHANGED_DURING_CONTINUE', 'RECORD_VERSION_CONFLICT', 'CONTROL_DISCONNECTED', 'NATIVE_INPUT_UNAVAILABLE'].includes(job.allowError), 'INVALID_EXPECTED_ERROR');
        const receipt = evidence.deferred[job.defer] = { command, sentAt: Date.now(), allowError: job.allowError }; save();
        void request(command, null).then((result) => { Object.assign(receipt, { finishedAt: Date.now(), result }); save(); }, (error) => {
          Object.assign(receipt, { finishedAt: Date.now(), error: error.message }); save();
          if (error.message !== job.allowError) { evidence.failure ??= error.message; expired = true; save(); void finish(); }
        });
        value = { pending: job.defer };
      } else value = await request(command);
    }
    write('response.json', { id: job.id, ok: true, value });
    if (job.kind !== 'finish' && job.kind !== 'timing') { await snapshot(); trackPids(); }
  } catch (error) {
    evidence.controlFailure = error.message; save();
    write('response.json', { id: job?.id, ok: false, error: error.message });
    await finish();
  } finally { busy = false; }
}, 100);
