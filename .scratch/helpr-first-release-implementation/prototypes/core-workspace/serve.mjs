// PROTOTYPE: serves this directory only; all task state is held in the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const allowed = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (req, res) => {
  const file = allowed.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
  res.end(await readFile(new URL(file[0], import.meta.url)));
});
server.listen(Number(process.env.PROTOTYPE_PORT || 4317), '127.0.0.1', () => {
  console.log('helpr prototype: http://127.0.0.1:' + server.address().port + '/?variant=A');
});
