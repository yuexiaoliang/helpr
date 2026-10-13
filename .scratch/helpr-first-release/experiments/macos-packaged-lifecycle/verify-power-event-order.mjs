// Replay OS event order through the actual controller handler and dispatch guard.
// Only the browser/SQLite side effects are replaced; no app build or OS event is created.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourceFile=path.resolve(process.argv[2]||path.join(root,'src/controller.mjs'));
const source=fs.readFileSync(sourceFile,'utf8');
const from=source.indexOf('    if(m.power)'),to=source.indexOf('    if(m.reply)',from);
assert(from>=0&&to>from,'actual controller power handler seam missing');
const handler=source.slice(from,to);
const tickFrom=source.indexOf('async function tick(task)'),tickTo=source.indexOf('async function close()',tickFrom);
assert(tickFrom>=0&&tickTo>tickFrom,'actual dispatch guard seam missing');
const gateSetup=source.match(/^const power = createPowerGate\(.+\);$/m)?.[0]||'';
const createPowerGate=gateSetup?(await import(pathToFileURL(path.join(path.dirname(sourceFile),'power-state.mjs')))).createPowerGate:null;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
  const observations=[],actions=[],pending=[];let held=false,fail=false;
  const connect=async task=>{observations.push(task);if(fail)throw Error('observation-failed');if(held){const d=deferred();pending.push(d);await d.promise;}};
  const job=async(task,op)=>{actions.push({task,op});return {counter:1};};
  const state=new Function('connect','job','createPowerGate',`
    let suspended=false,quitting=false,ready=true;
    const log=()=>{},status=()=>{},broker={revoke(){}},life={blocked:()=>false};
    const inflight=new Set(),connecting=new Set();
    const rows=()=>[{id:'A',intent:'running',phase:'verified',counter:0,goal:100}];
    const db={prepare:()=>({run(){}})};
    ${gateSetup}
    ${source.slice(tickFrom,tickTo)}
    return {event:async event=>{const m={power:event};${handler}},tick:()=>tick('A')};
  `)(connect,job,createPowerGate);
  return {...state,observations,actions,hold(){held=true;},release(){held=false;for(const d of pending.splice(0))d.resolve();},fail(){fail=true;},recover(){fail=false;}};
}
const checks=[];
async function check(name,run){try{await run();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:error.message});}}
await check('actual sleep → lock → resume remains blocked until unlock',async()=>{
  const f=fixture();for(const event of ['suspend','lock-screen','resume'])await f.event(event);
  await f.tick();assert.equal(f.actions.length,0,'new action dispatched while lock-screen still applies');
  assert.equal(f.observations.length,0,'do not reconnect while a power pause remains');
  await f.event('unlock-screen');await f.tick();assert.equal(f.actions.length,1);
  assert.deepEqual(f.observations,['A','B']);
});
await check('unlock before resume also remains blocked until both clear',async()=>{
  const f=fixture();for(const event of ['lock-screen','suspend','unlock-screen'])await f.event(event);
  await f.tick();assert.equal(f.actions.length,0);await f.event('resume');await f.tick();assert.equal(f.actions.length,1);
});
await check('new lock during asynchronous reconciliation invalidates its completion',async()=>{
  const f=fixture();await f.event('lock-screen');f.hold();const resume=f.event('unlock-screen');await settle();
  await f.event('lock-screen');f.release();await resume;await f.tick();assert.equal(f.actions.length,0,'old check released a newer lock');
  await f.event('unlock-screen');await f.tick();assert.equal(f.actions.length,1);
});
await check('rapid re-lock and unlock waits for a fresh reconciliation',async()=>{
  const f=fixture();await f.event('lock-screen');f.hold();const first=f.event('unlock-screen');await settle();
  await f.event('lock-screen');const second=f.event('unlock-screen');await settle();
  await f.tick();assert.equal(f.actions.length,0);f.release();await Promise.all([first,second]);await f.tick();
  assert.equal(f.actions.length,1);assert.equal(f.observations.length,4,'both tasks must be checked again after the newer lock');
});
await check('failed wake reconciliation remains blocked until a later successful check',async()=>{
  const f=fixture();await f.event('lock-screen');f.fail();await assert.rejects(f.event('unlock-screen'),/observation-failed/);
  await f.tick();assert.equal(f.actions.length,0);f.recover();await f.event('unlock-screen');await f.tick();assert.equal(f.actions.length,1);
});
await check('duplicate wake notifications do not start concurrent checks',async()=>{
  const f=fixture();await f.event('suspend');f.hold();const one=f.event('resume');await settle();const two=f.event('resume');await settle();
  assert.equal(f.observations.length,2);f.release();await Promise.all([one,two]);await f.tick();assert.equal(f.actions.length,1);
});
const powerFile=path.join(path.dirname(sourceFile),'power-state.mjs');
console.log(JSON.stringify({scope:'source replay; not packaged or real OS revalidation',source:sourceFile,sha256:createHash('sha256').update(source).digest('hex'),powerModuleSha256:gateSetup?createHash('sha256').update(fs.readFileSync(powerFile)).digest('hex'):null,checks},null,2));
if(checks.some(c=>!c.pass))process.exitCode=1;
