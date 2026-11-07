import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifySchedules({client,website,data,evidence,command,waitFor,check,launch,remainingOwned}) {
  let active=client;
  evidence.schedules={realModelCalls:0,remoteWrites:0,explicitContinuations:0};
  const dir=path.join(data,'reports');fs.mkdirSync(dir);
  const file=path.join(dir,'daily.xlsx');
  const original=fs.readFileSync('tests/workspace/fixtures/excel/report-a.xlsx');fs.writeFileSync(file,original);
  await active.request(command('model-save',{protocol:'chat-completions',expectedVersion:0,endpoint:website.base+'/v1',model:'fixture',apiKey:'local-fixture-not-a-secret'}));
  const owner=(await active.request(command('create',{goal:'在 '+website.base+'/new 整理定时发布要求'}))).taskId;
  const get=async(id=owner)=>(await active.request({kind:'snapshot'})).tasks.find(t=>t.id===id);
  await waitFor(async()=>(await get()).phase==='manual');
  await active.request(command('execution-intent',{taskId:owner,intent:'stop'}));
  const text=`从“${dir}”取唯一 xlsx，在 ${website.base}/new 的“公告”栏目，按“逐行列出项目和数量”自动发布，新内容另发，同内容一次`;
  await active.request(command('agreement-prepare',{taskId:owner,expectedVersion:(await get()).execution.version,text}));
  const agreement=(await get()).execution.agreements.at(-1);
  await active.request(command('agreement-accept',{taskId:owner,versionId:agreement.versionId}));
  const startAt=new Date(Date.now()+7000).toISOString();
  await active.request(command('message',{taskId:owner,text:`定时计划：从 ${startAt} 起，每隔60秒，时区 Asia/Shanghai，错过补最近一次，夏令时重复或不存在先问我。`}));
  const v=(await get()).execution.schedule.versions.at(-1);
  assert.equal(v.acceptedAt,null);assert.equal(v.terms.startAt,startAt);
  await active.request(command('message',{taskId:owner,text:'接受定时计划'}));
  const rounds=async(count)=>waitFor(async()=>{const s=(await get()).execution.schedule;return s.rounds.length>=count&&s;},75000);
  const first=await rounds(1),child=first.rounds[0].links[0].taskId;
  const guarded=async(id)=>waitFor(async()=>{
    const t=await get(id),e=t.execution;
    if(e.phase==='paused'&&e.pauseReason==='page-change'&&new URL(t.url).pathname==='/edit')return t;
    if(['unknown','failed'].includes(e.phase))throw Error(e.summary);
    return false;
  },55000);
  const firstTask=await guarded(child);
  check('到点后台创建真实网页并在导航归属变化处暂停，未代答继续',()=>{
    assert.equal(firstTask.execution.materials[0].sha256,createHash('sha256').update(original).digest('hex'));
    assert.equal(website.receipts.filter(r=>r.kind==='created').length,1);
    assert.equal(website.receipts.filter(r=>r.kind==='published').length,0);
  });
  await active.request(command('execution-intent',{taskId:child,intent:'stop'}));
  fs.renameSync(file,path.join(dir,'renamed.xlsx'));
  const second=await rounds(2);
  check('下一轮同内容改名仍指向原停止工作，不另开任务',()=>{
    assert.equal(second.rounds[1].links[0].taskId,child);
    assert.equal(second.rounds[1].links[0].created,false);
    assert.equal(website.receipts.filter(r=>r.kind==='created').length,1);
  });
  const changed=fs.readFileSync('tests/workspace/fixtures/excel/report-b.xlsx');fs.writeFileSync(path.join(dir,'renamed.xlsx'),changed);
  const third=await rounds(3),next=third.rounds[2].links[0].taskId;
  assert.notEqual(next,child);const nextTask=await waitFor(async()=>{const t=await get(next);return t.execution.coordination?.waitFor===child&&t;},15000);
  check('新合格素材在独立任务推进，旧停止意图和当前查看页保持',()=>{
    assert.equal(nextTask.execution.materials[0].sha256,createHash('sha256').update(changed).digest('hex'));
    assert.equal(website.receipts.filter(r=>r.kind==='created').length,1);
    assert.equal(website.receipts.filter(r=>r.kind==='published').length,0);
  });
  assert.equal((await get(child)).execution.intent,'stopped');
  assert.equal((await active.request({kind:'snapshot'})).active,owner);
  await active.request(command('message',{taskId:owner,text:'取消定时计划'}));
  const before=await active.request({kind:'snapshot'});
  assert.equal(before.tasks.find(t=>t.id===next).execution.intent,'stopped');
  evidence.schedules.before=before; evidence.schedules.limit='The original unknown creation retains a broad site claim; new material waits for that original task. This is not unattended publication acceptance.';
  await active.quit();assert.equal(remainingOwned().length,0);
  active=await launch();const after=await active.request({kind:'snapshot'});
  check('冷开保留已取消计划、三轮归属及停止意图，无重复网页效果',()=>{
    assert.deepEqual(after.tasks.find(t=>t.id===owner).execution.schedule,before.tasks.find(t=>t.id===owner).execution.schedule);
    assert.equal(after.tasks.length,3);assert.equal(website.receipts.filter(r=>r.kind==='created').length,1);
  });
  evidence.schedules.after=after;
  for(const t of after.tasks.filter(t=>t.url)){
    let previous,attempts=0;
    await waitFor(async()=>{
      if(++attempts>8)throw Error('SCHEDULE_COLD_READINESS_LIMIT');
      let dom;try{dom=await active.request({kind:'observe',taskId:t.id,method:'DOMSnapshot.captureSnapshot'});}
      catch(error){if(['PAGE_NOT_AVAILABLE','OBSERVATION_NOT_AUTHORIZED','STALE_OBSERVATION'].includes(error.message))return false;throw error;}
      const hash=createHash('sha256').update(JSON.stringify(dom.strings)).digest('hex');
      const stable=previous===hash;previous=hash;return stable;
    },15000);
  }
  await active.quit();
}
