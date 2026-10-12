import fs from 'node:fs';
import { Records } from './candidate.mjs';
const [root, endpoint, lockWait] = process.argv.slice(2);
const event = value => {
  const fd=fs.openSync(`${root}/owner-events.jsonl`,'a');
  try { fs.writeSync(fd,JSON.stringify({...value,time:Date.now()})+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
};
let records;
try {
  records=new Records(root,endpoint,event,lockWait === undefined ? 250 : Number(lockWait));
  process.send({ready:true,environment:records.environment,lockWaitMs:lockWait === undefined ? 250 : Number(lockWait)});
} catch (error) {
  process.send({ready:false,error:error.code ?? error.message,stage:error.stage ?? 'record-initialization',sqliteCode:error.sqliteCode,detail:error.detail ?? error.message});
  process.exitCode=2; process.disconnect();
}
if (records) {
  process.on('message',async ({seq,command,fault,close}) => {
    try {
      if (close) { records.close(); process.send({seq,value:'closed'},()=>process.exit(0)); return; }
      if (fault !== undefined) { records.inject(fault); process.send({seq,value:'armed'}); return; }
      const value=await records.execute(command); process.send({seq,value});
    } catch (error) { process.send({seq,error:{code:error.code ?? 'ERROR',message:error.message}}); }
  });
  process.on('disconnect',()=>process.exit(0));
}
