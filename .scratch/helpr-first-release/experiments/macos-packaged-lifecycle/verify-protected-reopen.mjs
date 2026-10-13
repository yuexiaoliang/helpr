// A same-version restart after authorization; not proof that an expired cookie survived an upgrade.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {harness,root,wait} from './harness.mjs';
const {log,result,until}=harness('protected-reopen-after-authorization');
try{
 const before=await until(s=>s.ready&&!s.maintenance&&s.tasks.every(t=>t.phase==='verified'&&t.intent!=='running'));
 const credential=await result({kind:'credential'}),cookie=await result({kind:'cookie'});assert(credential.ok&&!credential.created&&!credential.plaintextOnDisk);assert(cookie.ok&&!cookie.created);
 const pids=JSON.parse(fs.readFileSync(path.join(before.out,'pids.json')));
 const processRows=()=>execFileSync('/bin/ps',['-axo','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:Number(m[1]),parent:Number(m[2]),command:m[3]}));
 const processes=processRows(),owned=new Set([pids.controller,pids.host]);let changed=true;while(changed){changed=false;for(const p of processes)if(owned.has(p.parent)&&!owned.has(p.pid)){owned.add(p.pid);changed=true;}}
 log({kind:'owned-processes-before-quit',processes:processes.filter(p=>owned.has(p.pid))});
 await result({kind:'quit'});const end=Date.now()+20000;let alive;
 do{await wait(250);alive=processRows().filter(p=>owned.has(p.pid));}while(alive.length&&Date.now()<end);assert.equal(alive.length,0,'normal quit left owned processes');log({check:'authorized-normal-quit-cleans-owned-processes',pass:true,count:owned.size});
 const archive=path.join(root,'artifacts','run-'+path.basename(before.out));assert(!fs.existsSync(archive));fs.mkdirSync(archive);
 for(const name of fs.readdirSync(before.out))if(/\.(json|jsonl|log)$/.test(name))fs.copyFileSync(path.join(before.out,name),path.join(archive,name));
 execFileSync(process.execPath,[path.join(root,'start.mjs'),'build-6'],{stdio:'pipe'});
 const after=await until(s=>s.ready&&!s.maintenance);assert.equal(after.version,'0.0.2');assert(after.packaged);
 assert.deepEqual(after.tasks.map(t=>({id:t.id,intent:t.intent,counter:t.counter,goal:t.goal})),before.tasks.map(t=>({id:t.id,intent:t.intent,counter:t.counter,goal:t.goal})));
 const afterCredential=await result({kind:'credential'}),afterCookie=await result({kind:'cookie'});assert(afterCredential.ok&&!afterCredential.created&&!afterCredential.plaintextOnDisk);assert(afterCookie.ok&&!afterCookie.created);
 log({check:'same-version-reopen-preserves-current-cookie-original-secret-and-intent',pass:true,credential:afterCredential,cookie:afterCookie,tasks:after.tasks});
}catch(error){log({pass:false,error:error.stack});process.exitCode=1;}
