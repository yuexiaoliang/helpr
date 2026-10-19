// 仅事项 05、构建 32 的签名超时续办；复制原包，不编译、不安装、不启动产品。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {getCurrentFuseWire} from '@electron/fuses';
import {developmentIdentity,signDevelopmentPackage} from './development-signing.mjs';
import {validationRoot} from './workspace-budget.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64','MAC_ARM64_REQUIRED');
assert(process.argv.length===3&&['--preflight','--execute'].includes(process.argv[2]),'EXPLICIT_MODE_REQUIRED');
const totalTimeLimitMs=1200000;
const deadline=Date.now()+totalTimeLimitMs;
const remaining=()=>{const value=deadline-Date.now();assert(value>0,'SIGNING_FOLLOWUP_TIME_LIMIT');return value;};
const source=path.join(validationRoot,'build-32.json');
const sourceApp=path.resolve('dist/candidates/recovery-05-quit/mac-arm64/helpr.app');
const app=path.resolve('dist/candidates/recovery-05-quit-signing/mac-arm64/helpr.app');
const output=path.join(validationRoot,'build-32-signing-followup.json');
const evidence=JSON.parse(fs.readFileSync('docs/testing/evidence/recovery-05/BUILD32-SIGNING-FAILURE.json'));
const hash=file=>{remaining();const value=createHash('sha256').update(fs.readFileSync(file)).digest('hex');remaining();return value;};
const original=JSON.parse(fs.readFileSync(source));
assert.equal(hash(source),evidence.failureSourceSha256,'ORIGINAL_MANIFEST_CHANGED');
assert(original.build===32&&original.prepared===false&&original.error==='DEVELOPMENT_SIGNING_TIME_LIMIT','EXPECTED_SIGNING_FAILURE_REQUIRED');
assert.equal(fs.realpathSync(sourceApp),sourceApp,'SOURCE_SYMLINK_REFUSED');
assert.equal(hash(path.join(sourceApp,'Contents/Resources/app.asar')),evidence.sourceArchiveSha256,'SOURCE_ARCHIVE_CHANGED');
const identity=developmentIdentity();
remaining();
assert.equal(identity.certificateSha256,original.signing.certificateSha256,'SIGNING_IDENTITY_CHANGED');
const sourceFuses=await getCurrentFuseWire(sourceApp);
remaining();
assert.deepEqual(sourceFuses,original.fuses,'SOURCE_FUSES_CHANGED');
const info=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(sourceApp,'Contents/Info.plist')],{encoding:'utf8',timeout:Math.min(30000,remaining()),killSignal:'SIGKILL'});
remaining();
assert(!info.error&&info.status===0,'SOURCE_METADATA_UNAVAILABLE');
const metadata=JSON.parse(info.stdout);
assert.equal(metadata.CFBundleIdentifier,'local.helpr.desktop');
assert.equal(String(metadata.CFBundleVersion),'32');
assert(!fs.existsSync(app)&&!fs.existsSync(output),'FOLLOWUP_ALREADY_EXISTS');
const base={build:32,origin:'signing-followup',originalManifest:source,sourceManifestSha256:evidence.failureSourceSha256,sourceArchiveSha256:evidence.sourceArchiveSha256,sourceApp,app,signingTimeLimitMs:900000,totalTimeLimitMs,cleanupReserveMs:65000,builds:0,installs:0,starts:0};
if(process.argv[2]==='--preflight'){
  console.log(JSON.stringify({...base,preflightPassed:true}));
  process.exit(0);
}
const report={...base,signingPreparations:1,started:new Date().toISOString(),prepared:false};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
function run(executable,args,maximum){
  const result=spawnSync(executable,args,{encoding:'utf8',stdio:'pipe',detached:true,timeout:Math.min(maximum,remaining()),killSignal:'SIGKILL'});
  if(result.error||result.status!==0){
    if(result.pid){try{process.kill(-result.pid,'SIGKILL');}catch{}}
    throw Error(result.error?.code==='ETIMEDOUT'?'SIGNING_FOLLOWUP_TIME_LIMIT':'SIGNING_FOLLOWUP_COMMAND_FAILED');
  }
  return result.stdout;
}
try{
  fs.mkdirSync(path.dirname(app),{recursive:true});
  assert.equal(fs.realpathSync(path.dirname(app)),path.dirname(app),'TARGET_SYMLINK_REFUSED');
  // APFS 写时复制保留失败原件；复制失败即停止，不退回修改原包。
  run('/bin/cp',['-cR',sourceApp,app],300000);
  assert.equal(hash(path.join(app,'Contents/Resources/app.asar')),base.sourceArchiveSha256,'COPIED_ARCHIVE_CHANGED');
  assert(remaining()>=120000+base.cleanupReserveMs,'SIGNING_FOLLOWUP_TIME_LIMIT');
  report.signing=signDevelopmentPackage(app,Math.min(base.signingTimeLimitMs,remaining()-base.cleanupReserveMs));
  report.hostCheck=JSON.parse(run(process.execPath,['scripts/validate-host-package.mjs',app],remaining()));
  report.fuses=await getCurrentFuseWire(app);
  assert.deepEqual(report.fuses,sourceFuses,'FOLLOWUP_FUSES_CHANGED');
  report.hashes={};
  for(const file of ['Contents/MacOS/helpr','Contents/Resources/app.asar','Contents/Resources/watch-owner','Contents/Frameworks/helpr Workspace.app/Contents/MacOS/helpr Workspace Helper','Contents/Frameworks/helpr Workspace.app/Contents/Info.plist'])report.hashes[file]=hash(path.join(app,file));
  assert.equal(report.hashes['Contents/Resources/app.asar'],base.sourceArchiveSha256,'SIGNED_ARCHIVE_CHANGED');
  assert.equal(hash(source),base.sourceManifestSha256,'ORIGINAL_MANIFEST_CHANGED');
  assert.equal(hash(path.join(sourceApp,'Contents/Resources/app.asar')),base.sourceArchiveSha256,'ORIGINAL_ARCHIVE_CHANGED');
  remaining();report.prepared=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  report.finished=new Date().toISOString();
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({build:32,origin:report.origin,prepared:report.prepared,error:report.error,app}));
}
