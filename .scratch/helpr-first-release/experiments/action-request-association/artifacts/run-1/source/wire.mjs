// 一次性本机 HTTP 装置：完整实体字节检查；不声称能证明发起动作或业务语义。
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export async function bodyOf(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('fixture-body-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 仅支持本实验的浏览器生成 multipart；其它编码报未知，不猜测文件字节。
export function multipart(contentType, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  if (!boundary) throw new Error('unknown-multipart-boundary');
  const mark = Buffer.from('--' + (boundary[1] || boundary[2]));
  const nextMark = Buffer.concat([Buffer.from('\r\n'), mark]);
  if (!body.subarray(0, mark.length).equals(mark)) throw new Error('unknown-preamble');
  let cursor = mark.length; const parts = [];
  while (true) {
    if (body.subarray(cursor, cursor + 2).toString() === '--') {
      const trailing = body.subarray(cursor + 2).toString();
      if (trailing !== '' && trailing !== '\r\n') throw new Error('unknown-epilogue');
      return parts;
    }
    if (body.subarray(cursor, cursor + 2).toString() !== '\r\n') throw new Error('unknown-separator');
    cursor += 2;
    const endHeaders = body.indexOf('\r\n\r\n', cursor);
    if (endHeaders < 0) throw new Error('incomplete-headers');
    const header = body.subarray(cursor, endHeaders).toString('utf8');
    const disposition = /^content-disposition: form-data; name="([^"\r\n]+)"(?:; filename="([^"\r\n]*)")?$/im.exec(header);
    if (!disposition) throw new Error('unknown-disposition');
    const end = body.indexOf(nextMark, endHeaders + 4);
    if (end < 0) throw new Error('incomplete-part');
    const bytes = body.subarray(endHeaders + 4, end);
    parts.push({ name: disposition[1], ...(disposition[2] !== undefined ? { filename: disposition[2] } : {}), bytes });
    cursor = end + nextMark.length;
  }
}

export async function serve(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500).end(error.message);
  }));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

export async function openGate({ origin, resourcePaths, directory, hold = false }) {
  const rows = []; let permit = null, generation = 0, releaseHeld;
  let heldSignal; const held = new Promise(resolve => { heldSignal = resolve; });
  const heldRelease = new Promise(resolve => { releaseHeld = resolve; });
  const flush = () => save(`${directory}/proxy.json`, rows);
  const gateway = await serve(async (request, response) => {
    const url = new URL(request.url, origin), body = await bodyOf(request);
    const row = { id: rows.length + 1, receivedAt: Date.now(), method: request.method, path: url.pathname + url.search,
      bytes: body.length, sha256: sha(body), generationAtReceipt: generation };
    rows.push(row);
    if (body.length) writeFileSync(`${directory}/proxy-${row.id}.bin`, body);
    const resource = url.origin === origin && request.method === 'GET' && body.length === 0 && resourcePaths.includes(row.path);
    const p = permit;
    let reason = 'no-active-contract';
    if (resource) reason = null;
    else if (p && !p.used && p.generation === generation && url.origin === origin && request.method === p.method && row.path === p.path) {
      try {
        if (p.contentType !== (request.headers['content-type'] || '').split(';')[0]) reason = 'content-type-mismatch';
        else if (p.bodySha256) reason = sha(body) === p.bodySha256 ? null : 'body-mismatch';
        else if (p.parts) {
          const parts = multipart(request.headers['content-type'] || '', body);
          row.parts = parts.map(({ bytes, ...part }) => ({ ...part, bytes: bytes.length, sha256: sha(bytes) }));
          reason = parts.length === p.parts.length && p.parts.every((expected, index) => {
            const actual = row.parts[index];
            return Object.keys(expected).every(key => expected[key] === actual[key]);
          }) ? null : 'multipart-mismatch';
        } else reason = 'unknown-body-contract';
      } catch (error) { reason = error.message; }
    } else if (p?.used) reason = 'contract-consumed';
    else if (p) reason = 'request-mismatch';
    if (!resource && !reason && hold) {
      row.heldAt = Date.now(); flush(); heldSignal(row); await heldRelease;
    }
    if (!resource && !reason && (p !== permit || p.generation !== generation || p.used)) reason = 'revoked-before-forward';
    if (reason) {
      Object.assign(row, { decision: 'blocked', reason }); flush(); response.writeHead(403).end(reason); return;
    }
    if (!resource) { p.used = true; row.contractId = p.id; }
    Object.assign(row, { decision: 'forwarded', resource, forwardedAt: Date.now() }); flush();
    const headers = { ...request.headers, host: url.host }; delete headers['proxy-connection'];
    const upstream = http.request(url, { method: request.method, headers }, result => {
      row.responseAt = Date.now(); row.status = result.statusCode; flush();
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on('error', error => {
      row.upstreamError = error.message; flush();
      if (!response.headersSent) response.writeHead(502); response.end();
    });
    upstream.end(body);
  });
  gateway.server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  gateway.server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  return { ...gateway, rows, held,
    arm(contract) { generation++; permit = { ...structuredClone(contract), generation, used: false }; return generation; },
    revoke() { generation++; permit = null; },
    release() { releaseHeld(); } };
}
