// 独立夹具：知道预期业务含义；这些规则不进入候选代理 Module。
import { writeFileSync, readFileSync } from 'node:fs';
import { bodyOf, multipart, save, serve, sha, sleep } from './wire.mjs';

export const payload = (id, value = 1) => JSON.stringify({ case: id, record: 'fictional', value });
export async function openFixture({ id, kind, directory, reserve }) {
  const rows = [], resources = [`/fixture/${id}`, `/client.js?case=${id}`, '/favicon.ico'];
  const sink = `/sink/${id}`, redirect = `/redirect/${id}`, file = 'sample.bin';
  const source = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 31 + 7) % 251));
  writeFileSync(`${directory}/${file}`, source);
  const sourceHash = sha(source);
  const good = payload(id), bad = payload(id, 999);
  const client = `
window.done = 0; window.fixtureErrors = []; window.actor = [];
const sink = ${JSON.stringify(sink)}, good = ${good}, bad = ${bad};
const mark = s => { window.actor.push({source:s,at:Date.now()}); };
async function send(data) { const response = await fetch(sink, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); window.done++; return response.status; }
function xhr(data) { return new Promise(resolve => { const x = new XMLHttpRequest(); x.open('POST',sink); x.setRequestHeader('Content-Type','application/json'); x.onloadend = () => { window.done++; resolve(x.status); }; x.send(JSON.stringify(data)); }); }
const go = document.querySelector('#go'), input = document.querySelector('#file');
const kind = ${JSON.stringify(kind)};
window.scheduleOld = () => { setTimeout(() => { mark('old-action-timer'); send(good); }, 350); };
if (kind === 'same-click') go.onclick = () => { mark('click'); for (const item of [good,bad]) send(item); };
else if (kind === 'xhr') go.onclick = () => { mark('click'); for (const item of [good,bad]) xhr(item); };
else if (kind === 'late' || kind === 'late-next') go.onclick = () => { mark('click-schedules-timer'); setTimeout(() => { mark('old-action-timer'); send(good); },350); };
else if (kind === 'matching-timer') go.onclick = () => { mark('new-click'); send(good); };
else if (kind === 'get') go.onclick = async () => { mark('click'); await fetch(sink+'?value=999'); window.done++; };
else if (kind === 'beacon') go.onclick = () => { setTimeout(() => { mark('late-beacon'); navigator.sendBeacon(sink,new Blob([JSON.stringify(good)],{type:'application/json'})); window.done++; },350); };
else if (kind === 'redirect') go.onclick = async () => { mark('click'); await fetch(${JSON.stringify(redirect)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(good)}); window.done++; };
else if (kind === 'worker') {
  const worker = new Worker('/worker.js?case=${id}'); worker.onmessage = () => { window.done++; }; go.onclick = () => { mark('click-to-worker'); worker.postMessage(good); };
}
else if (kind === 'service-worker') {
  window.ready = (async () => { await navigator.serviceWorker.register('/sw.js?case=${id}'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    navigator.serviceWorker.addEventListener('message', () => { window.done++; });
    go.onclick = () => { mark('click-to-service-worker'); navigator.serviceWorker.controller.postMessage(good); };
  })();
}
else if (kind.startsWith('upload')) input.onchange = async () => {
  const f = input.files[0], bytes = await f.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  window.selection = {name:f.name,bytes:f.size,sha256:hash};
  const form = new FormData(); form.append('case', ${JSON.stringify(id)});
  const selected = kind === 'upload-replaced' ? new File([new Uint8Array(f.size).fill(255)],f.name,{type:'application/octet-stream'}) : f;
  form.append('file',selected); mark('file-change'); await fetch(sink,{method:'POST',body:form}); window.done++;
};
else if (kind !== 'form') go.onclick = () => { mark('click'); send(good); };
`;
  if (kind === 'form') resources.push(`/form/${id}`);
  if (kind === 'worker') resources.push(`/worker.js?case=${id}`);
  if (kind === 'service-worker') resources.push(`/sw.js?case=${id}`);
  const server = await serve(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === `/fixture/${id}`) {
      res.writeHead(200, { 'Content-Type':'text/html', 'Cache-Control':'no-store' }).end(`<!doctype html><meta charset="utf-8"><title>请求关联实验</title><button id="go">执行虚构操作</button><input id="file" type="file">${kind === 'form' ? `<iframe src="/form/${id}"></iframe>` : ''}<script src="/client.js?case=${id}"></script>`); return;
    }
    if (url.pathname === '/client.js') { res.writeHead(200, { 'Content-Type':'text/javascript' }).end(client); return; }
    if (url.pathname === '/worker.js') { res.writeHead(200, { 'Content-Type':'text/javascript' }).end(`onmessage=async e=>{await fetch('${sink}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e.data)});postMessage('done')}`); return; }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type':'text/javascript', 'Service-Worker-Allowed':'/' }).end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.waitUntil((async()=>{await fetch('${sink}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e.data)});(await clients.get(e.source.id)).postMessage('done')})()));`); return;
    }
    if (url.pathname === `/form/${id}`) {
      res.writeHead(200, { 'Content-Type':'text/html' }).end(`<form method="POST" action="${sink}"><input name="case" value="${id}"><input name="value" value="1"><button id="submit">提交</button></form>`); return;
    }
    if (url.pathname.startsWith('/download/')) {
      const index = Number(url.pathname.split('/').at(-1));
      const record = rows.find(row => row.id === index && row.file);
      if (!record) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type':'application/octet-stream' }).end(readFileSync(`${directory}/server-file-${index}.bin`)); return;
    }
    if (url.pathname === sink || url.pathname === redirect) {
      const body = await bodyOf(req); const type = req.headers['content-type'] || '';
      await reserve(type.includes('multipart/form-data') ? 'upload' : 'write');
      const row = { id: rows.length + 1, receivedAt: Date.now(), method:req.method, path:url.pathname + url.search,
        bytes:body.length, sha256:sha(body), contentType:type, effect:url.pathname === redirect ? 'redirect' : 'stored' };
      writeFileSync(`${directory}/server-body-${row.id}.bin`,body);
      if (type.includes('multipart/form-data')) {
        const parts = multipart(type,body);
        row.parts = parts.map(({bytes,...part})=>({...part,bytes:bytes.length,sha256:sha(bytes)}));
        const f = parts.find(part=>part.filename !== undefined);
        if (f) { row.file={name:f.filename,bytes:f.bytes.length,sha256:sha(f.bytes)}; writeFileSync(`${directory}/server-file-${row.id}.bin`,f.bytes); }
      } else row.body = body.toString();
      rows.push(row); save(`${directory}/server.json`,rows);
      if (kind === 'forward-stop') await sleep(400);
      if (url.pathname === redirect) res.writeHead(307, { Location:sink }).end();
      else res.writeHead(200, { 'Content-Type':'text/html' }).end(`<p>stored ${row.id}</p>`);
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  });
  save(`${directory}/server.json`,rows);
  return { ...server, rows, resources, sink, redirect, good, bad, sourceHash, sourceBytes:source.length, filePath:`${directory}/${file}`,
    contract: { id:`contract-${id}`, method:'POST', path:kind === 'redirect' ? redirect : sink,
      contentType:kind.startsWith('upload') ? 'multipart/form-data' : kind === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(kind.startsWith('upload') ? { parts:[{name:'case',bytes:Buffer.byteLength(id),sha256:sha(id)},{name:'file',filename:file,bytes:source.length,sha256:sourceHash}] }
      : { bodySha256:sha(kind === 'form' ? new URLSearchParams({case:id,value:'1'}).toString() : good) }) } };
}
