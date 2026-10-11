import http from 'node:http';
import { appendFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(20); }
  throw new Error('condition-timeout');
}
const style = '<style>body{font:18px system-ui;max-width:700px;margin:32px;background:#edf3fa;color:#142d48}input,textarea,button{font:inherit;padding:10px;margin:12px 0;display:block}input,textarea{width:85%}button{background:#143f68;color:white;border:0;border-radius:6px}button:disabled{opacity:.45}pre{white-space:pre-wrap}</style>';
const page = body => '<!doctype html><meta charset="utf-8"><title>helpr AI 双页实验</title>' + style + body;
const script = `const cfg=JSON.parse(sessionStorage.getItem('lab')||'{}');
document.querySelector('#identity').textContent='实验页 '+(cfg.task||'未绑定');
const fields=()=>Object.fromEntries(['scope','task','token'].map(k=>[k,cfg[k]||'']));
const hidden=form=>{for(const [k,v] of Object.entries(fields())){const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;form.append(i);}};
window.lab={cfg,enable:()=>{document.querySelector('#late').disabled=false;},state:()=>({cfg,url:location.href,value:document.querySelector('#typing')?.value||'',text:document.body.innerText})};`;
function fixture(pathname) {
  if (pathname === '/start') return page(`<h1 id="identity"></h1><p>填写记录标题，然后打开详情，在新窗口补充说明并保存。</p><label>记录标题<input id="title"></label><button id="open">打开详情</button><p role="status" id="status"></p><script>${script}
document.querySelector('#open').onclick=()=>{sessionStorage.setItem('recordTitle',document.querySelector('#title').value);window.open('/detail','detail-'+cfg.token);document.querySelector('#status').textContent='详情已打开，请在详情窗口继续';};</script>`);
  if (pathname === '/detail') return page(`<h1 id="identity"></h1><p>记录详情：<span id="title"></span></p><form action="/record" method="post"><label>补充说明<textarea name="detail"></textarea></label><button>保存记录</button></form><script>${script}
document.querySelector('#title').textContent=sessionStorage.getItem('recordTitle');const form=document.querySelector('form');hidden(form);const t=document.createElement('input');t.type='hidden';t.name='title';t.value=sessionStorage.getItem('recordTitle');form.append(t);</script>`);
  return page(`<h1 id="identity"></h1><form action="/count" method="post"><button id="late">执行一次</button></form><label>逐字输入<input id="typing"></label><p role="status">尚未执行</p><script>${script}
hidden(document.querySelector('form'));document.querySelector('#late').disabled=!!cfg.disabled;
document.querySelector('#typing').addEventListener('input',e=>fetch('/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...fields(),kind:'page-input',value:e.target.value,eventAt:Date.now()})}));</script>`);
}
export async function createLab(out) {
  const events=[], records=[], gates=new Map(), active=new Set(); let writes=Promise.resolve();
  const log = row => { const event={seq:events.length+1,at:Date.now(),...row};events.push(event);writes=writes.then(()=>appendFile(out+'/events.jsonl',JSON.stringify(event)+'\n'));return event; };
  const key=(scope,task,route)=>scope+'|'+task+'|'+route;
  const hold=(scope,task,route)=>{const g=deferred();gates.set(key(scope,task,route),g);return g;};
  const server=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://localhost');
      if(req.method==='GET') {
        if(u.pathname==='/result') {
          const record=records.find(r=>r.id===u.searchParams.get('id'));
          if(!record){res.writeHead(404).end();return;}
          const safe=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
          res.setHeader('content-type','text/html; charset=utf-8');
          res.end(page(`<h1 id="identity">实验页 ${safe(record.task)}</h1><p role="status">操作已完成</p><pre>${safe(JSON.stringify(record,null,2))}</pre><script>${script}</script>`));return;
        }
        res.setHeader('content-type','text/html; charset=utf-8');res.end(fixture(u.pathname));return;
      }
      const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks).toString();
      if(u.pathname==='/event'){log(JSON.parse(body));res.end('ok');return;}
      const payload=Object.fromEntries(new URLSearchParams(body));
      const id=String(records.length+active.size+1)+'-'+payload.token;
      const handle=key(payload.scope,payload.task,u.pathname);active.add(handle);
      log({kind:'server-accepted',route:u.pathname,...payload,active:[...active]});
      if(u.pathname==='/record'&&[...active].filter(k=>k.startsWith(payload.scope+'|')&&k.endsWith('|/record')).length===2){
        for(const task of ['A','B'])gates.get(key(payload.scope,task,'/record'))?.resolve();
      }
      await gates.get(handle)?.promise;await delay(40);
      const record={id,route:u.pathname,...payload};records.push(record);active.delete(handle);
      log({kind:'server-committed',record});
      res.writeHead(303,{location:'/result?id='+encodeURIComponent(id)});res.end();
    } catch(e){log({kind:'server-error',error:String(e)});res.writeHead(500).end('error');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {base:'http://127.0.0.1:'+server.address().port,events,records,log,hold,
    releaseAll(){for(const g of gates.values())g.resolve();},
    async flush(){await writes;await writeFile(out+'/server-records.json',JSON.stringify(records,null,2)+'\n');},
    async close(){for(const g of gates.values())g.resolve();await new Promise(r=>server.close(r));await writes;}};
}
