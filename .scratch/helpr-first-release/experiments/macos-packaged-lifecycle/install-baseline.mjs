// Replaces only the failed lab baseline; this is not evidence of the update protocol.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),build=process.argv[2];if(!/^build-\d+$/.test(build))throw Error('build-invalid');
const signature=JSON.parse(fs.readFileSync(path.join(root,'artifacts',`signed-${build}.json`)));if(!signature.verified||!signature.searchListRestored)throw Error('signature-not-ready');
const original=path.join(root,'installed/helpr Lifecycle Lab.app'),source=path.join(root,signature.app),stage=path.join(root,'installed',build+'.app'),old=path.join(root,'installed','previous-'+build+'.app');
const processes=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').filter(l=>l.includes(original+'/Contents/'));if(processes.length)throw Error('owned-processes-still-running');
if(fs.existsSync(old)||fs.existsSync(stage))throw Error('already-attempted');
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const file=path.join(root,'budget.json'),budget=JSON.parse(fs.readFileSync(file));if(budget.installs>=(budget.limits?.installs??4))throw Error('INSTALL_BUDGET');budget.installs++;fs.writeFileSync(file,JSON.stringify(budget,null,2)+'\n');
execFileSync('/usr/bin/ditto',[source,stage]);execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',stage]);fs.renameSync(original,old);fs.renameSync(stage,original);
fs.writeFileSync(path.join(root,'artifacts',`installed-${build}.json`),JSON.stringify({at:Date.now(),build,source:signature.app,previousPreserved:path.relative(root,old),reason:'controlled replacement of failed lab build; records preserved, not counted as successful product upgrade'},null,2));
console.log(JSON.stringify({build,installed:original,installs:budget.installs}));
