import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const folders: string[] = [],
  children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
test.skipIf(process.platform !== 'darwin')(
  '拥有者强退后清理已停止响应的自有进程，新启动取得租约前旧控制必须结束',
  async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'helpr-runtime-'));
    folders.push(folder);
    const script = `
    const { acquireRuntimeOwnership } = await import(process.argv[1]);
    const { spawn } = await import('node:child_process');
    const ownership = await acquireRuntimeOwnership(process.argv[2], process.argv[3]);
    const watcher = spawn(process.argv[4], ['--runtime-owner', process.execPath, '-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:['ignore','ignore','ignore','pipe','pipe','ipc','pipe',ownership.fd]});
    watcher.stdio[6].once('data', () => {
      const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      worker.once('spawn', () => process.send({ready:true,worker:worker.pid,watcher:watcher.pid}));
    });
    setInterval(()=>{},1000);
  `;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        pathToFileURL(path.resolve('app/desktop/runtime-ownership.ts')).href,
        folder,
        path.resolve('dist/native/input-bridge.node'),
        path.resolve('dist/native/watch-owner'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    children.push(child);
    const ready = await new Promise<{ worker: number; watcher: number }>(
      (resolve, reject) => {
        let error = '';
        child.stderr?.on('data', (chunk) => {
          error += chunk;
        });
        child.once('message', (data) =>
          resolve(data as { worker: number; watcher: number }),
        );
        child.once('exit', () => reject(Error(error || 'RUNTIME_NOT_READY')));
      },
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(ready.worker, 'SIGSTOP');
      child.kill('SIGKILL');
      const end = Date.now() + 3000;
      while (Date.now() < end && (alive(ready.worker) || alive(ready.watcher)))
        await new Promise((r) => setTimeout(r, 20));
      expect({
        worker: alive(ready.worker),
        watcher: alive(ready.watcher),
      }).toEqual({ worker: false, watcher: false });
      const next = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { acquireRuntimeOwnership } = await import(process.argv[1]); const {closeSync}=await import('node:fs'); const owner=await acquireRuntimeOwnership(process.argv[2],process.argv[3]); closeSync(owner.fd);`,
          pathToFileURL(path.resolve('app/desktop/runtime-ownership.ts')).href,
          folder,
          path.resolve('dist/native/input-bridge.node'),
        ],
        { stdio: 'ignore' },
      );
      children.push(next);
      const code = await new Promise<number | null>((resolve) =>
        next.once('exit', resolve),
      );
      expect(code).toBe(0);
    } finally {
      for (const pid of [ready.worker, ready.watcher])
        if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  },
);
