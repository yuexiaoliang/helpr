import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const load=f=>JSON.parse(fs.readFileSync(f,'utf8'));
export const save=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');};
export const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const ensure=(b,code,detail)=>{if(!b)throw Object.assign(new Error(code),{code,detail});};
export const log=(dir,v)=>fs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...v})+'\n');
export const limits={starts:24,preparation:6,upload:6,publication:3,externalEdit:1,modelCalls:12,tokens:140000,recovery:30,oracleReads:80,revisions:4};
export function reserve(kind,detail={}) {
  const file=path.join(here,'ledger.json'),l=fs.existsSync(file)?load(file):{limits,counts:{},events:[]};
  ensure(kind in limits,'unknown-budget');
  if(kind==='starts'&&!l.startedAt){l.startedAt=Date.now();l.deadline=l.startedAt+90*60000;}
  if(l.deadline)ensure(Date.now()<l.deadline,'experiment-time-budget');
  ensure((l.counts[kind]||0)<limits[kind],kind+'-budget');
  l.counts[kind]=(l.counts[kind]||0)+1;l.events.push({at:new Date().toISOString(),kind,...detail});save(file,l);return l.counts[kind];
}
export const candidateFiles=['broker.mjs','host.cjs','controller.mjs','worker.mjs','engine.mjs','store.mjs','common.mjs','model.mjs','flow.json'];
export function sources(){return Object.fromEntries(candidateFiles.map(f=>[f,hash(fs.readFileSync(path.join(here,f)))]));}
export function assertFrozen(){const f=load(path.join(here,'freeze.json'));ensure(hash(sources())===hash(f.sources),'frozen-source-changed');ensure(hash(load(path.join(here,'rules.json')))===f.rulesHash,'frozen-rules-changed');}
