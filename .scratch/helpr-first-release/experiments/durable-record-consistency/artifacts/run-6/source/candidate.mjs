// 实验用途：通过公共命令入口核对持久协议，不是产品存储实现。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const requireFact = (value, code) => { if (!value) throw new Refusal(code); };
const tables = ['materials', 'flows', 'candidates', 'tasks', 'rounds', 'participation', 'confirmations', 'runs', 'actions', 'receipts', 'requests'];

export class Records {
  constructor(root, endpoint, event, lockWaitMs = 250) {
    this.root = root; this.endpoint = endpoint; this.event = event;
    this.blocked = new Set(); this.halted = false; this.fault = null;
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, 'materials'), { recursive: true });
    fs.mkdirSync(path.join(root, 'optional'), { recursive: true });
    // 单独锁文件只承担进程拥有权；业务事务不在此连接中。
    this.guard = new DatabaseSync(path.join(root, 'owner-lock.sqlite'));
    try { this.guard.exec(`PRAGMA busy_timeout=${lockWaitMs}; BEGIN EXCLUSIVE;`); }
    catch (cause) {
      this.guard.close();
      const error=new Refusal(cause.errcode === 5 || cause.errcode === 6 ? 'OWNER_BUSY' : 'OWNER_LOCK_ERROR');
      error.stage='owner-lock';error.sqliteCode=cause.errcode;error.detail=cause.message;throw error;
    }
    this.db = new DatabaseSync(path.join(root, 'records.sqlite'));
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
      PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0);
      CREATE TABLE IF NOT EXISTS materials (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, current TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, flow TEXT NOT NULL REFERENCES flows(id), parent TEXT, body TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, work_key TEXT NOT NULL UNIQUE,
        material TEXT NOT NULL REFERENCES materials(hash), target TEXT NOT NULL, content TEXT NOT NULL,
        content_version TEXT NOT NULL, flow TEXT NOT NULL REFERENCES flows(id), fixed_flow TEXT NOT NULL,
        intent TEXT NOT NULL, revision INTEGER NOT NULL, progress TEXT NOT NULL, active_run TEXT);
      CREATE TABLE IF NOT EXISTS rounds (plan TEXT NOT NULL, tick TEXT NOT NULL, selection TEXT NOT NULL,
        task TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(plan,tick));
      CREATE TABLE IF NOT EXISTS participation (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
        version TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS confirmations (request TEXT PRIMARY KEY REFERENCES participation(id),
        task TEXT NOT NULL REFERENCES tasks(id), version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
        epoch INTEGER NOT NULL, revision INTEGER NOT NULL, flow_version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
        run TEXT NOT NULL REFERENCES runs(id), material TEXT NOT NULL REFERENCES materials(hash),
        content_version TEXT NOT NULL, target TEXT NOT NULL, stage TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (action TEXT PRIMARY KEY REFERENCES actions(id), evidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, input TEXT NOT NULL, output TEXT NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE; UPDATE meta SET epoch=epoch+1; UPDATE tasks SET active_run=NULL; COMMIT;');
    this.epoch = this.one('SELECT epoch FROM meta').epoch;
    this.environment = {
      node: process.version, platform: process.platform, arch: process.arch,
      sqlite: this.one('SELECT sqlite_version() AS version, sqlite_source_id() AS source'),
      pragmas: Object.fromEntries(['journal_mode','synchronous','fullfsync','foreign_keys'].map(p => [p, Object.values(this.one(`PRAGMA ${p}`))[0]])),
      compileOptions: this.all('PRAGMA compile_options'),
    };
    requireFact(canonical(this.environment.pragmas) === canonical({journal_mode:'delete',synchronous:3,fullfsync:1,foreign_keys:1}), 'CONFIGURATION');
  }
  one(sql, ...values) { return this.db.prepare(sql).get(...values); }
  all(sql, ...values) { return this.db.prepare(sql).all(...values); }
  write(sql, ...values) { return this.db.prepare(sql).run(...values); }
  hook(point) {
    if (this.fault === point) {
      this.event({type:'fault', point});
      process.kill(process.pid, 'SIGKILL');
    }
  }
  task(id) { const t = this.one('SELECT * FROM tasks WHERE id=?', id); requireFact(t, 'NO_TASK'); return t; }
  valid(t, token) {
    requireFact(!this.halted && !this.blocked.has(t.id), 'DISPATCH_CLOSED');
    const run = this.one('SELECT * FROM runs WHERE id=?', token ?? '');
    requireFact(run && t.active_run === run.id && run.task === t.id && run.epoch === this.epoch && run.revision === t.revision, 'STALE_RUN');
    requireFact(t.intent === 'auto' && t.progress !== 'done', 'NOT_AUTOMATIC');
    return run;
  }
  checkFile(hash) {
    const row = this.one('SELECT * FROM materials WHERE hash=?', hash);
    requireFact(row, 'NO_MATERIAL');
    let bytes; try { bytes = fs.readFileSync(path.join(this.root, 'materials', hash)); } catch { throw new Refusal('MATERIAL_MISSING'); }
    requireFact(bytes.length === row.size && digest(bytes) === hash, 'MATERIAL_CHANGED');
  }
  saveFile(bytes) {
    const hash = digest(bytes), dir = path.join(this.root, 'materials'), dest = path.join(dir, hash);
    if (!fs.existsSync(dest)) {
      const tmp = `${dest}.tmp-${randomUUID()}`;
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
      const parent = fs.openSync(dir, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    requireFact(digest(fs.readFileSync(dest)) === hash, 'MATERIAL_CHANGED');
    this.hook('material.file-synced');
    return {hash, size:bytes.length};
  }
  transaction(command, operation) {
    const input = canonical(command), prior = this.one('SELECT * FROM requests WHERE id=?', command.id);
    if (prior) { requireFact(prior.input === input, 'REQUEST_CHANGED'); return {value:JSON.parse(prior.output), replay:true}; }
    requireFact(!this.halted, 'STORE_HALTED');
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const value = operation();
      this.write('INSERT INTO requests VALUES (?,?,?)', command.id, input, JSON.stringify(value));
      this.hook(`${command.op}.before-commit`);
      this.db.exec('COMMIT'); committed = true;
      this.hook(`${command.op}.after-commit`);
      return {value, replay:false};
    } catch (error) {
      if (!committed) { try { this.db.exec('ROLLBACK'); } catch {} }
      if (!(error instanceof Refusal)) this.halted = true;
      throw error;
    }
  }
  read() {
    return {epoch:this.epoch, halted:this.halted, blocked:[...this.blocked],
      integrity:this.all('PRAGMA integrity_check'), foreignKeys:this.all('PRAGMA foreign_key_check'),
      ...Object.fromEntries(tables.map(name => [name,this.all(`SELECT * FROM ${name} ORDER BY rowid`)]))};
  }
  inject(fault) {
    if (fault === 'readonly') this.db.exec('PRAGMA query_only=ON');
    else if (fault === 'full') this.db.exec(`PRAGMA max_page_count=${this.one('PRAGMA page_count').page_count}`);
    else this.fault = fault;
  }
  async execute(c) {
    if (c.op === 'read') return this.read();
    requireFact(typeof c.id === 'string', 'REQUEST_REQUIRED');
    const old = this.one('SELECT * FROM requests WHERE id=?',c.id);
    if (old) { requireFact(old.input === canonical(c),'REQUEST_CHANGED'); return JSON.parse(old.output); }
    if (c.op === 'optional') {
      try { fs.writeFileSync(path.join(this.root,'optional','screenshot.txt'),c.text,{flag:'wx'}); return {saved:true}; }
      catch (error) { this.event({type:'optional-missing',code:error.code}); return {saved:false,reason:error.code}; }
    }
    // 停止信号先关闭内存派发入口，持久化失败也不重新开放。
    if (c.op === 'intent' && c.kind !== 'continue') this.blocked.add(c.task);
    let material;
    if (c.op === 'material') {
      try { material = this.saveFile(Buffer.from(c.bytes, 'base64')); }
      catch (error) { this.halted = true; throw error; }
    }
    let observation;
    if (c.op === 'reconcile') {
      const t = this.task(c.task);
      requireFact(c.revision === t.revision, 'REVISION_CONFLICT');
      // 接收端的独立查询只用于本实验，网站恢复规则不是这里形成的。
      observation = await (await fetch(`${this.endpoint}/effects`)).json();
    }
    const result = this.transaction(c, () => {
      switch (c.op) {
        case 'material': {
          this.write('INSERT OR IGNORE INTO materials VALUES (?,?)', material.hash, material.size); return material;
        }
        case 'flow': {
          this.write('INSERT INTO flows VALUES (?,?)', c.flow, c.version);
          this.write('INSERT INTO candidates VALUES (?,?,?,?,?)', c.version,c.flow,null,canonical(c.body),'fixture-initial');
          return {version:c.version};
        }
        case 'select': {
          this.checkFile(c.material);
          const selection = canonical({agreement:c.agreement,target:c.target,material:c.material,period:c.period,repeat:c.repeat ?? null});
          const round = this.one('SELECT * FROM rounds WHERE plan=? AND tick=?', c.plan,c.tick);
          if (round) { requireFact(round.selection === selection,'ROUND_CHANGED'); return {task:round.task}; }
          let task = this.one('SELECT * FROM tasks WHERE work_key=?', selection);
          if (!task) {
            const flow = this.one('SELECT * FROM flows WHERE id=?', c.flow); requireFact(flow,'NO_FLOW');
            const id = randomUUID(), version = digest(c.content), request = randomUUID();
            this.write('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id,selection,c.material,c.target,c.content,version,c.flow,flow.current,'waiting',0,'pending',null);
            this.write('INSERT INTO participation VALUES (?,?,?,?)',request,id,version,'open');
            task = this.task(id);
          }
          this.write('INSERT INTO rounds VALUES (?,?,?,?)', c.plan,c.tick,selection,task.id);
          return {task:task.id};
        }
        case 'answer': {
          const request = this.one('SELECT * FROM participation WHERE id=?',c.request); requireFact(request,'NO_REQUEST');
          requireFact(request.version === c.version,'CONTENT_CHANGED');
          const accepted = this.one('SELECT * FROM confirmations WHERE request=?',c.request);
          if (accepted) return {accepted:true,task:request.task};
          const t = this.task(request.task);
          requireFact(request.status === 'open' && t.content_version === c.version && t.intent === 'waiting','STALE_REPLY');
          this.write('INSERT INTO confirmations VALUES (?,?,?)',c.request,t.id,c.version);
          this.write("UPDATE participation SET status='accepted' WHERE id=?",c.request);
          this.write("UPDATE tasks SET intent='auto',revision=revision+1 WHERE id=?",t.id);
          return {accepted:true,task:t.id};
        }
        case 'intent': {
          const t = this.task(c.task); requireFact(t.revision === c.revision,'REVISION_CONFLICT');
          requireFact(['stop','takeover','unknown','continue'].includes(c.kind),'BAD_INTENT');
          const intent = c.kind === 'continue' ? (this.one('SELECT * FROM confirmations WHERE task=? AND version=?',t.id,t.content_version) ? 'auto':'waiting') : c.kind;
          this.write('UPDATE tasks SET intent=?, revision=revision+1,active_run=NULL WHERE id=?',intent,t.id);
          this.write("UPDATE participation SET status='revoked' WHERE task=? AND status='open'",t.id);
          if (intent === 'waiting') this.write('INSERT INTO participation VALUES (?,?,?,?)',randomUUID(),t.id,t.content_version,'open');
          return {intent,revision:t.revision+1};
        }
        case 'content': {
          const t = this.task(c.task); requireFact(t.revision === c.revision,'REVISION_CONFLICT');
          requireFact(!this.one('SELECT * FROM actions WHERE task=?',t.id),'RESULT_UNCERTAIN');
          const version=digest(c.content);
          this.write("UPDATE tasks SET content=?,content_version=?,intent='waiting',revision=revision+1,active_run=NULL WHERE id=?",c.content,version,t.id);
          this.write("UPDATE participation SET status='revoked' WHERE task=? AND status='open'",t.id);
          this.write('INSERT INTO participation VALUES (?,?,?,?)',randomUUID(),t.id,version,'open');
          return {version};
        }
        case 'claim': {
          const t = this.task(c.task); requireFact(t.revision === c.revision,'REVISION_CONFLICT');
          requireFact(t.intent === 'auto' && t.progress !== 'done' && !t.active_run && !this.blocked.has(t.id),'NOT_CLAIMABLE');
          requireFact(this.one('SELECT count(*) AS active FROM tasks WHERE active_run IS NOT NULL').active < 2,'CAPACITY_UNAVAILABLE');
          const token=randomUUID();
          this.write('INSERT INTO runs VALUES (?,?,?,?,?)',token,t.id,this.epoch,t.revision,t.fixed_flow);
          this.write('UPDATE tasks SET active_run=? WHERE id=?',token,t.id); return {token,flow:t.fixed_flow};
        }
        case 'reserve': {
          const t=this.task(c.task); this.valid(t,c.token); this.checkFile(t.material);
          requireFact(this.one('SELECT * FROM confirmations WHERE task=? AND version=?',t.id,t.content_version),'UNCONFIRMED');
          requireFact(!this.one('SELECT * FROM actions WHERE task=?',t.id),'RESULT_UNCERTAIN');
          const action=randomUUID();
          this.write('INSERT INTO actions VALUES (?,?,?,?,?,?,?)',action,t.id,c.token,t.material,t.content_version,t.target,'reserved');
          this.write("UPDATE tasks SET progress='unknown' WHERE id=?",t.id); return {action};
        }
        case 'perform': {
          const t=this.task(c.task); this.valid(t,c.token); this.checkFile(t.material);
          const a=this.one('SELECT * FROM actions WHERE id=?',c.action);
          requireFact(a && a.task === t.id && a.run === c.token && a.stage === 'reserved','ALREADY_ATTEMPTED');
          this.write("UPDATE actions SET stage='attempted' WHERE id=?",a.id); return {action:a.id};
        }
        case 'reconcile': {
          const t=this.task(c.task); requireFact(t.revision === c.revision,'REVISION_CONFLICT');
          const a=this.one('SELECT * FROM actions WHERE task=?',t.id);
          if (!a) return {progress:t.progress};
          const matches=observation.filter(o => o.kind === 'completed' && o.action === a.id && o.task === t.id && o.material === a.material && o.version === a.content_version && o.target === a.target);
          if (matches.length !== 1) return {progress:'unknown'};
          this.write('INSERT OR IGNORE INTO receipts VALUES (?,?)',a.id,canonical(matches[0]));
          this.write("UPDATE actions SET stage='verified' WHERE id=?",a.id);
          this.write("UPDATE tasks SET progress='done',active_run=NULL WHERE id=?",t.id);
          return {progress:'done',intent:t.intent};
        }
        case 'candidate': {
          requireFact(c.evidence === 'verified-fixture','UNVERIFIED_CANDIDATE');
          this.write('INSERT INTO candidates VALUES (?,?,?,?,?)',c.version,c.flow,c.parent,canonical(c.body),c.evidence);
          return {version:c.version};
        }
        case 'adopt': {
          const v=this.one('SELECT * FROM candidates WHERE id=?',c.version); requireFact(v,'NO_CANDIDATE');
          const f=this.one('SELECT * FROM flows WHERE id=?',v.flow); requireFact(v.parent === f.current,'PARENT_CONFLICT');
          this.write('UPDATE flows SET current=? WHERE id=?',v.id,f.id); return {version:v.id};
        }
        default: throw new Refusal('UNKNOWN_COMMAND');
      }
    });
    if (c.op === 'intent' && c.kind === 'continue' && !result.replay) this.blocked.delete(c.task);
    if (c.op === 'perform' && !result.replay) {
      const t=this.task(c.task); this.valid(t,c.token);
      this.hook('perform.before-send');
      // 一旦交给外部接收端，后续停止不能撤回它已经接受的效果。
      const response=await fetch(`${this.endpoint}/effect`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:c.action,task:t.id,material:t.material,version:t.content_version,target:t.target})});
      requireFact(response.ok,'EFFECT_ERROR'); await response.json();
      this.hook('perform.after-effect');
    }
    return result.value;
  }
  close() { this.db.close(); this.guard.close(); }
}
