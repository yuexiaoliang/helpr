import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validationRoot } from './workspace-budget.mjs';
import { getCurrentFuseWire } from '@electron/fuses';

const verifyExisting=process.argv[3]==='--verify-existing';
assert.deepEqual(process.argv.slice(2),['--candidate=41',...(verifyExisting?['--verify-existing']:[])]);
const manifest=JSON.parse(fs.readFileSync(path.join(validationRoot,'build-41.json')));
assert(manifest.prepared&&manifest.build===41);
const root=path.join(validationRoot,'delivery09-41');
if(!verifyExisting)fs.mkdirSync(root,{mode:0o700});
const digest=async(file)=>{const h=createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');};
for(const [file,hash]of Object.entries(manifest.hashes))assert.equal(await digest(path.join(manifest.app,file)),hash);
const archive=path.join(root,'helpr-0.2.2-macos-arm64-local-preview.zip');
const prior=verifyExisting?JSON.parse(fs.readFileSync(path.join(root,'asset.json'))):null;
if(verifyExisting){assert(!prior.passed&&prior.error==='FROZEN_MIGRATIONS_MISSING'&&prior.build===41);assert.equal(await digest(archive),prior.sha256);fs.copyFileSync(path.join(root,'asset.json'),path.join(root,'asset-first-attempt.json'),fs.constants.COPYFILE_EXCL);}
const report=prior?{...prior,verificationFollowupStarted:Date.now(),priorError:prior.error,error:undefined,passed:false}:{build:41,sourceCommit:'3c8d986',version:'0.2.2',platform:'darwin',arch:'arm64',started:Date.now(),archive,passed:false,publication:'not published; local review artifact only',signing:'current Mac local-development-only; no Developer ID or notarization',appStarts:0,installs:0};
const save=()=>fs.writeFileSync(path.join(root,'asset.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
try{
  if(!verifyExisting)execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',manifest.app,archive],{timeout:180000,stdio:'pipe'});
  report.bytes=fs.statSync(archive).size;report.sha256=await digest(archive);save();
  const index=execFileSync('/usr/bin/unzip',['-Z1',archive],{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024});
  assert(!index.split('\n').some(p=>/(?:^|\/)(?:workspace\.sqlite|Cookies|keychain-password|private-fixture\.json|tls-key\.pem)$/.test(p)),'USER_DATA_IN_DELIVERY');
  fs.writeFileSync(path.join(root,'archive-index.txt'),index,{mode:0o600});
  const readback=path.join(root,'readback');if(!verifyExisting){fs.mkdirSync(readback,{mode:0o700});execFileSync('/usr/bin/ditto',['-x','-k',archive,readback],{timeout:120000,stdio:'pipe'});}
  const app=path.join(readback,'helpr.app');
  for(const [file,hash]of Object.entries(manifest.hashes))assert.equal(await digest(path.join(app,file)),hash);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:30000,stdio:'pipe'});
  assert.deepEqual(await getCurrentFuseWire(app),manifest.fuses);
  const info=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],{encoding:'utf8',timeout:5000}));assert.equal(info.CFBundleShortVersionString,'0.2.2');
  const migrations=path.join(app,'Contents/Resources/migrations');
  const list=(folder,prefix='')=>fs.readdirSync(folder).sort().flatMap(name=>{const f=path.join(folder,name),relative=path.join(prefix,name);assert(!fs.lstatSync(f).isSymbolicLink());return fs.statSync(f).isDirectory()?list(f,relative):[relative];});
  const files=list(migrations);assert.deepEqual(files,list(path.resolve('app/records/migrations')));
  assert(files.length>=6,'FROZEN_MIGRATIONS_MISSING');report.frozenMigrations=[];
  for(const p of files){const content=fs.readFileSync(path.join(migrations,p));assert.deepEqual(content,fs.readFileSync(path.resolve('app/records/migrations',p)));report.frozenMigrations.push({path:p,sha256:createHash('sha256').update(content).digest('hex')});}
  report.archiveRoundtripVerified=true;report.productionFusesMatched=true;report.passed=true;
  fs.writeFileSync(path.join(root,'SHA256SUMS'),`${report.sha256}  ${path.basename(archive)}\n`);
  fs.writeFileSync(path.join(root,'macos-arm64.proposed.json'),JSON.stringify({schema:1,version:'0.2.2',platform:'darwin',arch:'arm64',minOS:'14.0.0',dataFormats:[6,7],stateModels:[1],notes:['本机自用预览：手动换版、保护不可用时保留登录资料。'],downloadURL:'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.2'},null,2)+'\n');
  fs.writeFileSync(path.join(root,'RELEASE-NOTES.md'),`# helpr 0.2.2 本机自用预览\n\n固定候选41，来源提交3c8d986。仅供当前Mac的自用交付验证；使用本机开发签名，没有Developer ID或公证，不作为面向其它电脑的正式发行。\n\n修正网页保护不可用时仍加载网站而丢失Cookie的问题；系统授权取消时保留资料并暂停依赖工作。普通退出不再被尚待升级核对误阻止。\n\n安装包：${path.basename(archive)}\n\nSHA-256：${report.sha256}\n\n已实测旧格式6到7及中断恢复、原测试密钥和未到期登录跨版延续、取消授权、两份持久许可后的同包无提示冷开，以及停止、接管和待核对条件保持。原失败及具体边界见仓库09验收证据。\n\n本地文件尚未发布。须先核对真实Release资产，再更新08独立渠道；此提案不代表下载验收已通过。\n`);
}catch(error){report.error=error.message;process.exitCode=1;}
finally{report.ended=Date.now();save();console.log(JSON.stringify({passed:report.passed,error:report.error,archive,bytes:report.bytes,sha256:report.sha256}));}
