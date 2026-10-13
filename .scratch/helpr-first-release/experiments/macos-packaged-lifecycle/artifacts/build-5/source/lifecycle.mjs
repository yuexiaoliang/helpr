// Local experiment Interface; the host and bounded Unix-socket harness use this same owner.
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
export function lifecycle({db,data,work,log,rows}){
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS assets(name TEXT PRIMARY KEY,sha256 TEXT);");
  const put=(k,v)=>db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k,JSON.stringify(v));
  const get=(k,f)=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k);return r?JSON.parse(r.value):f;};
  const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const assets=path.join(work,'assets');fs.mkdirSync(assets,{recursive:true});
  for(const [name,value] of [['workflow.json','{"purpose":"virtual counter exercise","schema":1}'],['material.txt','HELPR VIRTUAL MATERIAL 20261012']]){
    const file=path.join(assets,name);if(!fs.existsSync(file))fs.writeFileSync(file,value,{mode:0o600});db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?)').run(name,sha(file));
  }
  function backup(destination=path.join(data,'backups',randomUUID())){
    fs.mkdirSync(destination,{recursive:true});const database=path.join(destination,'records.sqlite');
    db.prepare('VACUUM INTO ?').run(database);
    const files=[{name:'records.sqlite',sha256:sha(database)}];
    for(const asset of db.prepare('SELECT * FROM assets ORDER BY name').all()){
      if(sha(path.join(assets,asset.name))!==asset.sha256)throw Error('asset-integrity-failed');
      fs.mkdirSync(path.join(destination,'assets'),{recursive:true});fs.copyFileSync(path.join(assets,asset.name),path.join(destination,'assets',asset.name));files.push({name:'assets/'+asset.name,sha256:asset.sha256});
    }
    const manifest={schema:1,at:Date.now(),tasks:rows(),files,excludes:['model-sample.encrypted','profile','website.json','website-events.jsonl']};
    fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2));
    for(const file of [...files.map(f=>f.name),'manifest.json']){const fd=fs.openSync(path.join(destination,file),'r');fs.fsyncSync(fd);fs.closeSync(fd);}
    const fd=fs.openSync(destination,'r');fs.fsyncSync(fd);fs.closeSync(fd);log({kind:'backup-completed',destination,manifest});return {destination,manifest};
  }
  function qualify(mode){
    if(mode==='idle'&&!get('idleUpdates',false))throw Error('idle-updates-disabled');
    if(!['idle','manual'].includes(mode))throw Error('update-mode-invalid');
    if(get('maintenance',false)||get('restoreHold',false))throw Error('maintenance-or-restore-pending');
    const pending=rows().filter(r=>r.intent!=='completed'||r.phase!=='verified');if(pending.length)throw Error('work-not-idle:'+pending.map(r=>r.id+':'+r.intent+':'+r.phase).join(','));
    if(get('nextDue',null)!==null&&get('nextDue',null)-Date.now()<30000)throw Error('schedule-too-close');
  }
  function prepare({mode='manual',to,backupDestination}){
    qualify(mode);put('maintenance',true);log({kind:'update-dispatch-gate-closed',mode,to});
    try{const saved=backup(backupDestination);const receipt={id:randomUUID(),from:get('version',null),to,mode,backup:saved.destination,phase:'prepared',at:Date.now()};fs.writeFileSync(path.join(data,'update-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;}
    catch(error){log({kind:'update-backup-failed',message:error.message});throw error;}
  }
  function restore(destination){
    const root=path.resolve(data,'backups'),candidate=path.resolve(destination);if(!candidate.startsWith(root+path.sep))throw Error('backup-outside-owned-area');
    const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'manifest.json')));for(const f of manifest.files)if(sha(path.join(candidate,f.name))!==f.sha256)throw Error('backup-hash-mismatch');
    const current=backup();put('maintenance',true);put('restoreHold',true);
    // Restore counters and referenced assets while retaining every newer user intent/generation.
    db.prepare('ATTACH DATABASE ? AS oldbackup').run(path.join(candidate,'records.sqlite'));
    db.exec("BEGIN IMMEDIATE; UPDATE tasks SET counter=COALESCE((SELECT counter FROM oldbackup.tasks WHERE oldbackup.tasks.id=tasks.id),counter),phase=CASE WHEN phase IN ('uncertain','dispatched') THEN 'uncertain' ELSE 'verify' END,generation=generation+1; COMMIT; DETACH DATABASE oldbackup;");
    for(const f of manifest.files.filter(f=>f.name.startsWith('assets/')))fs.copyFileSync(path.join(candidate,f.name),path.join(work,f.name));
    log({kind:'old-backup-restored-paused',backup:candidate,preRestore:current.destination,tasks:rows()});return {paused:true,preservedNewerIntent:true,tasks:rows()};
  }
  return {get,put,backup,qualify,prepare,restore,blocked:()=>get('maintenance',false)||get('restoreHold',false)};
}
