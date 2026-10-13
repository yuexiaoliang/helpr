// Independent local website fixture. Its effects live outside helpr's task database.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const [root]=process.argv.slice(2),stateFile=path.join(root,'website.json');
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):Object.fromEntries(['A','B'].map(id=>[id,{counter:0,text:'',paste:''}]));
let requests=0;
const save=()=>{fs.writeFileSync(stateFile+'.tmp',JSON.stringify(state));fs.renameSync(stateFile+'.tmp',stateFile);};
const log=row=>fs.appendFileSync(path.join(root,'website-events.jsonl'),JSON.stringify({at:Date.now(),...row})+'\n');
const server=http.createServer(async(req,res)=>{
  if(++requests>1000){res.writeHead(429);return res.end('request budget');}
  const url=new URL(req.url,'http://localhost'),task=url.searchParams.get('task');
  if(!['A','B'].includes(task)){res.writeHead(400);return res.end();}
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(state[task]));}
  if(url.pathname==='/advance'&&req.method==='POST'){
    log({kind:'accepted',task});await new Promise(resolve=>setTimeout(resolve,250));
    state[task].counter++;save();log({kind:'completed',task,counter:state[task].counter});return res.end(JSON.stringify(state[task]));
  }
  if(url.pathname==='/input'&&req.method==='POST'){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4000){res.writeHead(413);return res.end();}}
    try{const v=JSON.parse(body);if(!['text','paste'].includes(v.name)||typeof v.value!=='string')throw Error();state[task][v.name]=v.value.slice(0,300);save();log({kind:'manual-field-saved',task,field:v.name,length:v.value.length});return res.end('{}');}catch{res.writeHead(400);return res.end();}
  }
  if(url.pathname!=='/page'){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type','text/html;charset=utf-8');
  const data=JSON.stringify(state[task]).replaceAll('<','\\u003c');
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{font:18px -apple-system;margin:24px;color:#183248;background:#f5f8fb}h1{font-size:25px}.progress{font-size:42px;color:#16735e}button,input{font:inherit;border:1px solid #b5c7d5;border-radius:8px;padding:12px;box-sizing:border-box}button{color:white;background:#245980;width:100%}input{display:block;width:100%;margin:10px 0 24px}small{color:#5b6a79}</style><h1>任务 ${task}</h1><small>本机虚构网页，仅用于封装验证</small><p>自动进度 <strong class="progress" id="progress"></strong></p><button id="advance">自动推进</button><p>直接输入会让出本任务</p><label>中文输入<input id="text" placeholder="手动接管测试"></label><label>粘贴输入<input id="paste" placeholder="网页粘贴测试 2026"></label><script>const state=${data},task=${JSON.stringify(task)};progress.textContent=state.counter;for(const name of ['text','paste']){const el=document.getElementById(name);el.value=state[name];el.addEventListener('input',()=>fetch('/input?task='+task,{method:'POST',body:JSON.stringify({name,value:el.value})}));}advance.onclick=async()=>{const r=await fetch('/advance?task='+task,{method:'POST'});const s=await r.json();progress.textContent=s.counter;};</script>`);
});
server.listen(0,'127.0.0.1',()=>process.parentPort.postMessage({ready:true,origin:`http://127.0.0.1:${server.address().port}`}));
process.parentPort.on('message',({data})=>{if(data==='close')server.close(()=>process.exit(0));});
