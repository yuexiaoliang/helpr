// 独立接收端：不读取候选数据库、不做幂等去重；每次实际请求分别记账。
import http from 'node:http';
import fs from 'node:fs';
const [file] = process.argv.slice(2);
const events=[], pending=[], reads=[]; let hold=false, holdReads=false, hide=false;
const log=e=>{const row={...e,time:Date.now()};events.push(row);const fd=fs.openSync(file,'a');try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}process.send({event:row});};
const complete=({value,res})=>{log({kind:'completed',...value});res.writeHead(200,{'content-type':'application/json'});res.end('{}');};
const reply=res=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(hide?[]:events));};
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/effects'){if(holdReads)reads.push(res);else reply(res);return;}
  if(req.method!=='POST'||req.url!=='/effect'){res.writeHead(404);res.end();return;}
  let bytes='';for await(const chunk of req)bytes+=chunk;
  const value=JSON.parse(bytes);log({kind:'received',...value});
  if(hold)pending.push({value,res});else complete({value,res});
});
server.listen(0,'127.0.0.1',()=>process.send({ready:true,url:`http://127.0.0.1:${server.address().port}`}));
process.on('message',({seq,op,value})=>{
  if(op==='hold')hold=value;
  if(op==='hide')hide=value;
  if(op==='holdReads')holdReads=value;
  if(op==='release'){hold=false;for(const item of pending.splice(0))complete(item);}
  if(op==='releaseReads'){holdReads=false;for(const res of reads.splice(0))reply(res);}
  process.send({seq,value:{events,pending:pending.length,reads:reads.length}});
});
process.on('disconnect',()=>process.exit(0));
