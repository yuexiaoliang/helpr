// One owner, durable JSON record and revision / epoch guards. No site selectors or APIs.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {here,ensure,hash,log} from './common.mjs';
export class Store {
  constructor(out){
    this.out=out;fs.mkdirSync(path.join(here,'private'),{recursive:true});
    this.lock=new DatabaseSync(path.join(here,'private/owner.sqlite'));this.lock.exec('PRAGMA busy_timeout=500; CREATE TABLE IF NOT EXISTS lock(id INTEGER); BEGIN EXCLUSIVE');
    this.db=new DatabaseSync(path.join(here,'artifacts/state.sqlite'));this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identity(url TEXT PRIMARY KEY, task TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, epoch INTEGER); INSERT OR IGNORE INTO generations VALUES(1,0)');
    this.epoch=Number(this.db.prepare('UPDATE generations SET epoch=epoch+1 WHERE id=1 RETURNING epoch').get().epoch);
  }
  read(id){const r=this.db.prepare('SELECT record FROM tasks WHERE id=?').get(id);ensure(r,'unknown-task');return JSON.parse(r.record);}
  init(task){ensure(!this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(task.id),'task-exists');const r={task,taskHash:hash(task),revision:0,controlGeneration:0,intent:'running',phase:'new',navigations:[],artifacts:[],checkpoints:[],dispatches:[]};this.db.prepare('INSERT INTO tasks VALUES(?,?)').run(task.id,JSON.stringify(r));return r;}
  update(id,fn){this.db.exec('BEGIN IMMEDIATE');try{const r=this.read(id),next=fn(r);next.revision++;this.db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(next),id);this.db.exec('COMMIT');log(this.out,{kind:'record',task:id,revision:next.revision,epoch:this.epoch,phase:next.phase,intent:next.intent});return next;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  qualify(id){const r=this.read(id);for(const v of Object.values(r.task.inputs))if(v.type==='file')ensure(hash(fs.readFileSync(v.path))===v.sha256,'material-version');return {id,epoch:this.epoch,taskHash:r.taskHash,revision:r.revision,controlGeneration:r.controlGeneration};}
  check(q,{active=false,revision=false}={}){ensure(q?.epoch===this.epoch,'stale-epoch');const r=this.read(q.id);ensure(r.taskHash===q.taskHash,'wrong-task-version');if(active){ensure(r.intent==='running','intent-blocks-dispatch');ensure(q.controlGeneration===r.controlGeneration,'stale-control-generation');}if(revision)ensure(q.revision===r.revision,'stale-revision');return r;}
  request(q,op,data={}){
    this.check(q,{active:['dispatch','proposal'].includes(op),revision:op==='proposal'});
    if(op==='read')return this.read(q.id);
    return this.update(q.id,r=>{
      if(op==='navigation'){if(!r.navigations.some(n=>n.url===data.url))r.navigations.push(data);}
      else if(op==='artifact'){ensure(Object.values(r.task.inputs).some(v=>v.sha256===data.sha256),'artifact-not-selected');r.artifacts.push(data);}
      else if(op==='identity'){const owner=this.db.prepare('SELECT task FROM identity WHERE url=?').get(data.url);ensure(!owner||owner.task===q.id,'identity-owned-by-other-execution');ensure(r.navigations.some(n=>n.url===data.url),'identity-not-observed');this.db.prepare('INSERT OR IGNORE INTO identity VALUES(?,?)').run(data.url,q.id);r.editorUrl=data.url;r.identityProof=data;}
      else if(op==='checkpoint'){r.checkpoints.push({...data,taskHash:r.taskHash,epoch:this.epoch});if(data.phase)r.phase=data.phase;}
      else if(op==='dispatch'){ensure(!r.dispatches.some(d=>d.kind==='final'),'final-already-reserved');r.dispatches.push({...data,epoch:this.epoch});if(data.kind==='final')r.phase='uncertain';}
      else if(op==='intent'){ensure(['running','stopped','takeover','waiting','unknown-input'].includes(data.intent),'intent-value');r.intent=data.intent;r.controlGeneration++;}
      else if(op==='outcome'){r.lastOutcome=data;r.observedEffect=data.observedEffect;if(data.observedEffect==='completed')r.phase='completed';}
      else if(op==='proposal'){r.lastProposal=data;}
      else throw new Error('unknown-record-operation');
      return r;
    });
  }
  close(){this.db.close();this.lock.exec('ROLLBACK');this.lock.close();}
}
