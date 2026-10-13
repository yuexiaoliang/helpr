// Build a reviewable app first. Stable signing is a separate gated step.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {flipFuses,getCurrentFuseWire,FuseVersion,FuseV1Options as F} from '@electron/fuses';
const root=path.dirname(fileURLToPath(import.meta.url)),version=process.argv[2]||'0.0.1';
if(!['0.0.1','0.0.2'].includes(version))throw Error('UNPLANNED_VERSION');
const budgetFile=path.join(root,'budget.json'),budget=fs.existsSync(budgetFile)?JSON.parse(fs.readFileSync(budgetFile)):{builds:0,installs:0,modelCalls:0,remoteWrites:0};
if(budget.builds>=6)throw Error('BUILD_BUDGET_EXHAUSTED');budget.builds++;fs.writeFileSync(budgetFile,JSON.stringify(budget,null,2)+'\n');
const label=`build-${budget.builds}`,out=path.join(root,'artifacts',label),build=path.join(root,'build',label),app=path.join(build,'helpr Lifecycle Lab.app');fs.mkdirSync(out,{recursive:true});fs.mkdirSync(build,{recursive:true});
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),commands=[];
function command(exe,args){try{const result=execFileSync(exe,args,{encoding:'utf8',maxBuffer:4e6});commands.push({exe,args,exit:0,stdout:result});return result;}catch(e){commands.push({exe,args,exit:e.status,stdout:e.stdout,stderr:e.stderr});throw e;}}
const sources={};function snapshot(dir,relative=''){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,ent.name),key=path.join(relative,ent.name);if(ent.isDirectory())snapshot(f,key);else{sources[key]=hash(f);const dest=path.join(out,'source',key);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(f,dest);}}}
snapshot(path.join(root,'src'));fs.copyFileSync(path.join(root,'build.mjs'),path.join(out,'build.mjs'));
const manifest={version,bundleId:'local.helpr.lifecycle-lab',sources,signatureMode:'ad-hoc preparation only; NOT stable signing or update evidence',at:new Date().toISOString()};
try{
  command('/usr/bin/ditto',[path.resolve(root,'../visible-page-control/node_modules/electron/dist/Electron.app'),app]);
  const resources=path.join(app,'Contents/Resources'),payload=path.join(resources,'app');fs.mkdirSync(payload,{recursive:true});
  command('/usr/bin/ditto',[path.join(root,'src'),payload]);
  fs.writeFileSync(path.join(payload,'package.json'),JSON.stringify({name:'helpr-lifecycle-lab',productName:'helpr Lifecycle Lab',version,main:'main.cjs',private:true}));
  for(const name of ['playwright','playwright-core']){const source=path.resolve(root,'../visible-page-control/node_modules',name);command('/usr/bin/ditto',[source,path.join(payload,'node_modules',name)]);}
  const plist=path.join(app,'Contents/Info.plist');
  for(const [key,value] of Object.entries({CFBundleIdentifier:manifest.bundleId,CFBundleName:'helpr Lifecycle Lab',CFBundleDisplayName:'helpr Lifecycle Lab',CFBundleVersion:version,CFBundleShortVersionString:version,NSHumanReadableCopyright:'Local experiment only. Not a released product.'}))command('/usr/bin/plutil',['-replace',key,'-string',value,plist]);
  const headers=path.resolve(path.dirname(process.execPath),'../include/node');
  command('/usr/bin/clang++',['-bundle','-undefined','dynamic_lookup','-std=c++17','-fobjc-arc','-framework','Cocoa','-I',headers,path.join(payload,'native/input-monitor.mm'),'-o',path.join(payload,'native/input-monitor.node')]);
  manifest.nativeSha256=hash(path.join(payload,'native/input-monitor.node'));
  await flipFuses(app,{version:FuseVersion.V1,[F.RunAsNode]:false,[F.EnableCookieEncryption]:true,[F.EnableNodeOptionsEnvironmentVariable]:false,[F.EnableNodeCliInspectArguments]:false});
  manifest.fuses=await getCurrentFuseWire(app);
  // Ad-hoc sealing permits static bundle verification; never call it stable signing.
  command('/usr/bin/codesign',['--force','--deep','--sign','-','--timestamp=none',app]);
  command('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
  manifest.app=path.relative(root,app);manifest.appExecutableSha256=hash(path.join(app,'Contents/MacOS/Electron'));manifest.prepared=true;
}catch(error){manifest.error=error.message;process.exitCode=1;}
finally{fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(out,'commands.json'),JSON.stringify(commands,null,2)+'\n');console.log(JSON.stringify({build:label,version,prepared:manifest.prepared,error:manifest.error,app:manifest.app,signatureMode:manifest.signatureMode},null,2));}
