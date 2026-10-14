import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveStartup, validationDirectory } from '../../app/desktop/startup';

const folders: string[] = [];
afterEach(() =>
  folders.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function folder(base = realpathSync(tmpdir())) {
  const p = mkdtempSync(path.join(base, 'startup-'));
  folders.push(p);
  return p;
}
const options = () => ({
  argv: [] as string[],
  connected: false,
  executable: process.execPath,
  parentPid: process.ppid,
  production: folder(),
  env: {} as NodeJS.ProcessEnv,
  probe: path.resolve('dist/native/process-path'),
  watcher: path.resolve('dist/native/watch-owner'),
});

test.skipIf(process.platform !== 'darwin')(
  '原生监督启动的真实子进程可核对拥有者并继承受限通道',
  async () => {
    const production = folder();
    const probe = path.resolve('dist/native/process-path');
    const watcher = path.resolve('dist/native/watch-owner');
    const script = `(async () => {
    const { resolveStartup } = await import(process.argv[1]);
    const result = resolveStartup({ argv:['--workspace-host','--remote-debugging-pipe'], connected:process.connected, executable:process.execPath, parentPid:process.ppid, production:process.argv[2], env:{HELPR_WORKSPACE_DATA:process.argv[2]}, probe:process.argv[3], watcher:process.argv[4] });
    process.send({result}, () => process.exit(0));
  })().catch(() => process.exit(1));`;
    const child = spawn(
      watcher,
      [
        process.execPath,
        '-e',
        script,
        pathToFileURL(path.resolve('app/desktop/startup.ts')).href,
        production,
        probe,
        watcher,
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
      },
    );
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('OWNED_STARTUP_TIMEOUT')),
          3000,
        );
        child.once('message', (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(result).toEqual({
        result: { role: 'host', root: production, validation: false },
      });
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        process.kill(-child.pid!, 'SIGKILL');
    }
  },
);

test('正常入口拒绝外部控制参数，测试入口仅使用固定独立资料区', () => {
  const input = options();
  expect(resolveStartup(input)).toEqual({
    role: 'controller',
    root: input.production,
    validation: false,
  });
  for (const arg of [
    '--remote-debugging-port=9222',
    '--remote-debugging-pipe',
    '--inspect=9229',
    '--remote-debugging-address=127.0.0.1',
    '-remote-debugging-port=9222',
    '-remote-debugging-pipe',
  ]) {
    expect(() => resolveStartup({ ...input, argv: [arg] })).toThrow(
      'STARTUP_NOT_AUTHORIZED',
    );
  }
  const safe = folder(validationDirectory());
  const validation = {
    ...input,
    argv: ['--workspace-validation'],
    connected: true,
    env: { HELPR_VALIDATION_DATA: safe },
  };
  expect(resolveStartup(validation).root).toBe(safe);
  expect(() =>
    resolveStartup({
      ...validation,
      env: { HELPR_VALIDATION_DATA: input.production },
    }),
  ).toThrow('VALIDATION_PROFILE_REQUIRED');
  const alias = path.join(safe, 'alias');
  symlinkSync(input.production, alias);
  expect(() =>
    resolveStartup({ ...validation, env: { HELPR_VALIDATION_DATA: alias } }),
  ).toThrow('VALIDATION_PROFILE_REQUIRED');
});

test.skipIf(process.platform !== 'darwin')(
  '宿主须经已核对的监督启动，直接父进程与继承 IPC 不足以授权',
  () => {
    const input = options();
    const host = {
      ...input,
      argv: ['--workspace-host', '--remote-debugging-pipe'],
      connected: true,
      parentPid: process.pid,
      env: { HELPR_WORKSPACE_DATA: input.production },
    };
    expect(() => resolveStartup(host)).toThrow('HOST_OWNER_REQUIRED');
    const foreign = path.join(folder(), 'foreign-executable');
    writeFileSync(foreign, 'not the actual parent executable');
    expect(() => resolveStartup({ ...host, executable: foreign })).toThrow(
      'HOST_OWNER_REQUIRED',
    );
    expect(() =>
      resolveStartup({
        ...host,
        argv: [...host.argv, '--remote-debugging-port=9222'],
      }),
    ).toThrow('STARTUP_NOT_AUTHORIZED');
  },
);
