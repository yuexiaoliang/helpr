import net from 'node:net';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
export const root=path.dirname(fileURLToPath(import.meta.url)),data=path.join(os.homedir(),'Library/Application Support/helpr Lifecycle Lab');
export const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function harness(name){
 const output=path.join(root,'artifacts',name+'.jsonl');if(fs.existsSync(output))throw Error('evidence-already-exists:'+name);
 const log=row=>fs.appendFileSync(output,JSON.stringify({at:Date.now(),...row})+'\n');
 const call=command=>new Promise((resolve,reject)=>{const c=net.connect(path.join(data,'private-control/lab.sock'),()=>c.write(JSON.stringify(command)+'\n'));let s='';c.on('data',b=>s+=b);c.on('end',()=>{const r=JSON.parse(s);log({command,...r});resolve(r);});c.on('error',reject);c.setTimeout(20000,()=>{c.destroy();reject(Error('timeout'));});});
 const result=async c=>{const r=await call(c);assert(r.ok,r.error);return r.result;};
 const until=async(predicate,ms=30000)=>{const end=Date.now()+ms;let state;do{state=await result({kind:'snapshot'});if(predicate(state))return state;await wait(800);}while(Date.now()<end);throw Error('state-deadline');};
 return {log,call,result,until};
}
