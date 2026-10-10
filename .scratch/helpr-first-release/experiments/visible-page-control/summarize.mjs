import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=process.argv[2]||String(await readFile(path.join(root,'artifacts/latest.txt'))).trim();
const readLines=async name=>String(await readFile(path.join(dir,name))).trim().split('\n').filter(Boolean).map(JSON.parse);
const events=await readLines('events.jsonl');
let native=[];try{native=await readLines('electron-native.jsonl');}catch{}
const results=JSON.parse(await readFile(path.join(dir,'results.json')));
const counts={};
for(const e of events){
  if(!['dom-event','extension-event'].includes(e.kind))continue;
  const key=[e.task,e.stage,e.kind].join(' / ');
  const row=counts[key]??={};
  const kind=e.type+(e.isTrusted===undefined?'':` trusted=${e.isTrusted}`);
  row[kind]=(row[kind]||0)+1;
}
let stage='unmarked';const hooks={};
for(const e of native){
  if(e.kind==='marker'){stage=e.stage;continue;}
  if(!['before-input-event','before-mouse-event','input-event'].includes(e.kind))continue;
  const key=[stage,e.label].join(' / ');const row=hooks[key]??={};const kind=e.kind+':'+e.input.type;row[kind]=(row[kind]||0)+1;
}
const summary={directory:dir,results:results.results.map(({name,status,error})=>({name,status,error})),domAndExtension:counts,nativeHooks:hooks,humanDone:events.filter(e=>e.type==='human-done'),note:'样本采集成功不等于来源分类可靠；真人来源必须与用户实际参与记录核对。'};
await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
