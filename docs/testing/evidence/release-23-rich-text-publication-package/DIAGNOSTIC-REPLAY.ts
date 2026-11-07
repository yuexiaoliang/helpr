import {test,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {WorkspaceRecords} from '../../app/records/workspace';
test('实际291批准后进入规划复现',async()=>{
 const raw=JSON.parse(fs.readFileSync('.local/workspace-validation/run-1794040951135/result.json','utf8'));
 const sample=raw.richTextPublication.cases[0],task=sample.approval.state.tasks[0];
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'helpr-291-probe-'));
 fs.cpSync(raw.richTextPublication.profile,folder,{recursive:true});
 const records=new WorkspaceRecords(folder,'app/records/migrations');
 try{
  const db=new Database(path.join(folder,'workspace.sqlite'));
  db.prepare('update task_executions set body=? where task_id=?').run(JSON.stringify(task.execution),task.id);db.close();
  expect(()=>records.execution({kind:'claim',taskId:task.id,runId:'probe-291',session:task.execution.coordination.session})).not.toThrow();
  const material=task.execution.materials[0];
  await expect(records.material({kind:'verify',taskId:task.id,materialId:material.id,goalVersion:material.goalVersion})).resolves.toMatchObject({valid:true});
  expect(()=>records.model({kind:'begin',taskId:task.id,id:'probe-model',text:'核对本任务当前网页并提出下一步。',purpose:'execution',usageKind:'web-planning'})).not.toThrow();
 }finally{records.close();fs.rmSync(folder,{recursive:true,force:true});}
});
