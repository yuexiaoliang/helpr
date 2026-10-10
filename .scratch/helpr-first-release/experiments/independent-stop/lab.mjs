import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function createLab(directory) {
  const events = [], holds = new Map(), counts = new Map();
  let writes = Promise.resolve();
  const log = event => {
    const row = { sequence: events.length + 1, at: Date.now(), ...event };
    events.push(row);
    writes = writes.then(() => appendFile(path.join(directory, 'events.jsonl'), JSON.stringify(row) + '\n'));
    return row;
  };
  const key = (scope, task, kind) => [scope, task, kind].join('/');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const scope = url.searchParams.get('scope'), task = url.searchParams.get('task'), operation = url.searchParams.get('kind');
      if (url.pathname === '/event') {
        let body = ''; for await (const chunk of req) body += chunk;
        log(JSON.parse(body)); res.end('ok'); return;
      }
      if (['/commit', '/permit', '/model'].includes(url.pathname)) {
        let bytes = 0; for await (const chunk of req) bytes += chunk.length;
        const id = key(scope, task, operation);
        log({ kind: 'server-accepted', route: url.pathname, scope, task, operation, bytes });
        const held = holds.get(id);
        if (held) await held.promise;
        // 网页请求确已到达；延迟后端结果，与取消客户端等待分开观察。
        if (url.pathname === '/commit') {
          await new Promise(resolve => setTimeout(resolve, 35));
          counts.set(id, (counts.get(id) || 0) + 1);
          log({ kind: 'server-committed', scope, task, operation, count: counts.get(id), bytes });
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ count: counts.get(id) || 0, action: 'increment' }));
        log({ kind: 'server-response', route: url.pathname, scope, task, operation });
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(await readFile(new URL('./fixture.html', import.meta.url)));
    } catch (error) { log({ kind: 'server-error', error: String(error) }); res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    events, log, base: `http://127.0.0.1:${server.address().port}`,
    hold(scope, task, operation) { const gate = deferred(); holds.set(key(scope, task, operation), gate); return gate; },
    count: (scope, task, operation) => counts.get(key(scope, task, operation)) || 0,
    releaseAll() { for (const gate of holds.values()) gate.resolve(); holds.clear(); },
    async wait(predicate, timeout = 6000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) { const event = events.find(predicate); if (event) return event; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('Expected event not observed');
    },
    async flush() { await writes; },
    async close() { for (const gate of holds.values()) gate.resolve(); await writes; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
