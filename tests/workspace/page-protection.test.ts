import { expect, test, vi } from 'vitest';
import {
  loadProtectedPage,
  verifyPageProtection,
} from '../../app/desktop/page-protection';

test('异步接口已初始化但钥匙串授权被取消时，不得开放原网站资料', async () => {
  const available = await verifyPageProtection({
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: () => Promise.reject(Error('KEYCHAIN_AUTH_CANCELLED')),
    decryptStringAsync: () => Promise.resolve({ result: '' }),
  });
  const load = vi.fn(async () => {});
  const unavailable = vi.fn();
  await loadProtectedPage({
    available: () => Promise.resolve(available),
    current: () => true,
    load,
    unavailable,
  });
  expect(load).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledOnce();
});

test('保护自检不能解回原随机文字时保持网页关闭', async () => {
  await expect(
    verifyPageProtection({
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      encryptStringAsync: () => Promise.resolve(Buffer.from('protected-test')),
      decryptStringAsync: () => Promise.resolve({ result: 'incorrect' }),
    }),
  ).resolves.toBe(false);
});

test('原保护可正常加解密随机自检值时，允许继续核对网页', async () => {
  await expect(
    verifyPageProtection({
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      encryptStringAsync: (value) => Promise.resolve(Buffer.from(value)),
      decryptStringAsync: (value) =>
        Promise.resolve({ result: value.toString() }),
    }),
  ).resolves.toBe(true);
});

test('等待系统保护授权时不加载网页，事件循环仍可处理其它工作', async () => {
  let authorize: (allowed: boolean) => void = () => {};
  const available = new Promise<boolean>((resolve) => (authorize = resolve));
  const load = vi.fn(async () => {});
  const unavailable = vi.fn();
  const work = loadProtectedPage({
    available: () => available,
    current: () => true,
    load,
    unavailable,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(load).not.toHaveBeenCalled();
  authorize(true);
  await work;
  expect(load).toHaveBeenCalledOnce();
  expect(unavailable).not.toHaveBeenCalled();
});

test('等待授权期间原网页失效时，迟到成功不加载旧地址', async () => {
  let authorize: (allowed: boolean) => void = () => {};
  let current = true;
  const available = new Promise<boolean>((resolve) => (authorize = resolve));
  const load = vi.fn(async () => {});
  const unavailable = vi.fn();
  const work = loadProtectedPage({
    available: () => available,
    current: () => current,
    load,
    unavailable,
  });
  current = false;
  authorize(true);
  await work;
  expect(load).not.toHaveBeenCalled();
  expect(unavailable).not.toHaveBeenCalled();
});

test.each([false, Error('SYSTEM_AUTH_CANCELLED')])(
  '保护不可用或授权取消时保留网页并提示，不放宽保护：%s',
  async (result) => {
    const load = vi.fn(async () => {});
    const unavailable = vi.fn();
    await loadProtectedPage({
      available: () =>
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result),
      current: () => true,
      load,
      unavailable,
    });
    expect(load).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
  },
);
