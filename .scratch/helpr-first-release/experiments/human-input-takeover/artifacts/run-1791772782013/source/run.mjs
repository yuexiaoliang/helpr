import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root=path.dirname(fileURLToPath(import.meta.url));
const registryFile=root+'/artifacts/registration.json';
const registry=JSON.parse(await readFile(registryFile));
if(registry.preparationPausedAt){registry.deadline+=Date.now()-registry.preparationPausedAt;delete registry.preparationPausedAt;delete registry.preparationRemainingMs;delete registry.pauseReason;}
if(Date.now()>=registry.deadline||registry.attempts>=registry.limit)throw Error('preparation-budget-exhausted');
registry.attempts++;
registry.mechanism='AppKit application-local NSEvent monitor';
registry.mechanismRevision=2;
await writeFile(registryFile,JSON.stringify(registry,null,2)+'\n');
const out=root+'/artifacts/run-'+Date.now();
await mkdir(out+'/source',{recursive:true});
const hashes={};
for(const file of ['PLAN.md','native/input-monitor.mm','build.mjs','build/metadata.json','electron.cjs','run.mjs','preload.cjs','page-preload.cjs','fixture.html','shell.html','chat.html','debug/view-switch.mjs','debug/button-command.mjs']){
 const data=await readFile(root+'/'+file);
 await mkdir(path.dirname(out+'/source/'+file),{recursive:true});
 await copyFile(root+'/'+file,out+'/source/'+file);
 hashes[file]=createHash('sha256').update(data).digest('hex');
}
const control=await readFile(root+'/../independent-stop/control.mjs');
await writeFile(out+'/source/control.mjs',control);
hashes['control.mjs']=createHash('sha256').update(control).digest('hex');
hashes['input-monitor.node']=createHash('sha256').update(await readFile(root+'/build/input-monitor.node')).digest('hex');
await writeFile(out+'/source/hashes.json',JSON.stringify(hashes,null,2)+'\n');
await writeFile(out+'/registration.json',JSON.stringify(registry,null,2)+'\n');
await writeFile(root+'/artifacts/latest.txt',out+'\n');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const executable=createRequire(new URL('../visible-page-control/package.json',import.meta.url))('electron');
const child=spawn(executable,[root+'/electron.cjs'],{env:{...process.env,TAKEOVER_OUT:out,TAKEOVER_PORT:String(port),TAKEOVER_DEADLINE:String(registry.deadline),TAKEOVER_AUTOMATIC_ONLY:process.argv.includes('--automatic-only')?'1':'0'},stdio:['ignore','pipe','pipe']});
const stdout=[],stderr=[];
child.stdout.on('data',chunk=>{stdout.push(chunk);process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{stderr.push(chunk);});
const code=await new Promise(resolve=>child.on('exit',resolve));
await writeFile(out+'/stdout.log',Buffer.concat(stdout));await writeFile(out+'/stderr.log',Buffer.concat(stderr));
console.log(JSON.stringify({out,exitCode:code}));
process.exitCode=code??1;
