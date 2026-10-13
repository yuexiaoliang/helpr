// Bounded test client, calling the same Interface used by the experiment's UI.
import net from 'node:net';import path from 'node:path';import os from 'node:os';
const command=JSON.parse(process.argv[2]);
const socket=path.join(os.homedir(),'Library/Application Support/helpr Lifecycle Lab/private-control/lab.sock');
const c=net.connect(socket,()=>c.write(JSON.stringify(command)+'\n'));let text='';
c.on('data',b=>text+=b);c.on('end',()=>{console.log(text.trim());try{if(!JSON.parse(text).ok)process.exitCode=1;}catch{process.exitCode=1;}});c.on('error',e=>{console.error(e.message);process.exitCode=1;});c.setTimeout(20000,()=>{console.error('timeout');c.destroy();process.exitCode=1;});
