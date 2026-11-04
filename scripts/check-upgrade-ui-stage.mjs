import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validationRoot } from './workspace-budget.mjs';

// CUA会按路径打开不在运行的应用；每次连接前先独立确认仍是受管测试进程。
const [batch,stage]=process.argv.slice(2);
assert(/^upgrade09-(?:coordination|recovery)-41(?:-(?:version-resume|show-contract|tail))?$/.test(batch));
assert(/^[a-z-]+$/.test(stage));
const root=path.join(validationRoot,batch),file=path.join(root,'ui-context.json');
const context=JSON.parse(fs.readFileSync(file)),report=JSON.parse(fs.readFileSync(path.join(root,'result.json')));
assert.equal(context.stage,stage,'UI_STAGE_NOT_REACHED');
assert(Date.now()-fs.statSync(file).mtimeMs<90000,'UI_STAGE_TOO_OLD');
assert(!report.error&&!report.finished,'UI_ROUND_FINISHED');
const current=report.starts.at(-1);
assert(current.start===context.start&&!current.exit&&!current.duplicate,'CURRENT_MANAGED_START_REQUIRED');
const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return{pid:+m[1],parent:+m[2],command:m[3]};});
const by=new Map(rows.map(r=>[r.pid,r])),owner=by.get(current.pid),host=by.get(context.hostPid);
assert(owner&&owner.command.includes('/helpr.app/Contents/MacOS/helpr --workspace-validation'),'ISOLATED_OWNER_NOT_LIVE');
assert(host&&host.command.startsWith(context.hostApp+'/Contents/MacOS/helpr Workspace Helper '),'CURRENT_HOST_NOT_LIVE');
let cursor=host;while(cursor&&cursor.pid!==owner.pid)cursor=by.get(cursor.parent);
assert(cursor?.pid===owner.pid,'HOST_NOT_OWNED_BY_CURRENT_TEST');
console.log(JSON.stringify({guardedAt:Date.now(),...context,ownerPid:owner.pid,validationArgumentConfirmed:true}));
