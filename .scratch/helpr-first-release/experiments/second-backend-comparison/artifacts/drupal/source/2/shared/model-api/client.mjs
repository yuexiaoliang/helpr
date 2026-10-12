import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// 实验用 Chat Completions 客户端；不是产品的提供方抽象。
export function validateConfig(config) {
  if (config.protocol !== 'openai-chat-completions') throw new Error('本实验仅实现 Chat Completions 协议');
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须是无凭据、无查询参数的 HTTP(S) 地址');
  if (!config.model?.trim() || !/^[A-Z_][A-Z0-9_]*$/i.test(config.apiKeyEnv)) throw new Error('需要模型名和凭据环境变量名');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120000) throw new Error('timeoutMs 必须在 100–120000 之间');
  if (!config.requestOptions || Array.isArray(config.requestOptions) || typeof config.requestOptions !== 'object') throw new Error('requestOptions 必须是对象');
  for (const key of ['model', 'messages', 'stream', 'tools', 'tool_choice', 'response_format']) {
    if (key in config.requestOptions) throw new Error('requestOptions 不能覆盖实验的控制字段');
  }
  return { ...config, baseUrl: url.href.replace(/\/$/, '') };
}

export async function loadConfig(configPath, envPath) {
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  let local = {};
  try { local = parseEnv(await readFile(envPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const apiKey = process.env[config.apiKeyEnv] || local[config.apiKeyEnv];
  return { config, apiKey };
}

export class ProbeError extends Error {
  constructor(code, httpStatus) { super(code); this.name = 'ProbeError'; this.code = code; this.httpStatus = httpStatus; }
}

const safeUsage = usage => Object.fromEntries(Object.entries(usage || {}).filter(([, value]) => typeof value === 'number'));

export function createClient(config, apiKey, records) {
  if (!apiKey?.trim()) throw new ProbeError('missing-api-key');
  const clean = value => typeof value === 'string' ? value.replaceAll(apiKey, '[redacted]') : value;
  async function request(label, body, { onDelta, signal } = {}) {
    const row = { label, startedAt: new Date().toISOString(), requestedModel: config.model };
    records.push(row);
    const start = performance.now();
    const combined = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(config.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ ...config.requestOptions, model: config.model, stream: false, ...body })
      });
      row.httpStatus = response.status;
      if (!response.ok) {
        row.retryAfter = clean(response.headers.get('retry-after'));
        // 不保存代理或提供方可能回显请求头的错误正文。
        await response.body?.cancel();
        throw new ProbeError('http-error', response.status);
      }
      if (!body.stream) {
        const data = await response.json();
        const choice = data.choices?.[0];
        if (!choice?.message || choice.message.role !== 'assistant') throw new ProbeError('invalid-response-shape');
        row.servedModel = clean(data.model); row.finishReason = clean(choice.finish_reason); row.usage = safeUsage(data.usage);
        return choice.message;
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new ProbeError('invalid-stream-type');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', content = '', doneMarker = false;
      const frame = raw => {
        combined.throwIfAborted();
        const text = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!text) return;
        if (text === '[DONE]') { doneMarker = true; return; }
        const data = JSON.parse(text), choice = data.choices?.[0], delta = choice?.delta?.content;
        row.servedModel = clean(data.model || row.servedModel);
        if (data.usage) row.usage = safeUsage(data.usage);
        if (choice?.finish_reason) row.finishReason = clean(choice.finish_reason);
        if (typeof delta === 'string' && delta) {
          row.firstContentMs ??= performance.now() - start;
          content += delta; onDelta?.(delta); combined.throwIfAborted();
        }
      };
      try {
        while (!doneMarker) {
          const { value, done } = await reader.read();
          if (done) { buffer += decoder.decode(); break; }
          buffer += decoder.decode(value, { stream: true });
          // 按完整换行规范化，避免 CRLF 恰好跨 chunk 时过早切帧。
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const raw = buffer.slice(0, match.index).replaceAll('\r\n', '\n');
            buffer = buffer.slice(match.index + match[0].length); frame(raw);
          }
        }
        if (buffer.trim() && !doneMarker) frame(buffer.replaceAll('\r\n', '\n'));
        if (!doneMarker) throw new ProbeError('incomplete-stream');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { role: 'assistant', content };
    } catch (error) {
      row.error = error instanceof ProbeError ? error.code : combined.aborted ? (combined.reason?.name === 'TimeoutError' ? 'timeout' : 'client-aborted') : 'transport-or-parse-error';
      throw new ProbeError(row.error, row.httpStatus);
    } finally { row.endedAt = new Date().toISOString(); row.durationMs = performance.now() - start; }
  }
  return { request };
}
