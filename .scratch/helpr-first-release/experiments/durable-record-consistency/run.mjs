import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const here=path.dirname(fileURLToPath(import.meta.url));
const artifacts=path.join(here,'artifacts'); fs.mkdirSync(artifacts,{recursive:true});
const prior=fs.readdirSync(artifacts).filter(n=>/^run-\d+$/.test(n));
assert(prior.length<6,'Experiment run budget exhausted');
const runNumber=prior.length+1, out=path.join(artifacts,`run-${runNumber}`);
fs.mkdirSync(out); fs.mkdirSync(path.join(out,'source'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const sources=Object.fromEntries(['PLAN.md','candidate.mjs','owner.mjs','sink.mjs','caller.mjs','run.mjs'].map(name=>{
  const data=fs.readFileSync(path.join(here,name));fs.writeFileSync(path.join(out,'source',name),data);return[name,sha(data)];
}));
const json=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const children=new Set(), results=[]; let effectRequests=0, starts=0;
const started=Date.now(), smoke=process.argv.includes('--smoke');
const mode=smoke?'smoke':'full';
json(path.join(out,'manifest.json'),{started:new Date().toISOString(),mode,runNumber,sources,budgets:{runs:6,cases:60,effectRequests:120,seconds:180,bytes:300*1024*1024},modelCalls:0,remoteUploads:0,remotePublications:0});
const timer=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');json(path.join(out,'timeout.json'),{seconds:180});process.exit(2);},180000);

class RPC {
  constructor(module,args,dir) {
    this.pending=new Map();this.seq=0;this.events=[];this.dead=false;starts++;
    const child=this.child=fork(path.join(here,module),args,{stdio:['ignore','pipe','pipe','ipc']});children.add(child);
    const log=fs.createWriteStream(path.join(dir,`${module}-${starts}.log`));child.stdout.pipe(log);child.stderr.pipe(log,{end:false});
    this.ready=new Promise((resolve,reject)=>{
      const wait=setTimeout(()=>reject(new Error('READY_TIMEOUT')),8000);
      child.on('message',message=>{
        if(message.ready!==undefined){clearTimeout(wait);fs.appendFileSync(path.join(dir,'starts.jsonl'),JSON.stringify({pid:child.pid,module,time:Date.now(),...message})+'\n');resolve(message);}
        if(message.event){this.events.push(message.event);if(message.event.kind==='received'){effectRequests++;assert(effectRequests<=120,'effect budget');}}
        if(message.seq!==undefined){const p=this.pending.get(message.seq);if(p){this.pending.delete(message.seq);clearTimeout(p.wait);message.error?p.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):p.resolve(message.value);}}
      });
      child.on('error',reject);
      child.on('exit',(code,signal)=>{clearTimeout(wait);this.dead=true;children.delete(child);log.end();reject(new Error(`OWNER_EXIT ${code}/${signal}`));for(const p of this.pending.values()){clearTimeout(p.wait);p.reject(new Error(`OWNER_EXIT ${code}/${signal}`));}this.pending.clear();});
    });
  }
  ask(payload) {
    if(this.dead)return Promise.reject(new Error('OWNER_EXIT already exited'));
    const seq=++this.seq;
    return new Promise((resolve,reject)=>{const wait=setTimeout(()=>{this.pending.delete(seq);reject(new Error('RPC_TIMEOUT'));},12000);this.pending.set(seq,{resolve,reject,wait});this.child.send({seq,...payload});});
  }
  async kill() {if(this.dead)return;await new Promise(resolve=>{this.child.once('exit',resolve);this.child.kill('SIGKILL');});}
}

const settle=p=>p.then(value=>({ok:true,value}),error=>({ok:false,code:error.code,message:error.message}));
async function until(predicate) {const end=Date.now()+5000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('OBSERVATION_TIMEOUT');}
const command=(op,fields={})=>({id:randomUUID(),op,...fields});
const rejected=(promise,code)=>assert.rejects(promise,error=>code.test(`${error.code} ${error.message}`));

class Fixture {
  constructor(dir) {this.dir=dir;this.trace=[];this.owners=[];}
  async open() {
    fs.mkdirSync(this.dir,{recursive:true});
    this.sink=new RPC('sink.mjs',[path.join(this.dir,'effects.jsonl')],this.dir);
    this.endpoint=(await this.sink.ready).url;await this.restart();
    await this.call(command('flow',{flow:'F',version:'v1',body:{step:'submit'}}));
  }
  async restart() {
    if(this.owner)await this.owner.kill();
    this.owner=new RPC('owner.mjs',[this.dir,this.endpoint],this.dir);this.owners.push(this.owner);
    const ready=await this.owner.ready;assert.equal(ready.ready,true,JSON.stringify(ready));
    json(path.join(this.dir,'environment.json'),ready.environment);
  }
  async call(c) {
    this.trace.push({command:c.op,id:c.id,inputBytes:JSON.stringify(c).length,inputHash:sha(JSON.stringify(c))});
    try {const value=await this.owner.ask({command:c});this.trace.push({id:c.id,ok:true,output:c.op==='read'?'snapshot':value});return value;}
    catch(error){this.trace.push({id:c.id,ok:false,code:error.code,message:error.message});throw error;}
  }
  read(){return this.call({op:'read'});}
  async task(id){return(await this.read()).tasks.find(t=>t.id===id);}
  async material(text='素材版本一'){return(await this.call(command('material',{bytes:Buffer.from(text).toString('base64')}))).hash;}
  async selection(overrides={}){return command('select',{plan:'P',tick:'t1',agreement:'daily-v1',target:'A',material:await this.material(),period:'2026-10-12',content:'确认内容一',flow:'F',...overrides});}
  async seed(overrides={}){return(await this.call(await this.selection(overrides))).task;}
  async answerCommand(task){const s=await this.read();const p=s.participation.find(p=>p.task===task&&p.status==='open');assert(p);return command('answer',{request:p.id,version:p.version});}
  async confirm(task){return this.call(await this.answerCommand(task));}
  async claim(task){return(await this.call(command('claim',{task,revision:(await this.task(task)).revision}))).token;}
  async start(task){const token=await this.claim(task);const {action}=await this.call(command('reserve',{task,token}));return {task,token,action};}
  async perform(task){const params=await this.start(task);await this.call(command('perform',params));return params;}
  async intent(task,kind){return this.call(command('intent',{task,kind,revision:(await this.task(task)).revision}));}
  async reconcile(task){return this.call(command('reconcile',{task,revision:(await this.task(task)).revision}));}
  async crash(c,point){await this.owner.ask({fault:point});await rejected(this.call(c),/OWNER_EXIT/);await this.restart();}
  async fromProcess(c) {
    const child=fork(path.join(here,'caller.mjs'),[],{stdio:['ignore','ignore','ignore','ipc']});children.add(child);starts++;
    return new Promise((resolve,reject)=>{
      child.on('error',reject);child.on('exit',()=>children.delete(child));
      child.on('message',async m=>{if(m.command)child.send({result:await settle(this.call(m.command))});if(m.finished)resolve(m.finished);});
      child.send({start:true,command:c});
    });
  }
  async finish() {
    let state=null;try{if(!this.owner.dead)state=await this.read();}catch{}
    json(path.join(this.dir,'state.json'),state);json(path.join(this.dir,'trace.json'),this.trace);
    for(const owner of this.owners)await owner.kill();await this.sink.kill();
    if(state){assert.deepEqual(state.integrity,[{integrity_check:'ok'}]);assert.deepEqual(state.foreignKeys,[]);}
  }
  received(){return this.sink.events.filter(e=>e.kind==='received');}
  completed(){return this.sink.events.filter(e=>e.kind==='completed');}
}

async function scenario(name,body) {
  assert(results.length<60,'case budget');
  const number=results.length+1, f=new Fixture(path.join(out,`${String(number).padStart(2,'0')}-${name}`));
  const before=effectRequests, start=Date.now();let error;
  try{await f.open();await body(f);}catch(e){error=e;}
  finally{try{await f.finish();}catch(e){error??=e;}}
  results.push({name,passed:!error,error:error?{message:error.message,stack:error.stack}:null,effectRequests:effectRequests-before,elapsedMs:Date.now()-start});
  json(path.join(out,'results.json'),results);console.log(`${error?'FAIL':'PASS'} ${name}${error?': '+error.message:''}`);
}

try {
  await scenario('confirmation-dispatch-reopen',async f=>{
    const task=await f.seed();await rejected(f.claim(task),/NOT_CLAIMABLE/);
    const answer=await f.answerCommand(task);await f.call(answer);await f.call(answer);
    const params=await f.start(task), perform=command('perform',params);await f.call(perform);await f.call(perform);
    assert.equal(f.received().length,1);assert.equal((await f.reconcile(task)).progress,'done');
    await f.restart();assert.equal((await f.task(task)).progress,'done');assert.equal((await f.read()).confirmations.length,1);
  });
  if(!smoke) {
    for(const phase of ['before-commit','after-commit']) {
      const committed=phase==='after-commit';
      await scenario(`confirmation-${phase}`,async f=>{
        const task=await f.seed(), c=await f.answerCommand(task);await f.crash(c,`answer.${phase}`);
        assert.equal((await f.read()).confirmations.length,committed?1:0);
        assert.equal((await f.task(task)).intent,committed?'auto':'waiting');
        await f.call(c);await f.call({...c,id:randomUUID()});await f.perform(task);await f.reconcile(task);
        assert.equal(f.received().length,1);assert.equal((await f.read()).confirmations.length,1);
      });
      await scenario(`round-${phase}`,async f=>{
        const c=await f.selection();await f.crash(c,`select.${phase}`);
        assert.equal((await f.read()).tasks.length,committed?1:0);assert.equal((await f.read()).rounds.length,committed?1:0);
        const first=await f.call(c), duplicate=await f.call({...c,id:randomUUID()});assert.deepEqual(first,duplicate);
        assert.equal((await f.read()).tasks.length,1);assert.equal((await f.read()).rounds.length,1);assert.equal(f.received().length,0);
      });
      await scenario(`reservation-${phase}`,async f=>{
        const task=await f.seed();await f.confirm(task);const token=await f.claim(task);
        await f.crash(command('reserve',{task,token}),`reserve.${phase}`);
        assert.equal((await f.read()).actions.length,committed?1:0);assert.equal((await f.read()).confirmations.length,1);
        const fresh=await f.claim(task);await rejected(f.call(command('reserve',{task,token})),/STALE_RUN/);
        if(committed){await rejected(f.call(command('reserve',{task,token:fresh})),/RESULT_UNCERTAIN/);assert.equal((await f.reconcile(task)).progress,'unknown');}
        else {const {action}=await f.call(command('reserve',{task,token:fresh}));await f.call(command('perform',{task,token:fresh,action}));assert.equal((await f.reconcile(task)).progress,'done');}
        assert.equal(f.received().length,committed?0:1);
      });
      await scenario(`result-${phase}`,async f=>{
        const task=await f.seed();await f.confirm(task);await f.perform(task);
        const c=command('reconcile',{task,revision:(await f.task(task)).revision});await f.crash(c,`reconcile.${phase}`);
        let s=await f.read();assert.equal(s.receipts.length,committed?1:0);assert.equal(s.tasks[0].progress,committed?'done':'unknown');assert.equal(s.actions[0].stage,committed?'verified':'attempted');
        await f.call(c);s=await f.read();assert.equal(s.receipts.length,1);assert.equal(s.tasks[0].progress,'done');assert.equal(f.received().length,1);
      });
      await scenario(`flow-adoption-${phase}`,async f=>{
        const task=await f.seed();await f.confirm(task);await f.claim(task);
        await f.call(command('candidate',{flow:'F',version:'v2',parent:'v1',body:{step:'fixed'},evidence:'verified-fixture'}));
        const c=command('adopt',{version:'v2'});await f.crash(c,`adopt.${phase}`);
        assert.equal((await f.read()).flows[0].current,committed?'v2':'v1');assert.equal((await f.read()).candidates.length,2);
        await f.call(c);assert.equal((await f.task(task)).fixed_flow,'v1');
        const other=await f.seed({target:'B',tick:'t2'});assert.equal((await f.task(other)).fixed_flow,'v2');
      });
    }
    for(const point of ['perform.before-commit','perform.after-commit','perform.before-send','perform.after-effect']) {
      await scenario(point.replaceAll('.','-'),async f=>{
        const task=await f.seed();await f.confirm(task);const params=await f.start(task), c=command('perform',params);
        await f.crash(c,point);const expected=point==='perform.after-effect'?1:0;
        assert.equal(f.received().length,expected);assert.equal((await f.task(task)).progress,'unknown');
        if(point==='perform.before-commit')await rejected(f.call(c),/STALE_RUN/);else await f.call(c);
        assert.equal((await f.reconcile(task)).progress,expected?'done':'unknown');assert.equal(f.received().length,expected);
        if(!expected){const token=await f.claim(task);await rejected(f.call(command('reserve',{task,token})),/RESULT_UNCERTAIN/);}
      });
    }
    await scenario('two-callers-one-qualification',async f=>{
      const task=await f.seed();await f.confirm(task);const revision=(await f.task(task)).revision;
      const replies=await Promise.all([f.fromProcess(command('claim',{task,revision})),f.fromProcess(command('claim',{task,revision}))]);
      assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(replies.find(r=>!r.ok).code,'NOT_CLAIMABLE');
      const old=replies.find(r=>r.ok).value.token;await f.restart();const token=await f.claim(task);
      const stale=await f.fromProcess(command('reserve',{task,token:old}));assert.equal(stale.code,'STALE_RUN');
      const {action}=await f.call(command('reserve',{task,token}));await f.call(command('perform',{task,token,action}));assert.equal(f.received().length,1);
    });
    await scenario('third-qualification-waits-for-capacity',async f=>{
      const tasks=[];
      for(const [index,target] of ['A','B','C'].entries()){const task=await f.seed({target,tick:`t-${index}`});await f.confirm(task);tasks.push(task);}
      await f.claim(tasks[0]);await f.claim(tasks[1]);await rejected(f.claim(tasks[2]),/CAPACITY_UNAVAILABLE/);
      await f.intent(tasks[0],'stop');await f.claim(tasks[2]);const s=await f.read();assert.equal(s.tasks.filter(t=>t.active_run).length,2);
      assert.equal((await f.task(tasks[0])).intent,'stop');assert.equal(f.received().length,0);
    });
    for(const kind of ['takeover','unknown'])await scenario(`restart-preserves-${kind}-and-independent-continue`,async f=>{
      const a=await f.seed(),b=await f.seed({target:'B',tick:'t2'});await f.confirm(a);await f.confirm(b);
      await f.intent(a,kind);await f.intent(b,'stop');await f.restart();assert.equal((await f.task(a)).intent,kind);
      await rejected(f.claim(a),/NOT_CLAIMABLE/);await rejected(f.claim(b),/NOT_CLAIMABLE/);
      await f.intent(a,'continue');await f.perform(a);assert.equal((await f.task(b)).intent,'stop');assert.equal(f.received().length,1);
    });
    await scenario('duplicate-owner-and-cold-race',async f=>{
      const second=new RPC('owner.mjs',[f.dir,f.endpoint],f.dir);f.owners.push(second);assert.equal((await second.ready).error,'OWNER_BUSY');
      await f.owner.kill();
      const owners=[new RPC('owner.mjs',[f.dir,f.endpoint],f.dir),new RPC('owner.mjs',[f.dir,f.endpoint],f.dir)];f.owners.push(...owners);
      const ready=await Promise.all(owners.map(o=>o.ready));assert.equal(ready.filter(r=>r.ready).length,1);assert.equal(ready.find(r=>!r.ready).error,'OWNER_BUSY');
      f.owner=owners[ready.findIndex(r=>r.ready)];assert.equal((await f.read()).flows.length,1);
    });
    await scenario('parallel-effects-stop-a-b-continues',async f=>{
      const a=await f.seed(), b=await f.seed({target:'B',tick:'t2'});await f.confirm(a);await f.confirm(b);
      const pa=await f.start(a),pb=await f.start(b);await f.sink.ask({op:'hold',value:true});
      const sa=settle(f.call(command('perform',pa))),sb=settle(f.call(command('perform',pb)));
      await until(async()=> (await f.sink.ask({op:'stats'})).pending===2);
      await f.intent(a,'stop');await rejected(f.call(command('reserve',{task:a,token:pa.token})),/DISPATCH_CLOSED|STALE_RUN/);
      await f.sink.ask({op:'release'});assert.equal((await sa).ok,true);assert.equal((await sb).ok,true);
      await f.reconcile(a);await f.reconcile(b);assert.equal((await f.task(a)).intent,'stop');assert.equal((await f.task(b)).intent,'auto');
      assert.equal((await f.task(a)).progress,'done');assert.equal((await f.task(b)).progress,'done');assert.equal(f.received().length,2);
      const events=f.sink.events;assert(events.filter(e=>e.kind==='received').every(e=>e.time<=events.find(e=>e.kind==='completed').time));
    });
    await scenario('accepted-effect-survives-owner-death',async f=>{
      const task=await f.seed();await f.confirm(task);const params=await f.start(task);await f.sink.ask({op:'hold',value:true});
      const pending=settle(f.call(command('perform',params)));await until(()=>f.received().length===1);
      await f.restart();assert.equal((await pending).ok,false);assert.equal((await f.reconcile(task)).progress,'unknown');
      await f.sink.ask({op:'release'});assert.equal((await f.reconcile(task)).progress,'done');assert.equal(f.received().length,1);
    });
    await scenario('new-stop-during-reconciliation',async f=>{
      const task=await f.seed();await f.confirm(task);await f.perform(task);await f.sink.ask({op:'holdReads',value:true});
      const pending=settle(f.reconcile(task));await until(async()=> (await f.sink.ask({op:'stats'})).reads===1);
      await f.intent(task,'stop');await f.sink.ask({op:'releaseReads'});assert.equal((await pending).code,'REVISION_CONFLICT');
      assert.equal((await f.task(task)).intent,'stop');assert.equal((await f.read()).receipts.length,0);
      await f.reconcile(task);assert.equal((await f.task(task)).intent,'stop');assert.equal(f.received().length,1);
    });
    await scenario('accepted-confirmation-stop-continue-old-replay',async f=>{
      const task=await f.seed();const answer=await f.answerCommand(task);await f.call(answer);const oldToken=await f.claim(task);
      const stop=command('intent',{task,kind:'stop',revision:(await f.task(task)).revision});await f.call(stop);
      await f.restart();assert.equal((await f.task(task)).intent,'stop');await rejected(f.claim(task),/NOT_CLAIMABLE/);
      await f.intent(task,'continue');await f.call(stop);await f.call({...answer,id:randomUUID()});
      const token=await f.claim(task);await rejected(f.call(command('reserve',{task,token:oldToken})),/STALE_RUN/);
      const {action}=await f.call(command('reserve',{task,token}));await f.call(command('perform',{task,token,action}));
      assert.equal((await f.read()).confirmations.length,1);assert.equal(f.received().length,1);
    });
    await scenario('unanswered-request-stop-and-new-content',async f=>{
      const task=await f.seed(), old=await f.answerCommand(task);await f.intent(task,'stop');await f.intent(task,'continue');
      await rejected(f.call(old),/STALE_REPLY/);const before=await f.answerCommand(task);
      await f.call(command('content',{task,revision:(await f.task(task)).revision,content:'新的确认内容'}));
      await rejected(f.call(before),/STALE_REPLY/);await f.confirm(task);await f.perform(task);assert.equal(f.received().length,1);
      assert.equal((await f.read()).confirmations.length,1);
    });
    await scenario('same-request-different-input-rejected',async f=>{
      const task=await f.seed(), answer=await f.answerCommand(task);await f.call(answer);
      await rejected(f.call({...answer,version:'different'}),/REQUEST_CHANGED/);assert.equal((await f.read()).confirmations.length,1);assert.equal(f.received().length,0);
    });
    for(const status of ['waiting','stop','unknown','done']) await scenario(`later-round-preserves-${status}`,async f=>{
      const selection=await f.selection(),{task}=await f.call(selection);
      if(status==='stop')await f.intent(task,'stop');
      if(status==='unknown'||status==='done'){await f.confirm(task);const p=await f.start(task);if(status==='done'){await f.call(command('perform',p));await f.reconcile(task);}}
      const again=await f.call({...selection,id:randomUUID(),tick:'t2',sourcePath:'renamed/moved.xlsx'});assert.equal(again.task,task);
      for(const [index,change] of [{target:'B'},{period:'2026-10-13'},{repeat:'explicit-again'},{agreement:'other-agreement'},{material:await f.material('素材版本二')}].entries()) {
        const next=await f.call({...selection,...change,id:randomUUID(),tick:`new-${index}`});assert.notEqual(next.task,task);
      }
      await rejected(f.call({...selection,id:randomUUID(),target:'B'}),/ROUND_CHANGED/);
      assert.equal((await f.read()).tasks.length,6);assert.equal((await f.task(task)).intent,status==='stop'?'stop':status==='waiting'?'waiting':'auto');
      assert.equal((await f.task(task)).progress,['unknown','done'].includes(status)?status:'pending');assert.equal(f.received().length,status==='done'?1:0);
    });
    await scenario('competing-flow-candidates-preserved',async f=>{
      const a=await f.seed(),b=await f.seed({target:'B',tick:'t2'});await f.confirm(a);await f.confirm(b);await f.claim(a);await f.claim(b);
      const proposals=await Promise.all(['v2a','v2b'].map(version=>f.fromProcess(command('candidate',{flow:'F',version,parent:'v1',body:{step:version},evidence:'verified-fixture'}))));assert(proposals.every(p=>p.ok));
      const replies=await Promise.all(['v2a','v2b'].map(version=>f.fromProcess(command('adopt',{version}))));assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(replies.find(r=>!r.ok).code,'PARENT_CONFLICT');
      const s=await f.read();assert.equal(s.candidates.length,3);assert(s.runs.every(r=>r.flow_version==='v1'));assert(s.tasks.every(t=>t.fixed_flow==='v1'));
    });
    await scenario('unreferenced-material-after-interruption',async f=>{
      const c=command('material',{bytes:Buffer.from('尚未登记的素材').toString('base64')});await f.crash(c,'material.file-synced');
      assert.equal((await f.read()).materials.length,0);assert.equal(fs.readdirSync(path.join(f.dir,'materials')).length,1);
      await f.call(c);assert.equal((await f.read()).materials.length,1);assert.equal(f.received().length,0);
    });
    for(const damage of ['missing','changed']) await scenario(`referenced-material-${damage}`,async f=>{
      const task=await f.seed();await f.confirm(task);const token=await f.claim(task),t=await f.task(task),file=path.join(f.dir,'materials',t.material);
      if(damage==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,'外部变更');
      await rejected(f.call(command('reserve',{task,token})),damage==='missing'?/MATERIAL_MISSING/:/MATERIAL_CHANGED/);
      assert.equal((await f.read()).actions.length,0);assert.equal(f.received().length,0);
    });
    await scenario('material-write-failure-no-reference',async f=>{
      fs.renameSync(path.join(f.dir,'materials'),path.join(f.dir,'materials-original'));fs.writeFileSync(path.join(f.dir,'materials'),'blocked');
      await rejected(f.material(),/ENOTDIR/);assert.equal((await f.read()).materials.length,0);assert.equal((await f.read()).halted,true);assert.equal(f.received().length,0);
    });
    await scenario('stop-save-failure-memory-gate',async f=>{
      const task=await f.seed();await f.confirm(task);const p=await f.start(task);await f.owner.ask({fault:'readonly'});
      await rejected(f.intent(task,'stop'),/readonly/);assert.equal((await f.read()).halted,true);
      await rejected(f.call(command('perform',p)),/STORE_HALTED|DISPATCH_CLOSED/);assert.equal(f.received().length,0);
      await f.restart();assert.equal((await f.task(task)).intent,'auto');assert.equal((await f.task(task)).progress,'unknown');assert.equal(f.received().length,0);
    });
    await scenario('sqlite-full-no-partial-candidate',async f=>{
      await f.owner.ask({fault:'full'});
      await rejected(f.call(command('candidate',{flow:'F',version:'large',parent:'v1',body:'x'.repeat(1024*1024),evidence:'verified-fixture'})),/full/);
      const s=await f.read();assert.equal(s.candidates.length,1);assert.equal(s.halted,true);assert.equal(s.flows[0].current,'v1');assert.equal(f.received().length,0);
    });
    await scenario('optional-failure-and-required-evidence-missing',async f=>{
      const task=await f.seed();await f.confirm(task);await f.perform(task);await f.sink.ask({op:'hide',value:true});
      assert.equal((await f.reconcile(task)).progress,'unknown');assert.equal((await f.read()).receipts.length,0);
      await f.sink.ask({op:'hide',value:false});await f.reconcile(task);
      fs.mkdirSync(path.join(f.dir,'optional','screenshot.txt'));const result=await f.call(command('optional',{text:'optional fixture'}));
      assert.equal(result.saved,false);assert.equal((await f.task(task)).progress,'done');assert.equal(f.received().length,1);
    });
    await scenario('negative-control-sink-does-not-deduplicate',async f=>{
      const task=await f.seed();await f.confirm(task);const p=await f.start(task),t=await f.task(task);
      const value={action:p.action,task,material:t.material,version:t.content_version,target:t.target};
      for(let i=0;i<2;i++)await fetch(`${f.endpoint}/effect`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
      await until(()=>f.completed().length===2);assert.equal(f.received().length,2);assert.equal((await f.reconcile(task)).progress,'unknown');
    });
    // 与原冷启动故障相同的路径；只改变锁等待配置，不改变业务记录或判定。
    for(const waitMs of [0,250])for(let repeat=0;repeat<10;repeat++)await scenario(`startup-lock-${waitMs}ms-${repeat}`,async f=>{
      await f.owner.kill();
      const owners=[new RPC('owner.mjs',[f.dir,f.endpoint,String(waitMs)],f.dir),new RPC('owner.mjs',[f.dir,f.endpoint,String(waitMs)],f.dir)];
      f.owners.push(...owners);const ready=await Promise.all(owners.map(o=>o.ready));
      const winners=ready.filter(r=>r.ready).length;
      json(path.join(f.dir,'lock-probe.json'),{waitMs,repeat,winners,ready});
      assert(winners<=1,'multiple owners');
      for(const failed of ready.filter(r=>!r.ready)){assert.equal(failed.error,'OWNER_BUSY');assert.equal(failed.stage,'owner-lock');}
      if(waitMs===250)assert.equal(winners,1,'bounded wait must produce one owner');
      if(winners)f.owner=owners[ready.findIndex(r=>r.ready)];
    });
  }
} finally {
  clearTimeout(timer);for(const child of children)child.kill('SIGKILL');
  const totalBytes=dir=>fs.readdirSync(dir,{withFileTypes:true}).reduce((n,d)=>n+(d.isDirectory()?totalBytes(path.join(dir,d.name)):fs.statSync(path.join(dir,d.name)).size),0);
  const bytes=totalBytes(artifacts), passed=results.every(r=>r.passed)&&results.length>0;
  json(path.join(out,'summary.json'),{mode,cases:results.length,passed,failed:results.filter(r=>!r.passed).map(r=>r.name),effectRequests,childStarts:starts,elapsedMs:Date.now()-started,totalArtifactBytes:bytes,modelCalls:0,remoteUploads:0,remotePublications:0});
  console.log(JSON.stringify({runNumber,mode,cases:results.length,passed,effectRequests,artifact:out}));
  if(!passed||bytes>300*1024*1024)process.exitCode=1;
}
