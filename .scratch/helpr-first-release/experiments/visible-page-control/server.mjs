import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function createLab(directory) {
  const events = [];
  let phase = 'boot';
  let writes = Promise.resolve();
  const log = entry => {
    const row = { recordedAt: new Date().toISOString(), phase, ...entry };
    events.push(row);
    writes = writes.then(() => appendFile(path.join(directory, 'events.jsonl'), JSON.stringify(row) + '\n'));
    return row;
  };
  const pending = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body || '{}');
        if (url.pathname === '/api/event') {
          log(data);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        if (url.pathname === '/api/pulse') {
          const id = randomUUID();
          const start = Date.now();
          log({ kind: 'server-operation-start', id, ...data, start, concurrent: [...pending.values()] });
          pending.set(id, data.task);
          setTimeout(() => {
            pending.delete(id);
            const end = Date.now();
            log({ kind: 'server-operation-end', id, ...data, start, end });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id, start, end }));
          }, 350);
          return;
        }
      }
      if (url.pathname === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ phase, count: events.length }));
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const html = await readFile(new URL('./fixture.html', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    events, log,
    setPhase(value) { phase = value; log({ kind: 'phase-start', value }); },
    async flush() { await writes; },
    async close() { await writes; server.close(); }
  };
}
