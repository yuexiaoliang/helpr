import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as playwrightRequest } from '../runtime-flow-replay/node_modules/playwright/index.mjs';
import { openProxy } from './proxy.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helpr-recovery-proxy-'));
  const mutations = [], reservations = [];
  const backend = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.method === 'POST') mutations.push({ path: req.url, reserved: [...reservations], body });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('fixture-bytes');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${backend.address().port}`;
  const proxy = await openProxy({ origin, root, reserve: async kind => { reservations.push(kind); }, ...options });
  t.after(async () => { await proxy.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { origin, proxy, mutations, reservations };
}

test('Playwright 的 HTTP CONNECT 读取保留字节，隧道内写请求仍被只读模式拦截', async t => {
  const f = await fixture(t, { mode: 'readonly' });
  const client = await playwrightRequest.newContext({ proxy: { server: f.proxy.url } });
  t.after(() => client.dispose());
  const read = await client.get(f.origin + '/file.xlsx');
  assert.equal(read.status(), 200); assert.equal((await read.body()).toString(), 'fixture-bytes');
  assert.equal((await client.post(f.origin + '/write', { data: 'no' })).status(), 403);
  assert.equal(f.mutations.length, 0);
});

test('查询参数形式的媒体上传也必须在转发前占用上传预算', async t => {
  const f = await fixture(t);
  const address = new URL(f.proxy.url);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: address.hostname, port: address.port, method: 'POST',
      path: f.origin + '/index.php?rest_route=%2Fwp%2Fv2%2Fmedia' }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end('file-content');
  });
  assert.deepEqual(f.reservations, ['upload']);
  assert.deepEqual(f.mutations[0].reserved, ['upload']);
});

test('扣住发布回执时后端已经执行一次，客户端尚未收到响应', async t => {
  const held = Promise.withResolvers();
  const f = await fixture(t, { mode: 'response-lost', onHeld: held.resolve });
  const address = new URL(f.proxy.url); let received = false;
  const req = http.request({ host: address.hostname, port: address.port, method: 'POST', path: f.origin + '/write' }, res => { received = true; res.resume(); });
  req.on('error', () => {}); t.after(() => req.destroy()); req.end(JSON.stringify({ status: 'publish' }));
  await held.promise;
  assert.equal(f.mutations.length, 1); assert.equal(received, false);
  assert.deepEqual(f.mutations[0].reserved, ['publication']);
});
