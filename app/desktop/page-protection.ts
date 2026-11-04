import { randomUUID } from 'node:crypto';

export async function verifyPageProtection(storage: {
  isAsyncEncryptionAvailable: () => Promise<boolean>;
  encryptStringAsync: (value: string) => Promise<Buffer>;
  decryptStringAsync: (value: Buffer) => Promise<{ result: string }>;
}): Promise<boolean> {
  try {
    if (!(await storage.isAsyncEncryptionAvailable())) return false;
    // Electron的可用性仅表示异步接口已初始化；取消钥匙串后实际加密仍可能失败。
    // 先核对临时随机值能受保护往返，再允许Chromium接触原网站Cookie。
    const probe = randomUUID();
    const encrypted = await storage.encryptStringAsync(probe);
    return (await storage.decryptStringAsync(encrypted)).result === probe;
  } catch {
    return false;
  }
}

export async function loadProtectedPage(ports: {
  available: () => Promise<boolean>;
  current: () => boolean;
  load: () => Promise<unknown>;
  unavailable: () => void;
}): Promise<void> {
  const available = await ports.available().catch(() => false);
  // 系统授权等待期间，任务、地址或原生视图都可能已经变化。
  if (!ports.current()) return;
  if (!available) {
    ports.unavailable();
    return;
  }
  await ports.load();
}
