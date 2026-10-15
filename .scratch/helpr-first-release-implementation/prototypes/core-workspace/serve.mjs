// PROTOTYPE: serves this directory only; all task state is held in the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const allowed = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/foundation.html', ['foundation.html', 'text/html; charset=utf-8']],
  ['/execution-prototype.html', ['execution-prototype.html', 'text/html; charset=utf-8']],
  ['/model-understanding-prototype.html', ['model-understanding-prototype.html', 'text/html; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
  ...['plus', 'x', 'squares-four', 'sign-out', 'globe', 'warning-circle', 'wordpress', 'drupal']
    .map(name => [`/assets/${name}.svg`, [`assets/${name}.svg`, 'image/svg+xml']]),
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
