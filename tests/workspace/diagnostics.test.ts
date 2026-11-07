import { expect, test } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { diagnostics } from '../../app/shared/diagnostics';

test('诊断创建失败单独反馈，不抛出原始异常或删除既有业务资料', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helpr-diagnostics-'));
  try {
    await writeFile(path.join(dir, 'diagnostics'), 'owned sentinel');
    const log = diagnostics(dir, 'records');
    let failed = 0;
    log.onFailure(() => failed++);
    log.event('failure', { code: 'private error https://example.test?secret' });
    expect(failed).toBe(1);
    expect(log.healthy()).toBe(false);
    await new Promise<void>((resolve) => log.close(resolve));
    expect(await readFile(path.join(dir, 'diagnostics'), 'utf8')).toBe(
      'owned sentinel',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实轮转仅处理所属角色日志，跨进程限制保留数量，任意异常、网页及密钥字段不导出', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helpr-diagnostics-'));
  try {
    const logs = path.join(dir, 'diagnostics');
    await mkdir(logs);
    for (let i = 1; i <= 9; i++)
      await writeFile(path.join(logs, `controller.${i}.log`), 'old log\n');
    const sentinels = [
      'workspace.sqlite',
      'materials',
      'records.1.log',
      'browser-login',
      'evidence.json',
    ];
    for (const file of sentinels)
      await writeFile(path.join(logs, file), 'must retain');
    const log = diagnostics(dir, 'controller');
    log.event('failure', {
      code: 'secret web raw exception',
      taskId: 'https://private.example',
    });
    log.event('failure', { code: 'ARBITRARY_PRIVATE_EXCEPTION' });
    for (let i = 0; i < 35000; i++)
      log.event('command', {
        code: 'DIAGNOSTIC_ROTATION_CHECK',
        taskId: '00000000-0000-0000-0000-000000000000',
        durationMs: i,
      });
    await new Promise<void>((resolve) => log.close(resolve));
    expect(log.healthy()).toBe(true);
    const files = (await readdir(logs)).filter((s) =>
      /^controller\.\d+\.log$/.test(s),
    );
    expect(files.length).toBeLessThanOrEqual(5);
    expect(files.length).toBeGreaterThan(0);
    for (const file of sentinels)
      expect(await readFile(path.join(logs, file), 'utf8')).toBe('must retain');
    for (const file of files) {
      const text = await readFile(path.join(logs, file), 'utf8');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('private.example');
      expect(text).not.toContain('ARBITRARY_PRIVATE_EXCEPTION');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
