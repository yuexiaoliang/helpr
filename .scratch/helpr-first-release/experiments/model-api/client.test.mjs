import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient, validateConfig } from './client.mjs';

// 仅核对本机探针客户端；不读取 .env.local，不调用模型服务。
const fakeKey = 'local-fixture-credential';
const configFor = baseUrl => validateConfig({ protocol: 'openai-chat-completions', baseUrl, model: 'fixture-model', apiKeyEnv: 'FIXTURE_KEY', timeoutMs: 1000, requestOptions: { max_tokens: 32 } });
const reply = content => ({ model: 'fixture-served-model', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
async function serverFor(t, handle) {
  const server = http.createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const collect = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); };

test('配置校验拒绝 URL 内凭据和覆盖控制字段；缺 key 不创建请求', () => {
  const config = configFor('http://127.0.0.1:1');
  assert.throws(() => validateConfig({ ...config, baseUrl: 'https://user:secret@example.invalid' }));
  assert.throws(() => validateConfig({ ...config, requestOptions: { model: 'override' } }));
  const records = []; assert.throws(() => createClient(config, '', records), { code: 'missing-api-key' }); assert.equal(records.length, 0);
});

test('自定义路径和模型到达请求；secret 只在认证头，记录不包含 secret', async t => {
  let seen;
  const base = await serverFor(t, async (req, res) => { seen = { url: req.url, authorization: req.headers.authorization, body: await collect(req) }; res.setHeader('Content-Type', 'application/json'); res.end('\n\n' + JSON.stringify(reply('ok'))); });
  const records = [], client = createClient(configFor(base + '/custom/v1'), fakeKey, records);
  assert.equal((await client.request('plain', { messages: [{ role: 'user', content: 'hi' }] })).content, 'ok');
  assert.equal(seen.url, '/custom/v1/chat/completions'); assert.equal(seen.authorization, 'Bearer ' + fakeKey); assert.equal(seen.body.model, 'fixture-model');
  assert(!JSON.stringify(seen.body).includes(fakeKey)); assert(!JSON.stringify(records).includes(fakeKey)); assert.equal(records[0].usage.total_tokens, 3);
});

test('SSE 支持 keep-alive、CRLF 跨块和 UTF-8 跨块', async t => {
  const data = ': keep-alive\r\n\r\ndata: ' + JSON.stringify({ model: 'fixture', choices: [{ delta: { content: '中文测试' }, finish_reason: null }] }) + '\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(data);
  const base = await serverFor(t, async (req, res) => {
    await collect(req); res.setHeader('Content-Type', 'text/event-stream');
    for (let index = 0; index < bytes.length; index++) { res.write(bytes.subarray(index, index + 1)); await new Promise(resolve => setImmediate(resolve)); }
    res.end();
  });
  const records = [], client = createClient(configFor(base), fakeKey, records);
  assert.equal((await client.request('stream', { messages: [], stream: true })).content, '中文测试'); assert(records[0].firstContentMs >= 0);
});

test('取消 A 后不消费同一缓冲中的后续 delta；B 请求继续', async t => {
  const chunk = content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  const base = await serverFor(t, async (req, res) => {
    const body = await collect(req);
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply('B'))); return; }
    res.setHeader('Content-Type', 'text/event-stream'); res.end(chunk('first') + chunk('late') + 'data: [DONE]\n\n');
  });
  const records = [], client = createClient(configFor(base), fakeKey, records), controller = new AbortController(), observed = [];
  const a = client.request('A', { messages: [], stream: true }, { signal: controller.signal, onDelta(text) { observed.push(text); controller.abort(); } });
  const b = client.request('B', { messages: [] });
  await assert.rejects(a, { code: 'client-aborted' }); assert.equal((await b).content, 'B'); assert.deepEqual(observed, ['first']);
});

test('HTTP 错误正文即使回显 secret，也不进入错误和记录', async t => {
  const base = await serverFor(t, async (req, res) => { await collect(req); res.writeHead(401); res.end('echoed credential: ' + fakeKey); });
  const records = [], client = createClient(configFor(base), fakeKey, records);
  await assert.rejects(client.request('bad-auth', { messages: [] }), error => error.code === 'http-error' && error.httpStatus === 401 && !String(error).includes(fakeKey));
  assert(!JSON.stringify(records).includes(fakeKey));
});

test('不跟随重定向到其他认证目标', async t => {
  let destinationCalls = 0;
  const target = await serverFor(t, (req, res) => { destinationCalls++; res.end('{}'); });
  const base = await serverFor(t, async (req, res) => { await collect(req); res.writeHead(307, { Location: target }); res.end(); });
  const client = createClient(configFor(base), fakeKey, []);
  await assert.rejects(client.request('redirect', { messages: [] }), { code: 'transport-or-parse-error' }); assert.equal(destinationCalls, 0);
});
