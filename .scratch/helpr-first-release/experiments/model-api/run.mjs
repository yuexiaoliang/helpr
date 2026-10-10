import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient, loadConfig, ProbeError } from './client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
let defaultConfig = path.join(root, 'config.local.json');
try { await access(defaultConfig); } catch { defaultConfig = path.join(root, 'config.example.json'); }
const configPath = path.resolve(option('--config') || defaultConfig);
const envPath = path.resolve(option('--env') || path.join(root, '.env.local'));
const { config, apiKey } = await loadConfig(configPath, envPath);
const identity = { name: config.name, protocol: config.protocol, baseUrl: config.baseUrl, model: config.model, credentialVariable: config.apiKeyEnv };
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ configPath, ...identity, credentialAvailable: Boolean(apiKey?.trim()), networkRequests: 0 }, null, 2));
  process.exit(apiKey?.trim() ? 0 : 2);
}
if (!apiKey?.trim()) { console.error('缺少本机 API Key，请填写 .env.local 或设置配置指定的环境变量。'); process.exit(2); }

const out = path.join(root, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
await writeFile(path.join(root, 'artifacts/latest.txt'), out + '\n');
const report = { startedAt: new Date().toISOString(), configuration: identity, requestOptions: config.requestOptions, node: process.version, scope: 'synthetic API probes, not browser-agent compatibility or a reliability benchmark', requests: [], checks: [] };
const client = createClient(config, apiKey, report.requests);
const save = async () => {
  // 最终写盘再次遮盖精确凭据；不保存请求头或原始响应正文。
  const text = (JSON.stringify(report, null, 2) + '\n').replaceAll(apiKey, '[redacted]');
  await writeFile(path.join(out, 'results.json'), text);
};
const user = content => [{ role: 'user', content }];
const requireThat = (value, code) => { if (!value) throw new ProbeError(code); };
const exact = (actual, expected) => requireThat(actual?.trim() === expected, 'unexpected-content');
async function check(name, body) {
  const row = { name }; report.checks.push(row);
  try { row.evidence = await body(); row.status = 'passed'; }
  catch (error) { row.status = 'failed'; row.error = error instanceof ProbeError ? error.code : 'validation-error'; row.httpStatus = error.httpStatus; }
  console.log(row.status.toUpperCase() + ' ' + name + (row.error ? ' (' + row.error + ')' : ''));
  await save(); return row.status === 'passed';
}

try {
  const connected = await check('text', async () => {
    const message = await client.request('text', { messages: user('请只回复 HELPR_READY，不加标点或解释。') });
    exact(message.content, 'HELPR_READY'); return { expectedMatched: true };
  });
  if (!connected) throw new ProbeError('initial-probe-failed');
  await check('json-output', async () => {
    const message = await client.request('json-output', { response_format: { type: 'json_object' }, messages: user('请输出 JSON 对象，只有 status 和 value 两个字段，值分别为字符串 ok 和数字 7。') });
    const data = JSON.parse(message.content);
    requireThat(data.status === 'ok' && data.value === 7 && Object.keys(data).length === 2, 'invalid-json-fields');
    return { value: data, mode: 'json_object with local field validation; not server-enforced JSON Schema' };
  });
  await check('tool-roundtrip', async () => {
    const tools = [{ type: 'function', function: { name: 'inspect_fixture', description: '查询指定合成任务的校验码。', parameters: { type: 'object', properties: { task: { type: 'string', enum: ['task-A'] } }, required: ['task'], additionalProperties: false } } }];
    const messages = user('请调用 inspect_fixture 查询 task-A，取得结果后只回复工具返回的 code。');
    const message = await client.request('tool-call', { messages, tools, tool_choice: { type: 'function', function: { name: 'inspect_fixture' } } });
    const call = message.tool_calls?.[0];
    requireThat(message.tool_calls?.length === 1 && call.type === 'function' && call.function.name === 'inspect_fixture' && typeof call.id === 'string', 'invalid-tool-call');
    const args = JSON.parse(call.function.arguments);
    requireThat(args.task === 'task-A' && Object.keys(args).length === 1, 'invalid-tool-arguments');
    const code = 'TOOL-' + randomBytes(4).toString('hex').toUpperCase();
    const result = await client.request('tool-result', { tools, tool_choice: 'none', messages: [...messages, message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ code }) }] });
    exact(result.content, code); return { function: call.function.name, arguments: args, returnedCodeMatched: true };
  });
  await check('page-text-understanding', async () => {
    const snapshot = '- heading "财务周报"\n- button "保存草稿"\n- button "提交发布" [disabled]\n- status "等待内容确认"';
    const message = await client.request('page-text-understanding', { response_format: { type: 'json_object' }, messages: user('根据以下合成页面快照，返回 JSON {"enabledButton": "可用按钮原文", "disabledButton": "不可用按钮原文"}。\n' + snapshot) });
    const data = JSON.parse(message.content);
    requireThat(data.enabledButton === '保存草稿' && data.disabledButton === '提交发布', 'incorrect-page-reading'); return data;
  });
  await check('vision', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const code = 'IMG-' + randomBytes(3).toString('hex').toUpperCase();
    let screenshot;
    try {
      const page = await browser.newPage({ viewport: { width: 1080, height: 680 }, deviceScaleFactor: 1 });
      await page.setContent(await readFile(path.join(root, 'fixture.html'), 'utf8'));
      await page.locator('#code').evaluate((element, text) => { element.textContent = '校验码：' + text; }, code);
      await page.screenshot({ path: path.join(out, 'vision.png') });
      screenshot = await readFile(path.join(out, 'vision.png'));
    } finally { await browser.close(); }
    const message = await client.request('vision', { response_format: { type: 'json_object' }, messages: user([
      { type: 'text', text: '读取截图右上角的完整校验码和当前可用按钮的文字，返回 JSON {"code":"...","enabledButton":"..."}。只根据图片作答。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + screenshot.toString('base64'), detail: 'high' } }
    ]) });
    const data = JSON.parse(message.content);
    requireThat(data.code === code && data.enabledButton === '保存草稿', 'incorrect-image-reading');
    return { expectedCode: code, observed: data, image: 'vision.png' };
  });
  await check('two-concurrent-requests', async () => {
    const codes = ['A-', 'B-'].map(prefix => prefix + randomBytes(3).toString('hex').toUpperCase());
    const messages = await Promise.all(codes.map((code, index) => client.request('parallel-' + index, { messages: user('请只回复 ' + code) })));
    messages.forEach((message, index) => exact(message.content, codes[index]));
    const rows = report.requests.filter(row => row.label.startsWith('parallel-'));
    const overlapMs = Math.min(...rows.map(row => Date.parse(row.endedAt))) - Math.max(...rows.map(row => Date.parse(row.startedAt)));
    requireThat(overlapMs > 0, 'no-observed-client-overlap');
    return { independentRepliesMatched: true, clientRequestOverlapMs: overlapMs, serverScheduling: 'not observable; not a quota benchmark' };
  });
  await check('streaming', async () => {
    const message = await client.request('streaming', { messages: user('请只回复 HELPR_STREAM_READY'), stream: true });
    exact(message.content, 'HELPR_STREAM_READY'); return { textMatched: true, receivedDoneMarker: true };
  });
  await check('client-cancellation', async () => {
    const controller = new AbortController(); let chunks = 0, requestedAt;
    try {
      await client.request('client-cancellation', { messages: user('请逐个输出从 1 到 200 的整数，每个数单独一行，不要解释。'), stream: true }, { signal: controller.signal, onDelta() { chunks++; if (!controller.signal.aborted) { requestedAt = performance.now(); controller.abort(); } } });
      throw new ProbeError('request-completed-before-cancellation');
    } catch (error) {
      requireThat(error.code === 'client-aborted' && chunks > 0, 'cancellation-not-observed');
      return { chunksBeforeCancellation: chunks, settledAfterAbortMs: performance.now() - requestedAt, providerWorkCancelled: 'unknown' };
    }
  });
} catch (error) { report.stoppedEarly = error instanceof ProbeError ? error.code : 'experiment-error'; }
finally {
  report.endedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ directory: out, requests: report.requests.length, checks: report.checks.length, failed: report.checks.filter(row => row.status === 'failed').map(row => row.name) }));
  if (report.stoppedEarly || report.checks.some(row => row.status === 'failed')) process.exitCode = 1;
}
