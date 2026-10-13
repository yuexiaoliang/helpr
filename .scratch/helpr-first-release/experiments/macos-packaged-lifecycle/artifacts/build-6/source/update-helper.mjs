// Runs inside the signed app's bundled Electron runtime. Not a production updater.
import {app} from 'electron';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
await app.whenReady();
const data=app.getPath('userData'),root=JSON.parse(fs.readFileSync(path.join(data,'experiment-owner.json'))).experiment;
const request=JSON.parse(fs.readFileSync(path.join(data,'helper-request.json'))),budgetFile=path.join(root,'budget.json');
const startsFile=path.join(data,'launch-budget.json'),starts=JSON.parse(fs.readFileSync(startsFile));if(starts.starts>=16)throw Error('START_BUDGET');starts.starts++;fs.writeFileSync(startsFile,JSON.stringify(starts));
const out=path.join(root,'artifacts',`update-helper-${starts.starts}.jsonl`);if(fs.existsSync(out))throw Error('EVIDENCE_EXISTS');
const log=r=>fs.appendFileSync(out,JSON.stringify({at:Date.now(),...r})+'\n');
const requirement='identifier "local.helpr.lifecycle-lab" and certificate leaf = H"0a64f07efa1addff417ec018e622d71d539b8de4"';
const installed=path.join(root,'installed/helpr Lifecycle Lab.app');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const execute=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const plist=(bundle,key)=>execute('/usr/bin/plutil',['-extract',key,'raw',path.join(bundle,'Contents/Info.plist')]);
const executable=bundle=>path.join(bundle,'Contents/MacOS',plist(bundle,'CFBundleExecutable'));
function fault(name){const b=JSON.parse(fs.readFileSync(budgetFile));if((b.faults||0)>=12)throw Error('FAULT_BUDGET');b.faults=(b.faults||0)+1;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');log({kind:'fault-counted',name,total:b.faults});}
function validate(bundle,meta){
 if(meta.arch!==process.arch)throw Error('ARCHITECTURE_MISMATCH');if(meta.schemaMin>1||meta.schemaMax<1)throw Error('DATA_SCHEMA_INCOMPATIBLE');
 if(plist(bundle,'CFBundleIdentifier')!=='local.helpr.lifecycle-lab'||plist(bundle,'CFBundleShortVersionString')!==meta.version)throw Error('BUNDLE_METADATA_MISMATCH');
 execute('/usr/bin/codesign',['--verify','--deep','--strict','-R','='+requirement,bundle]);
 const arch=execute('/usr/bin/lipo',['-archs',executable(bundle)]);if(!arch.split(' ').includes('arm64'))throw Error('BINARY_ARCHITECTURE_MISMATCH');
 return {version:meta.version,architecture:arch,executableSha256:sha(executable(bundle)),signature:true};
}
function saveReceipt(receipt){const file=path.join(data,'update-receipt.json');fs.writeFileSync(file+'.tmp',JSON.stringify(receipt,null,2),{mode:0o600});const fd=fs.openSync(file+'.tmp','r');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(file+'.tmp',file);}
try{
 const candidate=path.join(root,'packages',request.build,'helpr Lifecycle Lab.app'),meta={version:'0.0.2',arch:'arm64',schemaMin:1,schemaMax:1};
 log({kind:'helper-runtime',version:app.getVersion(),packaged:app.isPackaged,versions:process.versions,mode:request.mode});
 if(request.mode==='audit'){
  const paths=[],server=http.createServer((req,res)=>{paths.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(meta));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const received=await (await fetch(`http://127.0.0.1:${server.address().port}/release`)).json();server.close();
  const httpFile=path.join(data,'http-budget.json'),httpBudget=JSON.parse(fs.readFileSync(httpFile));if(httpBudget.requests>=1000)throw Error('HTTP_BUDGET');httpBudget.requests++;fs.writeFileSync(httpFile,JSON.stringify(httpBudget));
  log({check:'metadata-only-check',paths,downloadedBytes:0,received,pass:paths.length===1&&paths[0]==='/release'});
  log({check:'candidate-identity-and-architecture',...validate(candidate,meta),pass:true});
  for(const [name,bundle,changed] of [
    ['wrong-signing-identity',path.join(root,'build',request.build,'helpr Lifecycle Lab.app'),meta],
    ['wrong-declared-architecture',candidate,{...meta,arch:'x64'}],
    ['incompatible-data-schema',candidate,{...meta,schemaMin:2,schemaMax:2}]
  ]){fault(name);let rejected=false,error;try{validate(bundle,changed);}catch(e){rejected=true;error=e.message;}log({check:name,rejected,error,pass:rejected});if(!rejected)throw Error('NEGATIVE_ACCEPTED');}
 }else if(request.mode==='install-and-interrupt'){
  const receipt=JSON.parse(fs.readFileSync(path.join(data,'update-receipt.json')));if(receipt.phase!=='prepared'||receipt.to!==meta.version)throw Error('NO_CURRENT_PREPARATION');
  if(!fs.existsSync(path.join(receipt.backup,'manifest.json')))throw Error('BACKUP_NOT_READY');
  const owned=execute('/bin/ps',['-axo','pid=,command=']).split('\n').filter(l=>l.includes(installed+'/Contents/'));if(owned.length)throw Error('INSTALLED_PROCESSES_RUNNING');
  const records=new DatabaseSync(path.join(data,'cases/packaged-baseline/records.sqlite'),{readOnly:true});
  const settings=Object.fromEntries(records.prepare('SELECT * FROM settings').all().map(r=>[r.key,JSON.parse(r.value)])),tasks=records.prepare('SELECT * FROM tasks ORDER BY id').all();records.close();
  const backupManifest=JSON.parse(fs.readFileSync(path.join(receipt.backup,'manifest.json')));
  if(settings.maintenance!==true||settings.restoreHold||tasks.some(t=>t.intent!=='completed'||t.phase!=='verified')||JSON.stringify(tasks)!==JSON.stringify(backupManifest.tasks))throw Error('PREPARATION_STALE');
  if(settings.nextDue!==null&&settings.nextDue!==undefined&&settings.nextDue-Date.now()<30000)throw Error('SCHEDULE_TOO_CLOSE');
  const verified=validate(candidate,meta),b=JSON.parse(fs.readFileSync(budgetFile));if(b.installs>=4)throw Error('INSTALL_BUDGET');b.installs++;fs.writeFileSync(budgetFile,JSON.stringify(b,null,2)+'\n');
  const stage=path.join(root,'installed',`stage-${receipt.id}.app`),previous=path.join(root,'installed',`before-update-${receipt.id}.app`);if(fs.existsSync(stage)||fs.existsSync(previous))throw Error('PRIOR_ATTEMPT_REQUIRES_RECONCILIATION');
  receipt.phase='installing';receipt.stage=stage;receipt.previous=previous;receipt.verified=verified;saveReceipt(receipt);
  execute('/usr/bin/ditto',[candidate,stage]);validate(stage,meta);fs.renameSync(installed,previous);fs.renameSync(stage,installed);
  const fd=fs.openSync(path.dirname(installed),'r');fs.fsyncSync(fd);fs.closeSync(fd);
  log({check:'replacement-finished-before-receipt',receipt,installedVersion:plist(installed,'CFBundleShortVersionString'),pass:true});
  fault('interrupt-after-replacement-before-completion-record');process.kill(process.pid,'SIGKILL');
 }else throw Error('UNKNOWN_HELPER_MODE');
 log({kind:'helper-completed'});app.exit(0);
}catch(error){log({kind:'helper-failed',error:error.message});app.exit(1);}
