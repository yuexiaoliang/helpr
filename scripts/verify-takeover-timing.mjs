// 对已结束原始材料作严格只读复核；缺失观察点和原失败保持，不追加运行。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validationRoot} from './workspace-budget.mjs';
const round=process.argv[2]?.match(/^--round=([a-z0-9-]{1,40})$/)?.[1];
assert(round && process.argv.length===3,'ROUND_REQUIRED');
const root=path.join(validationRoot,round);
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const result=read('result.json'), originalClient=read('final-client.json'), native=read('native-trace.json');
assert(result.finished && result.exitCode===0 && result.survivors.length===0 && !native.overflow,'FINISHED_CLEAN_SAMPLE_REQUIRED');
for(const key of ['failure','fixtureFailure','controlFailure','cleanupFailure','traceFailure'])assert(!result[key],`${key}:${result[key]}`);
assert.equal(originalClient.failure,'NATIVE_TO_PAGE_CAUSAL_ORDER');
assert(!native.rows.some(row=>row.stage==='web-before-input'),'THIS_REANALYSIS_REQUIRES_ABSENT_OBSERVER');
const t=result.timing, ids=originalClient.ids;
assert(t.finishedAt && !t.failure && t.storageExit===0 && !t.storageError && !t.draftError,'TIMING_MUST_HAVE_FINISHED');
assert(!t.storage.some(row=>row.stage==='expired'),'READER_MUST_NOT_EXPIRE');
const waiting=t.storage.find(row=>row.stage==='writer-waiting'),released=t.storage.find(row=>row.stage==='reader-released');
assert(waiting.independentReaderBusy && waiting.journalBytes>512 && waiting.at<t.readyAt,'REAL_PENDING_COMMIT_REQUIRED');
const events=result.inputs.filter(row=>row.name==='Y'&&row.kind==='keydown'&&row.at>=t.readyAt);
assert.equal(events.length,1,'ONE_KEY_RECEIPT_REQUIRED');
const receipt=events[0];
const indexed=native.rows.map((row,index)=>({...row,index}));
const identified=indexed.filter(row=>row.index>=t.before.traceLength&&row.stage==='identified');
assert.equal(identified.length,1,'ONE_NATIVE_KEY_REQUIRED');
const first=identified[0],serial=first.serial;
assert.equal(first.owner,'web:'+ids.Y);
const blocked=indexed.find(row=>row.serial===serial&&row.stage==='blocked');
const handoff=indexed.find(row=>row.serial===serial&&row.stage==='handoff');
assert(first.index<blocked.index&&blocked.index<handoff.index&&handoff.index<receipt.traceLength,'NATIVE_PREFIX_REQUIRED');
assert(blocked.epoch>t.before.gates.Y.epoch && receipt.gates.Y.epoch===blocked.epoch && receipt.gates.Y.blocked && !receipt.gates.Z.blocked,'REVOKED_EPOCH_AT_WEB_RECEIPT');
// 服务端取样处于页面发送、收到时刻之间；在稳定时基假设下只接受严格分离区间。
const {sent,server,received}=receipt.clock;
assert([sent,server,received,receipt.clientAt,receipt.clientWallAt].every(Number.isFinite)&&sent<=received,'CLOCK_SAMPLE_REQUIRED');
assert(Math.abs(receipt.clientAt-receipt.clientWallAt)<1,'WALL_CLOCK_MUST_AGREE_WITH_PAGE_CLOCK');
const offset=[server-received,server-sent],marginMs=2;
const interval=[receipt.clientAt+offset[0]-marginMs,receipt.clientAt+offset[1]+marginMs];
assert(interval[0]>handoff.at && receipt.at>=interval[0],'STRICT_FIRST_RECEIPT_ORDER_REQUIRED');
const denied=indexed.find(row=>row.index>=receipt.traceLength && row.stage==='permit-denied'&&row.owner===ids.Y&&row.epoch===t.before.gates.Y.epoch);
assert(denied,'OLD_PACKET_ACTUALLY_DENIED_AFTER_WEB_RECEIPT');
assert.deepEqual(result.effects.map(row=>[row.name,row.count]),[['Z',1]],'ONLY_Z_EFFECT_REQUIRED');
const effect=result.effects[0];
assert(effect.at<released.at&&receipt.at<released.at&&released.at<t.draftAck.at,'EFFECT_AND_INPUT_DURING_COMMIT_WAIT');
assert(t.receipt.barriers.waits.some(w=>w.key==='suspension:'+ids.Y&&w.reached),'SUSPENSION_MUST_STILL_BE_DELAYED');
const y=t.after.snapshot.tasks.find(row=>row.id===ids.Y),z=t.after.snapshot.tasks.find(row=>row.id===ids.Z);
assert(y.execution.phase==='paused'&&y.execution.pauseReason==='takeover'&&y.execution.intent==='automatic'&&y.executionControl.stopSaved&&z.execution.phase==='running','RELIABLE_INDEPENDENT_RESULT_REQUIRED');
const proof={
  checkedAt:new Date().toISOString(),round,build:result.build,start:result.start,archive:result.archive,passed:true,
  scope:'one native key under suspension IPC delay and actual SQLite PENDING commit wait; independent retrospective verification',
  sourceHashes:Object.fromEntries(['result.json','final-client.json','native-trace.json'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')])),
  originalClientFailure:originalClient.failure,absentObserver:'web-before-input',
  assumptions:['No wall-clock step between loopback calibration and the key event; page performance clock and server wall clock remain stable during this short sample.','Interval includes 2 ms extra margin for timestamp quantization; no strict conclusion if bounds overlap.'],
  clock:{sample:receipt.clock,pageClientAt:receipt.clientAt,pageWallAt:receipt.clientWallAt,offsetBoundsMs:offset,marginMs,firstDomReceiptBounds:interval,handoffToLowerBoundMs:interval[0]-handoff.at},
  native:{identified:first,blocked,handoff,denied},receipt,effect,
  storage:t.storage,draftAckAt:t.draftAck.at,
  after:{Y:{execution:y.execution,control:y.executionControl,gate:t.after.gates.Y},Z:{execution:z.execution,control:z.executionControl,gate:t.after.gates.Z}},
  cumulative:Object.fromEntries(['models','effects','inputs','tasks'].map(key=>[key,(result.carry.counts[key]??0)+(key==='tasks'?result.taskAttempts:result[key].length)])),
  exitCode:result.exitCode,survivors:result.survivors,storageExit:t.storageExit,
};
console.log(JSON.stringify(proof,null,2));
