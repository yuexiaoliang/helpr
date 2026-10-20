// 只复用06启动83的精确退出现场；不修改数据库或将旧资格当作当前资格。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function readLifecycleProgress({root,source,build,built,archive}, {filesystem=fs,alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}) {
  const read=file=>JSON.parse(filesystem.readFileSync(file));
  const digest=file=>createHash('sha256').update(filesystem.readFileSync(file)).digest('hex');
  assert(source==='lifecycle-06-input-verified' && build===34,'INPUT_PROGRESS_SOURCE_REQUIRED');
  const directory=path.join(root,source);
  const proof=read('docs/testing/evidence/lifecycle-06/INPUT-PROGRESS-REUSE.json');
  const failure=read('docs/testing/evidence/lifecycle-06/INPUT-IME-FAILURE.json');
  const parent=read('docs/testing/evidence/lifecycle-06/REUSE-GATE-FAILURE.json');
  assert(proof.source===source && Object.keys(proof.sourceFiles).sort().join(',')==='context.json,ids.json,result.json,snapshot.json','INPUT_PROGRESS_FILES_REQUIRED');
  for(const [file,sha] of Object.entries(proof.sourceFiles))
    assert.equal(digest(path.join(directory,file)),sha,'INPUT_PROGRESS_SOURCE_CHANGED');
  const previous=read(path.join(directory,'result.json'));
  const context=read(path.join(directory,'context.json'));
  const ids=read(path.join(directory,'ids.json'));
  const state=read(path.join(directory,'snapshot.json'));
  assert(proof.sourceFiles['result.json']===failure.resultSHA256 && previous.start===83 && previous.build===build && previous.archive===archive && previous.failure==='HUMAN_NATIVE_DELIVERY_REQUIRED' && !previous.controlFailure && !previous.fixtureFailure,'INPUT_PROGRESS_FAILURE_REQUIRED');
  assert(previous.carry.round==='lifecycle-06-input-ready' && previous.preparationReuse.source===previous.carry.round && previous.preparationReuse.resultSHA256===parent.resultSHA256,'INPUT_PROGRESS_PARENT_REQUIRED');
  assert(previous.finished && previous.exitCode===0 && previous.survivors.length===0 && previous.groupSurvivors.length===0 && previous.processTree.every(row=>!alive(row.pid)) && proof.independentExit.pidSurvivors.length===0 && proof.independentExit.groupSurvivors.length===0,'INPUT_PROGRESS_EXIT_REQUIRED');
  assert(previous.taskAttempts===0 && previous.models.length===4 && previous.effects.length===2 && previous.inputs.length===20 && previous.humanSteps.length===1 && previous.humanSteps[0].failure===previous.failure,'INPUT_PROGRESS_COUNTS_REQUIRED');
  assert.deepEqual(previous.effects.map(row=>[row.name,row.count]),[['B',1],['B',2]],'INPUT_PROGRESS_EFFECTS_REQUIRED');
  assert.deepEqual(proof.initialCounts,{A:0,B:2},'INPUT_PROGRESS_SITE_STATE_REQUIRED');
  const temporaryRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
  assert(context.built===built && path.dirname(context.profile)===temporaryRoot && context.profile.startsWith(temporaryRoot+'/lifecycle06-') && filesystem.realpathSync(temporaryRoot)===temporaryRoot && filesystem.realpathSync(context.profile)===context.profile,'INPUT_PROGRESS_PROFILE_REQUIRED');
  const stat=filesystem.statSync(context.profile);
  assert(stat.uid===process.getuid() && (stat.mode&0o077)===0,'INPUT_PROGRESS_PROFILE_OWNER_REQUIRED');
  const files=['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm'];
  assert.deepEqual(files.filter(file=>filesystem.existsSync(path.join(context.profile,file))).sort(),Object.keys(proof.profileFiles).sort(),'INPUT_PROGRESS_DATABASE_FILES_CHANGED');
  assert(proof.profileFiles['workspace.sqlite'] && proof.audit.matchesSnapshot===true,'INPUT_PROGRESS_DATABASE_REQUIRED');
  for(const [file,sha] of Object.entries(proof.profileFiles)) {
    assert(files.includes(file) && !filesystem.lstatSync(path.join(context.profile,file)).isSymbolicLink(),'INPUT_PROGRESS_FILE_DENIED');
    assert.equal(digest(path.join(context.profile,file)),sha,'INPUT_PROGRESS_DATABASE_CHANGED');
  }
  const origin=new URL(context.base);
  assert(origin.origin===context.base && origin.protocol==='http:' && origin.hostname==='127.0.0.1' && origin.port,'INPUT_PROGRESS_LOCAL_ORIGIN_REQUIRED');
  assert(Object.keys(ids).sort().join(',')==='A,B' && state.tasks.length===2 && Object.entries(ids).every(([name,id])=>state.tasks.some(task=>task.id===id && task.url===context.base+'/page/'+name)),'INPUT_PROGRESS_TASKS_REQUIRED');
  const a=state.tasks.find(task=>task.id===ids.A).execution;
  const b=state.tasks.find(task=>task.id===ids.B).execution;
  assert(a?.intent==='automatic' && a.phase==='paused' && a.pauseReason==='takeover' && a.actions.length===0 && b?.phase==='complete' && b.intent==='automatic' && b.actions.length===2 && b.actions.every(action=>action.status==='confirmed') && !a.recoveryPending && !b.recoveryPending,'INPUT_PROGRESS_EXECUTIONS_REQUIRED');
  assert(state.modelSettings?.endpoint===context.base+'/v1' && state.modelSettings.model==='controlled-local-04' && state.modelSettings.hasCredential && state.modelSettings.version>=2,'INPUT_PROGRESS_CONFIGURATION_REQUIRED');
  return {source,resultSHA256:proof.sourceFiles['result.json'],profile:context.profile,base:context.base,ids,initialCounts:proof.initialCounts,progress:true};
}
