import { afterEach, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WorkspaceRecords } from '../../app/records/workspace';
import {
  ModelService,
  type CredentialProtection,
} from '../../app/desktop/model-service';
import type { PageObservation } from '../../app/shared/model';

const folders: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
async function backend(
  mode:
    | 'normal'
    | 'delayed'
    | 'missing'
    | 'partial'
    | 'echo'
    | 'auth'
    | 'redirect'
    | 'stream-error'
    | 'planning' = 'normal',
  redirectTo = '',
) {
  const received: { body: string; authorization: string | undefined }[] = [];
  const held: (() => void)[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ body, authorization: req.headers.authorization });
      if (mode === 'redirect') {
        res.writeHead(302, { Location: redirectTo });
        res.end();
        return;
      }
      if (mode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'echo test-secret-only',
              type: 'authentication_error',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (value: unknown) =>
        res.write(`data: ${JSON.stringify(value)}\n\n`);
      const finish = () => {
        chunk({
          id: 'test',
          choices: [
            {
              index: 0,
              delta: {
                content:
                  mode === 'planning'
                    ? JSON.stringify({
                        decision: 'act',
                        summary: '核对草稿内容。',
                        evidence: ['状态：草稿'],
                        previous: null,
                        action: {
                          kind: 'click',
                          target: { role: 'button', name: '核对', exact: true },
                        },
                      })
                    : mode === 'echo'
                      ? '不应显示 test-secret-only'
                      : '页面中的营收为 34.8 万元。',
              },
              finish_reason: null,
            },
          ],
        });
        if (mode === 'stream-error') {
          chunk({
            error: { message: 'echo test-secret-only', type: 'server_error' },
          });
          res.end();
          return;
        }
        chunk({
          id: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(mode === 'missing'
            ? {}
            : {
                usage: {
                  prompt_tokens: 80,
                  completion_tokens: 15,
                  ...(mode === 'partial' ? {} : { total_tokens: 95 }),
                },
              }),
        });
        res.end('data: [DONE]\n\n');
      };
      if (mode === 'delayed' && body.includes('延迟 A')) {
        res.flushHeaders();
        held.push(finish);
      } else finish();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_TEST_PORT');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    received,
    release: () => held.splice(0).forEach((finish) => finish()),
  };
}
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-model-'));
  folders.push(folder);
  const records = new WorkspaceRecords(folder, 'app/records/migrations');
  const key = randomBytes(32);
  const protection: CredentialProtection = {
    protect(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    reveal(value: string) {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
  let state = records.snapshot();
  const observe = (taskId: string): Promise<PageObservation> =>
    Promise.resolve({
      url: 'https://example.com/report',
      title: '经营周报',
      fingerprint: taskId,
      generation: 1,
      observedAt: Date.now(),
      truncated: false,
      text: '营收：34.8 万元；状态：草稿',
    });
  const service = new ModelService({
    records: (input) => Promise.resolve(records.model(input)),
    protection,
    observe,
    current: () => state,
    publish: (next) => {
      state = next;
    },
  });
  const create = (name: string) => {
    const result = records.execute({
      kind: 'create',
      requestId: name,
      goal: `核对 ${name} https://example.com/report`,
    });
    state = result.state;
    return result.taskId;
  };
  return {
    service,
    records,
    create,
    folder,
    get: () => state,
    protection,
    observe,
  };
}

test('配置后从所属任务提问，真实请求只含该任务观察，回复与用量可靠保留', async () => {
  const server = await backend(),
    f = fixture();
  try {
    const a = f.create('A');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'settings',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    await f.service.ask({
      kind: 'message',
      requestId: 'ask-a',
      taskId: a,
      text: '这页营收是多少？',
    });
    await f.service.settled();
    const reply = f.get().tasks[0]?.messages.at(-1);
    expect(reply?.text).toBe('页面中的营收为 34.8 万元。');
    expect(reply?.call).toMatchObject({
      phase: 'complete',
      inputTokens: 80,
      outputTokens: 15,
      totalTokens: 95,
    });
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.body).toContain('营收：34.8 万元');
    expect(server.received[0]?.authorization).toBe('Bearer test-secret-only');
    expect(JSON.stringify(f.get())).not.toContain('test-secret-only');
    f.records.close();
    const reopened = new WorkspaceRecords(f.folder, 'app/records/migrations');
    expect(reopened.snapshot().tasks[0]?.messages.at(-1)).toEqual(reply);
    reopened.close();
  } catch (error) {
    f.records.close();
    throw error;
  }
});

test('A 请求取消后迟到内容不再接入，切换服务后的 B 使用新配置且独立完成', async () => {
  const first = await backend('delayed'),
    second = await backend(),
    f = fixture();
  try {
    const a = f.create('A 专属'),
      b = f.create('B 专属');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'old',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: first.endpoint,
      model: 'old-chat',
      apiKey: 'test-secret-only',
    });
    await f.service.ask({
      kind: 'message',
      requestId: 'ask-a',
      taskId: a,
      text: '延迟 A，先只看本页',
    });
    await vi.waitFor(() => expect(first.received).toHaveLength(1));
    await f.service.configure({
      kind: 'model-save',
      requestId: 'new',
      expectedVersion: 1,
      protocol: 'chat-completions',
      endpoint: second.endpoint,
      model: 'new-chat',
    });
    await f.service.ask({
      kind: 'message',
      requestId: 'ask-b',
      taskId: b,
      text: '核对 B 本页',
    });
    await f.service.cancel(a, 'ask-a');
    first.release();
    await f.service.settled();
    expect(f.get().tasks[0]?.messages.at(-1)).toMatchObject({
      text: '',
      call: { phase: 'cancelled', model: 'old-chat', totalTokens: null },
    });
    expect(f.get().tasks[1]?.messages.at(-1)?.call).toMatchObject({
      phase: 'complete',
      model: 'new-chat',
      configurationVersion: 2,
    });
    expect(first.received[0]?.body).not.toContain('B 专属');
    expect(second.received[0]?.body).not.toContain('A 专属');
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('认证错误不自动重试、不暴露原始回显；同一请求重试不会重新发送', async () => {
  const server = await backend('auth'),
    f = fixture();
  try {
    const a = f.create('认证');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    const question = {
      kind: 'message' as const,
      requestId: 'one',
      taskId: a,
      text: '核对页面',
    };
    await f.service.ask(question);
    await f.service.settled();
    expect(f.get().tasks[0]?.messages.at(-1)?.call).toMatchObject({
      phase: 'error',
      error: 'MODEL_AUTHENTICATION',
      totalTokens: null,
    });
    await f.service.ask(question);
    await f.service.settled();
    expect(server.received).toHaveLength(1);
    expect(JSON.stringify(f.get())).not.toContain('test-secret-only');
    await expect(
      f.service.ask({ ...question, text: '同身份但不同内容' }),
    ).rejects.toThrow('REQUEST_CONTENT_CONFLICT');
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('缺少原始用量字段时保持未知，重新打开和重试原请求都不重发或清零', async () => {
  const server = await backend('partial'),
    f = fixture();
  let reopened: WorkspaceRecords | undefined;
  try {
    const a = f.create('未知用量');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    const question = {
      kind: 'message' as const,
      requestId: 'unknown',
      taskId: a,
      text: '核对页面',
    };
    await f.service.ask(question);
    await f.service.settled();
    expect(f.get().tasks[0]?.messages.at(-1)?.call).toMatchObject({
      phase: 'complete',
      inputTokens: null,
      totalTokens: null,
    });
    const reserved = f.get().tasks[0]?.messages.at(-1)?.call?.reservedTokens;
    expect(reserved).toBeGreaterThan(0);
    f.records.close();
    reopened = new WorkspaceRecords(f.folder, 'app/records/migrations');
    let state = reopened.snapshot();
    const service = new ModelService({
      records: (input) => Promise.resolve(reopened!.model(input)),
      current: () => state,
      publish: (next) => {
        state = next;
      },
      protection: f.protection,
      observe: f.observe,
    });
    await service.ask(question);
    await service.settled();
    expect(server.received).toHaveLength(1);
    expect(state.tasks[0]?.messages.at(-1)?.call).toMatchObject({
      reservedTokens: reserved,
      totalTokens: null,
    });
  } finally {
    if (reopened) reopened.close();
    else f.records.close();
  }
});

test('凭据暂不可访问时不发送，原密文保留；服务回显密钥时不进入会话', async () => {
  const server = await backend('echo'),
    f = fixture();
  try {
    const a = f.create('保护');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    const reveal = f.protection.reveal.bind(f.protection);
    f.protection.reveal = () => {
      throw new Error('hardware unavailable');
    };
    await f.service.ask({
      kind: 'message',
      requestId: 'locked',
      taskId: a,
      text: '核对页面',
    });
    await f.service.settled();
    expect(server.received).toHaveLength(0);
    expect(f.get().tasks[0]?.messages.at(-1)?.call).toMatchObject({
      error: 'MODEL_CREDENTIAL_UNAVAILABLE',
      dispatched: false,
    });
    f.protection.reveal = reveal;
    await f.service.ask({
      kind: 'message',
      requestId: 'echo',
      taskId: a,
      text: '核对页面',
    });
    await f.service.settled();
    expect(server.received).toHaveLength(1);
    expect(f.get().tasks[0]?.messages.at(-1)?.call?.error).toBe(
      'MODEL_RESPONSE_REDACTED',
    );
    expect(JSON.stringify(f.get())).not.toContain('test-secret-only');
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('请求上限跨重开保留，超过 20 次不再向服务发送', async () => {
  const server = await backend(),
    f = fixture();
  let reopened: WorkspaceRecords | undefined;
  try {
    const a = f.create('额度');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    for (let i = 0; i < 20; i++) {
      await f.service.ask({
        kind: 'message',
        requestId: 'call-' + i,
        taskId: a,
        text: '核对本页',
      });
      await f.service.settled();
    }
    expect(server.received).toHaveLength(20);
    f.records.close();
    reopened = new WorkspaceRecords(f.folder, 'app/records/migrations');
    let state = reopened.snapshot();
    const service = new ModelService({
      records: (input) => Promise.resolve(reopened!.model(input)),
      current: () => state,
      publish: (next) => {
        state = next;
      },
      protection: f.protection,
      observe: f.observe,
    });
    await service.ask({
      kind: 'message',
      requestId: 'over-limit',
      taskId: a,
      text: '核对本页',
    });
    await service.settled();
    expect(server.received).toHaveLength(20);
    expect(state.tasks[0]?.messages.at(-1)?.call).toMatchObject({
      phase: 'error',
      dispatched: false,
      error: 'MODEL_LIMIT',
    });
  } finally {
    if (reopened) reopened.close();
    else f.records.close();
  }
});

test('认证请求不跟随服务重定向，流式错误也不触发隐式重试', async () => {
  const destination = await backend(),
    redirect = await backend('redirect', destination.endpoint),
    stream = await backend('stream-error'),
    f = fixture();
  try {
    const a = f.create('网络边界');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: redirect.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    await f.service.ask({
      kind: 'message',
      requestId: 'redirect',
      taskId: a,
      text: '核对页面',
    });
    await f.service.settled();
    expect(redirect.received).toHaveLength(1);
    expect(destination.received).toHaveLength(0);
    await f.service.configure({
      kind: 'model-save',
      requestId: 'next',
      expectedVersion: 1,
      protocol: 'chat-completions',
      endpoint: stream.endpoint,
      model: 'test-chat',
    });
    await f.service.ask({
      kind: 'message',
      requestId: 'stream-error',
      taskId: a,
      text: '核对页面',
    });
    await f.service.settled();
    expect(stream.received).toHaveLength(1);
    expect(f.get().tasks[0]?.messages.at(-1)?.call).toMatchObject({
      phase: 'error',
      totalTokens: null,
    });
    expect(JSON.stringify(f.get())).not.toContain('test-secret-only');
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('关键请求记录保存失败时禁止发送', async () => {
  const server = await backend(),
    f = fixture();
  try {
    const a = f.create('保存失败');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    chmodSync(f.folder, 0o500);
    await expect(
      f.service.ask({
        kind: 'message',
        requestId: 'blocked',
        taskId: a,
        text: '核对页面',
      }),
    ).rejects.toThrow('MODEL_RECORDS_UNAVAILABLE');
    expect(server.received).toHaveLength(0);
  } finally {
    chmodSync(f.folder, 0o700);
    await f.service.stopAll();
    f.records.close();
  }
});

test('已发送请求中断后保留未知预留，重新打开不自动重发', async () => {
  const server = await backend('delayed'),
    f = fixture();
  let reopened: WorkspaceRecords | undefined;
  try {
    const a = f.create('中断');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    const question = {
      kind: 'message' as const,
      requestId: 'interrupted',
      taskId: a,
      text: '延迟 A，等待结果',
    };
    await f.service.ask(question);
    await vi.waitFor(() => expect(server.received).toHaveLength(1));
    f.service.disable();
    await f.service.settled();
    f.records.close();
    reopened = new WorkspaceRecords(f.folder, 'app/records/migrations');
    let state = reopened.snapshot();
    const call = state.tasks[0]?.messages.at(-1)?.call;
    expect(call).toMatchObject({
      phase: 'interrupted',
      error: 'MODEL_INTERRUPTED',
      totalTokens: null,
      dispatched: true,
    });
    expect(call?.reservedTokens).toBeGreaterThan(0);
    const service = new ModelService({
      records: (input) => Promise.resolve(reopened!.model(input)),
      current: () => state,
      publish: (next) => {
        state = next;
      },
      protection: f.protection,
      observe: f.observe,
    });
    await service.ask(question);
    await service.settled();
    expect(server.received).toHaveLength(1);
    expect(state.tasks[0]?.messages.at(-1)?.call?.phase).toBe('interrupted');
  } finally {
    if (reopened) reopened.close();
    else {
      await f.service.stopAll();
      f.records.close();
    }
  }
});

test('凭据访问仍在等待时可以停止，迟到授权不会发出旧请求', async () => {
  const server = await backend(),
    f = fixture();
  let resolveKey: (key: string) => void = () => {};
  const keyReady = new Promise<string>((resolve) => {
    resolveKey = resolve;
  });
  let reading = false;
  try {
    const a = f.create('等待系统授权');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'config',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    f.protection.reveal = () => {
      reading = true;
      return keyReady;
    };
    await f.service.ask({
      kind: 'message',
      requestId: 'waiting',
      taskId: a,
      text: '核对页面',
    });
    await vi.waitFor(() => expect(reading).toBe(true));
    await f.service.cancel(a, 'waiting');
    await f.service.settled();
    resolveKey('test-secret-only');
    await Promise.resolve();
    expect(server.received).toHaveLength(0);
    expect(f.get().tasks[0]?.messages.at(-1)?.call).toMatchObject({
      phase: 'cancelled',
      dispatched: false,
    });
  } finally {
    resolveKey('test-secret-only');
    await f.service.stopAll();
    f.records.close();
  }
});

test('执行提议仍经过实际SDK计数入口，界面只展示摘要，不泄露原始动作结构', async () => {
  const server = await backend('planning'),
    f = fixture();
  try {
    const taskId = f.create('A');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'settings',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    const observation = await f.observe(taskId);
    const step = await f.service.propose({
      taskId,
      runId: 'run',
      goal: '核对草稿',
      observation,
      pending: null,
      history: [],
      signal: new AbortController().signal,
    });
    expect(step).toMatchObject({
      decision: 'act',
      action: { kind: 'click', target: { name: '核对' } },
    });
    expect(server.received).toHaveLength(1);
    expect(f.get().tasks[0]?.messages.at(-1)?.text).toBe('核对草稿内容。');
    expect(JSON.stringify(f.get())).not.toContain('"decision"');
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('规划后页面已有变化，提议保留为旧依据但不交付执行或完成任务', async () => {
  const server = await backend('planning'),
    f = fixture();
  try {
    const taskId = f.create('A');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'settings',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    await expect(
      f.service.propose({
        taskId,
        runId: 'run',
        goal: '核对草稿',
        observation: {
          ...(await f.observe(taskId)),
          fingerprint: 'earlier-page',
        },
        pending: null,
        history: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('EXECUTION_PAGE_CHANGED');
    expect(f.get().tasks[0]?.messages.at(-1)?.call?.pageChanged).toBe(true);
    expect(server.received).toHaveLength(1);
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('原生资格已撤销但异步取消未到达时，实际模型网络入口也不发送新请求', async () => {
  const server = await backend('planning'),
    f = fixture();
  try {
    const taskId = f.create('A');
    await f.service.configure({
      kind: 'model-save',
      requestId: 'settings',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'test-chat',
      apiKey: 'test-secret-only',
    });
    await expect(
      f.service.propose({
        taskId,
        runId: 'run',
        goal: '核对草稿',
        observation: await f.observe(taskId),
        pending: null,
        history: [],
        signal: new AbortController().signal,
        permit: () => {
          throw Error('INPUT_QUALIFICATION_REVOKED');
        },
      }),
    ).rejects.toThrow('MODEL_CANCELLED');
    expect(server.received).toHaveLength(0);
    expect(f.get().tasks[0]?.messages.at(-1)?.call?.totalTokens).toBeNull();
  } finally {
    await f.service.stopAll();
    f.records.close();
  }
});

test('本机虚构凭据不依赖系统凭据，只接受公开哨兵并完成真实本机问答', async () => {
  const { LocalFixture, FIXTURE_API_KEY } =
    await import('../../app/desktop/local-fixture');
  const server = await backend();
  const f = fixture();
  const local = new LocalFixture(new URL(server.endpoint).origin);
  const service = new ModelService({
    records: (input) => Promise.resolve(f.records.model(input)),
    protection: local,
    observe: f.observe,
    current: () => f.records.snapshot(),
    publish: () => {},
  });
  try {
    const taskId = f.create('fixture-task');
    await expect(
      service.configure({
        kind: 'model-save',
        requestId: 'deny-real-key',
        expectedVersion: 0,
        protocol: 'chat-completions',
        endpoint: server.endpoint,
        model: 'local',
        apiKey: 'real-key-must-be-rejected',
      }),
    ).rejects.toThrow('MODEL_CREDENTIAL_UNAVAILABLE');
    expect(f.records.snapshot().modelSettings).toBeNull();
    await service.configure({
      kind: 'model-save',
      requestId: 'fixture-settings',
      expectedVersion: 0,
      protocol: 'chat-completions',
      endpoint: server.endpoint,
      model: 'local',
      apiKey: FIXTURE_API_KEY,
    });
    await service.ask({
      kind: 'message',
      requestId: 'fixture-question',
      taskId,
      text: '营收是多少？',
    });
    await service.settled();
    expect(
      f.records
        .snapshot()
        .tasks.find((t) => t.id === taskId)
        ?.messages.at(-1)?.call?.phase,
    ).toBe('complete');
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.authorization).toBe('Bearer ' + FIXTURE_API_KEY);
    expect(() => local.reveal('foreign-production-ciphertext')).toThrow(
      'MODEL_CREDENTIAL_UNAVAILABLE',
    );
    expect(local.partition.startsWith('persist:')).toBe(false);
    for (const url of [
      'https://example.com',
      'http://127.0.0.1:1/elsewhere',
      'file:///tmp/data',
      'http://user@' + new URL(server.endpoint).host,
    ])
      expect(local.allowsRequest(url)).toBe(false);
    expect(local.allowsRequest(new URL('/page/A', server.endpoint).href)).toBe(
      true,
    );
    expect(() => local.checkModel('https://example.com/v1')).toThrow(
      'INVALID_MODEL_ENDPOINT',
    );
  } finally {
    await service.stopAll();
    f.records.close();
  }
});
