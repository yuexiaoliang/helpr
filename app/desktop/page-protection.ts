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
