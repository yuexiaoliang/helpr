import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),build=process.argv[2]||'build-2',budgetFile=path.join(root,'budget.json');
const budget=JSON.parse(fs.readFileSync(budgetFile)),signed=JSON.parse(fs.readFileSync(path.join(root,'artifacts',`signed-${build}.json`)));
const version=signed.version;
if(budget.waitingForUser)throw Error('DESKTOP_CHECK_PENDING; record the actual user reply before restarting');
if(!signed.verified||!signed.searchListRestored)throw Error('SIGNATURE_NOT_READY');
const app=path.join(root,'installed/helpr Lifecycle Lab.app');
if(!fs.existsSync(app)){
 if(budget.installs>=(budget.limits?.installs??4))throw Error('INSTALL_BUDGET');budget.installs++;fs.writeFileSync(budgetFile,JSON.stringify(budget,null,2)+'\n');fs.mkdirSync(path.dirname(app),{recursive:true});
 execFileSync('/usr/bin/ditto',[path.join(root,signed.app),app]);
}else if(execFileSync('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim()!==version)throw Error('USE_UPDATE_PROTOCOL_NOT_OVERWRITE');
const data=path.join(os.homedir(),'Library/Application Support/helpr Lifecycle Lab'),owner=path.join(data,'experiment-owner.json');
if(fs.existsSync(data)&&!fs.existsSync(owner))throw Error('EXISTING_UNKNOWN_DATA_DIRECTORY');
fs.mkdirSync(data,{recursive:true});if(!fs.existsSync(owner))fs.writeFileSync(owner,JSON.stringify({experiment:root,createdAt:new Date().toISOString()}));
if(!budget.liveStartedAt){budget.liveStartedAt=Date.now();budget.deadline=budget.liveStartedAt+90*60*1000;fs.writeFileSync(budgetFile,JSON.stringify(budget,null,2)+'\n');}
if(Date.now()>budget.deadline)throw Error('EXPERIMENT_DEADLINE');
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
execFileSync('/usr/bin/open',['-n',app],{cwd:'/',env:{HOME:os.homedir(),PATH:'/usr/bin:/bin'}});
console.log(JSON.stringify({app,data,version,launchMethod:'LaunchServices with cwd / and PATH /usr/bin:/bin; no external Node',gatekeeperAssessment:signed.gatekeeperAccepted},null,2));
