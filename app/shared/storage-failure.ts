/** 仅固定系统错误码穿过进程边界，Drizzle 的外层 SQL/参数及任意错误原文不导出。 */
export function storageFailure(
  error: unknown,
): 'STORAGE_FULL' | 'STORAGE_UNAVAILABLE' | null {
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === 'object';
    depth++
  ) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === 'ENOSPC' || e.code === 'EDQUOT' || e.code === 'SQLITE_FULL')
      return 'STORAGE_FULL';
    if (
      typeof e.code === 'string' &&
      (/^SQLITE_(IOERR|READONLY|CANTOPEN)(_|$)/.test(e.code) ||
        ['EROFS', 'EACCES', 'EPERM', 'EIO'].includes(e.code))
    )
      return 'STORAGE_UNAVAILABLE';
    current = e.cause;
  }
  return null;
}
