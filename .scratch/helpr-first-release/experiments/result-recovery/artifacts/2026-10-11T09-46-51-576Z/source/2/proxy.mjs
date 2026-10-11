// 故障装置专用：站点请求知识只在这里用于控制时机，不供恢复判定读取。
import http from 'node:http';
import { event } from './common.mjs';

export async function openProxy({ origin, root, mode, reserve, onHeld, hideResult = false }) {
  const rows = [], connections = new Set(); let held = false;
  const log = async row => { rows.push(row); await event(root, row); };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) { response.writeHead(403).end(); return; }
      const readonly = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (mode === 'readonly' && !readonly) { await log({ type: 'blocked-write', method: request.method, path: url.pathname }); response.writeHead(403).end(); return; }
      if (hideResult && url.searchParams.has('p')) { await log({ type: 'hidden-result', path: url.pathname }); response.writeHead(503).end('暂时无法读取测试结果'); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let data; try { data = JSON.parse(body); } catch {}
      const publishing = !readonly && data?.status === 'publish';
      const uploading = !readonly && (url.pathname.includes('/media') || url.pathname.endsWith('/async-upload.php'));
      const kind = publishing ? 'publication' : uploading ? 'upload' : 'other';
      if (publishing || uploading) await reserve(kind);
      const row = { type: 'forward', method: request.method, path: url.pathname, kind };
      if (!readonly) await log(row);
      const headers = { ...request.headers, host: url.host }; delete headers['proxy-connection'];
      const upstream = http.request(url, { method: request.method, headers }, async result => {
        if (!(publishing && mode === 'response-lost' && !held)) {
          if (!readonly) await log({ ...row, type: 'upstream-response', status: result.statusCode });
          response.writeHead(result.statusCode, result.headers); result.pipe(response); return;
        }
        const responseChunks = []; for await (const chunk of result) responseChunks.push(chunk);
        const resultBody = Buffer.concat(responseChunks);
        if (!readonly) await log({ ...row, type: 'upstream-response', status: result.statusCode });
        if (publishing && mode === 'response-lost' && !held) {
          held = true;
          await log({ type: 'response-withheld', status: result.statusCode, bytes: resultBody.length });
          await onHeld?.({ status: result.statusCode });
          return;
        }
        response.writeHead(result.statusCode, result.headers); response.end(resultBody);
      });
      upstream.on('error', async error => { await log({ type: 'upstream-error', code: error.code }); if (!response.headersSent) response.writeHead(502); response.end(); });
      upstream.end(body);
    } catch (error) {
      await log({ type: 'proxy-error', error: error.message });
      if (!response.headersSent) response.writeHead(503); response.end();
    }
  });
  server.on('connect', (request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, rows,
    async close() { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
