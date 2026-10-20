// 仅复用启动87已完成的两项任务，用于零模型、零网页推进的界面和性能补验。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function readLifecycleCompleted({root,source,build,built,archive}, {filesystem=fs,alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}) {
  assert(source==='lifecycle-06-input-present' && build===34,'COMPLETED_SOURCE_REQUIRED');
  const read=file=>JSON.parse(filesystem.readFileSync(file));
  const digest=file=>createHash('sha256').update(filesystem.readFileSync(file)).digest('hex');
  const directory=path.join(root,source);
  const proof=read('docs/testing/evidence/lifecycle-06/PRESENT-COMPLETED-REUSE.json');
  assert(proof.source===source && Object.keys(proof.sourceFiles).sort().join(',')==='context.json,ids.json,result.json,snapshot.json','COMPLETED_SOURCE_FILES_REQUIRED');
  for(const [file,sha] of Object.entries(proof.sourceFiles)) assert.equal(digest(path.join(directory,file)),sha,'COMPLETED_SOURCE_CHANGED');
  const previous=read(path.join(directory,'result.json')),context=read(path.join(directory,'context.json')),ids=read(path.join(directory,'ids.json')),state=read(path.join(directory,'snapshot.json'));
  const accepted=read('docs/testing/evidence/lifecycle-06/PRESENT-CHECK.json');
  const parent=read('docs/testing/evidence/lifecycle-06/INPUT-KNOWN-REUSE.json');
  assert(previous.start===87 && previous.build===build && previous.archive===archive && accepted.artifacts['PRESENT-PACKAGED.json']===proof.sourceFiles['result.json'],'COMPLETED_CANDIDATE_REQUIRED');
  assert(previous.finished && previous.exitCode===0 && previous.survivors.length===0 && previous.groupSurvivors.length===0 && previous.processTree.every(row=>!alive(row.pid)) && proof.independentExit.allCleared===true && proof.independentExit.survivors.length===0 && proof.independentExit.normalExit===true,'COMPLETED_EXIT_REQUIRED');
  assert(!['failure','controlFailure','fixtureFailure','cleanupFailure','traceFailure','deadlineReachedAt'].some(key=>previous[key]),'COMPLETED_FAILURE_DENIED');
  assert(previous.carry.round==='lifecycle-06-input-known' && previous.preparationReuse.source===previous.carry.round && previous.preparationReuse.resultSHA256===parent.sourceFiles['result.json'] && proof.parentResultSHA256===parent.sourceFiles['result.json'],'COMPLETED_PARENT_REQUIRED');
  assert.deepEqual(previous.carry.counts,{tasks:8,models:29,effects:6,inputs:231},'COMPLETED_COUNTS_REQUIRED');
  assert(previous.taskAttempts===0 && previous.models.length===6 && previous.inputs.length===97 && previous.humanSteps.length===2 && previous.humanSteps.every(step=>step.phase==='complete') && previous.realModelCalls===0 && previous.remoteWrites===0,'COMPLETED_CONSUMPTION_REQUIRED');
  assert.deepEqual(previous.effects.map(row=>[row.name,row.count]),[['A',1],['A',2]],'COMPLETED_EFFECTS_REQUIRED');
  assert.deepEqual(proof.initialCounts,{A:2,B:2},'COMPLETED_SITE_STATE_REQUIRED');
  assert.equal(proof.nativeTraceSHA256,digest(path.join(directory,'native-trace.json')),'COMPLETED_TRACE_CHANGED');
  assert(read(path.join(directory,'native-trace.json')).overflow===false,'COMPLETED_TRACE_OVERFLOW');
  const temporaryRoot=`/private/tmp/helpr-workspace-validation-${process.getuid()}`;
  assert(context.built===built && path.dirname(context.profile)===temporaryRoot && context.profile.startsWith(temporaryRoot+'/lifecycle06-') && filesystem.realpathSync(temporaryRoot)===temporaryRoot && filesystem.realpathSync(context.profile)===context.profile,'COMPLETED_PROFILE_REQUIRED');
  const stat=filesystem.statSync(context.profile);
  assert(stat.uid===process.getuid() && (stat.mode&0o077)===0,'COMPLETED_PROFILE_OWNER_REQUIRED');
  const files=['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm'];
  assert.deepEqual(files.filter(file=>filesystem.existsSync(path.join(context.profile,file))).sort(),Object.keys(proof.profileFiles).sort(),'COMPLETED_DATABASE_FILES_CHANGED');
  assert(proof.profileFiles['workspace.sqlite'] && proof.audit.matchesSnapshot===true && proof.audit.matchesExecutionSnapshot===true && proof.audit.taskDifferences.length===0,'COMPLETED_DATABASE_AUDIT_REQUIRED');
  for(const [file,sha] of Object.entries(proof.profileFiles)) {
    assert(files.includes(file) && !filesystem.lstatSync(path.join(context.profile,file)).isSymbolicLink(),'COMPLETED_DATABASE_FILE_DENIED');
    assert.equal(digest(path.join(context.profile,file)),sha,'COMPLETED_DATABASE_CHANGED');
  }
  const origin=new URL(context.base);
  assert(origin.origin===context.base && origin.protocol==='http:' && origin.hostname==='127.0.0.1' && origin.port,'COMPLETED_LOCAL_ORIGIN_REQUIRED');
  assert(Object.keys(ids).sort().join(',')==='A,B' && state.tasks.length===2 && Object.entries(ids).every(([name,id])=>state.tasks.some(task=>task.id===id && task.url===context.base+'/page/'+name)),'COMPLETED_TASKS_REQUIRED');
  assert(state.tasks.every(task=>task.execution?.intent==='automatic' && task.execution.phase==='complete' && task.execution.actions.length===2 && task.execution.actions.every(action=>action.status==='confirmed') && !task.execution.recoveryPending),'COMPLETED_EXECUTIONS_REQUIRED');
  assert(state.modelSettings?.endpoint===context.base+'/v1' && state.modelSettings.model==='controlled-local-04' && state.modelSettings.version===6 && state.modelSettings.hasCredential,'COMPLETED_CONFIGURATION_REQUIRED');
  return {source,resultSHA256:proof.sourceFiles['result.json'],profile:context.profile,base:context.base,ids,initialCounts:proof.initialCounts,completed:true,configurationVersion:state.modelSettings.version,executions:Object.fromEntries(state.tasks.map(task=>[task.id,task.execution]))};
}
