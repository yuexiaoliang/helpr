import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import net from 'node:net';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),data=path.join(os.homedir(),'Library/Application Support/helpr Lifecycle Lab');
const output=path.join(root,'artifacts/baseline-checks.jsonl');if(fs.existsSync(output))throw Error('evidence-already-exists');
const log=row=>fs.appendFileSync(output,JSON.stringify({at:Date.now(),...row})+'\n');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function call(command){return new Promise((resolve,reject)=>{const c=net.connect(path.join(data,'private-control/lab.sock'),()=>c.write(JSON.stringify(command)+'\n'));let s='';c.on('data',b=>s+=b);c.on('end',()=>{const r=JSON.parse(s);log({command,...r});resolve(r);});c.on('error',reject);c.setTimeout(15000,()=>{c.destroy();reject(Error('timeout'));});});}
const result=async c=>{const r=await call(c);assert(r.ok,r.error);return r.result;};
const snapshot=()=>result({kind:'snapshot'});
try{
 const base=await snapshot();assert(base.ready&&base.packaged);assert(base.tasks.every(r=>r.counter===12&&r.intent==='completed'));log({check:'packaged-real-two-page-goal',pass:true});
 const credential=await result({kind:'credential'});assert(credential.ok&&!credential.plaintextOnDisk);
 const cookie=await result({kind:'cookie'});assert(cookie.ok);
 await result({kind:'backup'});
 for(const task of ['A','B'])await result({kind:'delegate',task,steps:16});
 assert(!(await call({kind:'prepare-update',to:'0.0.2',mode:'manual'})).ok);
 await wait(2000);await result({kind:'stop',task:'A'});await wait(700);const stopped=await snapshot();
 assert((await result({kind:'hide'})).visible===false);await wait(2200);const hidden=await snapshot();
 assert.equal(hidden.tasks[0].counter,stopped.tasks[0].counter);assert(hidden.tasks[1].counter>stopped.tasks[1].counter);log({check:'close-hides-stopped-A-stable-B-continues',pass:true});
 assert((await result({kind:'show'})).visible===true);
 await result({kind:'wait',task:'B'});await wait(700);const before=await snapshot();assert.equal(before.tasks[0].intent,'stopped');assert.equal(before.tasks[1].intent,'waiting');
 const pids=JSON.parse(fs.readFileSync(path.join(before.out,'pids.json')));await result({kind:'quit'});await wait(1500);
 for(const pid of Object.values(pids)){let alive=false;try{process.kill(pid,0);alive=true;}catch{}assert(!alive);}log({check:'normal-owner-exit',pass:true,pids});
 execFileSync(process.execPath,[path.join(root,'start.mjs'),'build-3']);await wait(1800);
 const reopened=await snapshot();assert(reopened.ready);assert.equal(reopened.tasks[0].intent,'stopped');assert.equal(reopened.tasks[1].intent,'waiting');assert.deepEqual(reopened.tasks.map(r=>r.counter),before.tasks.map(r=>r.counter));log({check:'cold-start-preserves-stop-and-wait',pass:true});
 assert((await result({kind:'credential'})).created===false);assert((await result({kind:'cookie'})).created===false);
 for(const task of ['A','B'])await result({kind:'continue',task});
 log({check:'explicit-continue-started-after-check',pass:true});
}catch(error){log({check:'baseline-suite',pass:false,error:error.stack});process.exitCode=1;}
