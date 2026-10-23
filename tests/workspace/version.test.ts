import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VersionService } from '../../app/desktop/version-service';

let dispose = () => Promise.resolve();
afterEach(async () => dispose());

test('新版检查只取得版本信息，打开可信入口由用户另行选择，不下载或改变任务', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-version-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(folder, 'key.pem'),
      '-out',
      path.join(folder, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(path.join(folder, 'cert.pem'));
  const received: { url?: string; headers: unknown }[] = [];
  let downloads = 0;
  const server = createServer(
    { key: readFileSync(path.join(folder, 'key.pem')), cert },
    (req, res) => {
      received.push({ url: req.url, headers: req.headers });
      if (req.url !== '/stable.json') downloads++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schema: 1,
          version: '0.2.0',
          platform: 'darwin',
          arch: 'arm64',
          minOS: '14.0.0',
          dataFormats: [6],
          stateModels: [1],
          notes: ['改进结果查看。'],
          downloadURL:
            'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0',
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('FIXTURE_ADDRESS');
  const opened: string[] = [];
  const service = new VersionService({
    current: {
      version: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '14.8.3',
      dataFormat: 6,
      stateModel: 1,
    },
    source: `https://127.0.0.1:${address.port}/stable.json`,
    ca: cert,
    publish: () => {},
    open: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  });
  dispose = async () => {
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  };
  const status = await service.check('manual');
  expect(status.result?.kind).toBe('available');
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe('/stable.json');
  expect(received[0]?.headers).not.toHaveProperty('authorization');
  expect(received[0]?.headers).not.toHaveProperty('cookie');
  expect(opened).toEqual([]);
  expect(downloads).toBe(0);
  await service.handle({ kind: 'version-open', revision: status.revision });
  expect(opened).toEqual([
    'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0',
  ]);
  expect(received).toHaveLength(1);
  expect(downloads).toBe(0);
});

async function versionFixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'helpr-version-cases-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(folder, 'key.pem'),
      '-out',
      path.join(folder, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(path.join(folder, 'cert.pem'));
  const base = {
    schema: 1,
    version: '0.2.0',
    platform: 'darwin',
    arch: 'arm64',
    minOS: '14.0.0',
    dataFormats: [6],
    stateModels: [1],
    notes: ['改进结果查看。'],
    downloadURL: 'https://github.com/yuexiaoliang/helpr/releases/tag/v0.2.0',
  };
  let value: unknown = base,
    code = 200,
    raw: string | null = null,
    held = false;
  let release = () => {};
  const requests: string[] = [];
  const server = createServer(
    { key: readFileSync(path.join(folder, 'key.pem')), cert },
    (req, res) => {
      requests.push(req.url ?? '');
      const respond = () => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.setHeader('location', '/must-not-follow');
        res.end(raw ?? JSON.stringify(value));
      };
      if (held) release = respond;
      else respond();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('FIXTURE_ADDRESS');
  const services: VersionService[] = [];
  const service = (
    extra: Partial<ConstructorParameters<typeof VersionService>[0]> = {},
  ) => {
    const result = new VersionService({
      current: {
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: '14.8.3',
        dataFormat: 6,
        stateModel: 1,
      },
      source: `https://127.0.0.1:${address.port}/stable.json`,
      ca: cert,
      publish: () => {},
      open: () => Promise.resolve(),
      ...extra,
    });
    services.push(result);
    return result;
  };
  dispose = async () => {
    services.forEach((s) => s.dispose());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  };
  return {
    service,
    requests,
    base,
    response: (next: {
      patch?: object;
      code?: number;
      raw?: string | null;
      held?: boolean;
    }) => {
      value = { ...base, ...next.patch };
      code = next.code ?? 200;
      raw = next.raw ?? null;
      held = next.held ?? false;
    },
    release: () => release(),
  };
}

test('网络不可用和来源拒绝分别呈现，重定向不发送第二次请求', async () => {
  const f = await versionFixture(),
    service = f.service();
  f.response({ code: 503 });
  expect((await service.check('manual')).result?.kind).toBe('offline');
  f.response({ code: 302 });
  expect((await service.check('manual')).result?.kind).toBe('source');
  expect(f.requests).toEqual(['/stable.json', '/stable.json']);
});

test('当前自用版尚未提供安装包时仍可检查最新，不伪造下载入口', async () => {
  const f = await versionFixture(),
    service = f.service();
  f.response({ patch: { version: '0.1.0', downloadURL: null } });
  const status = await service.check('manual');
  expect(status.result?.kind).toBe('latest');
  await expect(
    service.handle({ kind: 'version-open', revision: status.revision }),
  ).rejects.toThrow('VERSION_LINK_UNAVAILABLE');
});

test('兼容及异常检查保留具体原因，拒绝可执行协议、其它目标和非本次入口', async () => {
  const f = await versionFixture(),
    opened: string[] = [],
    service = f.service({
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
  const cases: [object, string][] = [
    [{ version: '0.0.9', downloadURL: null }, 'older'],
    [{ arch: 'x64' }, 'architecture'],
    [{ platform: 'win32' }, 'architecture'],
    [{ minOS: '15.0.0' }, 'system'],
    [{ dataFormats: [7] }, 'data'],
    [{ stateModels: [2] }, 'data'],
    [{ downloadURL: 'javascript:alert(1)' }, 'link'],
    [
      { downloadURL: 'https://github.com/another/repo/releases/tag/v0.2.0' },
      'link',
    ],
    [
      {
        downloadURL:
          'https://github.com/yuexiaoliang/helpr/releases/tag/v0.3.0',
      },
      'link',
    ],
    [{ downloadURL: null }, 'link'],
    [{ version: 'bad' }, 'format'],
  ];
  for (const [patch, kind] of cases) {
    f.response({ patch });
    const status = await service.check('manual');
    expect(status.result?.kind).toBe(kind);
    expect(status.noticeVisible).toBe(false);
    await expect(
      service.handle({ kind: 'version-open', revision: status.revision }),
    ).rejects.toThrow('VERSION_LINK_UNAVAILABLE');
  }
  expect(opened).toEqual([]);
  f.response({ raw: '{broken' });
  expect((await service.check('manual')).result?.kind).toBe('format');
  f.response({ raw: ' '.repeat(32769) });
  expect((await service.check('manual')).result?.kind).toBe('format');
  expect(
    (await f.service({ ca: undefined }).check('manual')).result?.kind,
  ).toBe('source');
});

test('单次检查合并并发请求，历史成功不批准新失败，稍后不改事实或重复提醒', async () => {
  const f = await versionFixture(),
    service = f.service();
  const first = await service.check('automatic');
  expect(first.noticeVisible).toBe(true);
  await service.handle({ kind: 'version-dismiss' });
  const same = await service.check('automatic');
  expect(same.noticeVisible).toBe(false);
  f.response({ held: true });
  const one = service.check('manual'),
    two = service.check('manual');
  expect(one).toBe(two);
  await expect.poll(() => f.requests.length).toBe(3);
  await expect(
    service.handle({ kind: 'version-open', revision: first.revision }),
  ).rejects.toThrow('VERSION_LINK_UNAVAILABLE');
  f.release();
  await one;
  f.response({ code: 503 });
  const failed = await service.check('manual');
  expect(failed.result?.kind).toBe('offline');
  expect(failed.lastSuccess?.version).toBe('0.2.0');
  expect(failed.noticeVisible).toBe(false);
  await expect(
    service.handle({ kind: 'version-open', revision: failed.revision }),
  ).rejects.toThrow('VERSION_LINK_UNAVAILABLE');
  expect(f.requests).toHaveLength(4);
});

test('超时和退出均取消请求，退出后迟到结果不再投递', async () => {
  const f = await versionFixture();
  f.response({ held: true });
  expect(
    (await f.service({ timeoutMs: 40 }).check('manual')).result?.kind,
  ).toBe('timeout');
  let delivered = 0;
  const service = f.service({
    publish: () => {
      delivered++;
    },
  });
  const pending = service.check('manual');
  await expect.poll(() => f.requests.length).toBe(2);
  const before = delivered;
  service.dispose();
  f.release();
  await pending;
  expect(delivered).toBe(before);
});

test('提醒投递或外部页面打开失败不丢检查结果，状态入口仍可查看', async () => {
  const f = await versionFixture();
  const service = f.service({
    publish: () => {
      throw Error('DISPLAY_FAILED');
    },
    open: () => Promise.reject(Error('OPEN_FAILED')),
  });
  const status = await service.check('manual');
  expect(status.result?.kind).toBe('available');
  const after = await service.handle({
    kind: 'version-open',
    revision: status.revision,
  });
  expect(after.openFailed).toBe(true);
  expect((await service.handle({ kind: 'version-status' })).result?.kind).toBe(
    'available',
  );
});

test('启动自动检查后按24小时检查，停止后不再发送；重复启动不增加间隔', async () => {
  const { vi } = await import('vitest');
  const f = await versionFixture(),
    service = f.service();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    service.start();
    service.start();
    await expect.poll(() => service.get().phase).toBe('done');
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await expect.poll(() => f.requests.length).toBe(2);
    await expect.poll(() => service.get().phase).toBe('done');
    service.dispose();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(f.requests).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
