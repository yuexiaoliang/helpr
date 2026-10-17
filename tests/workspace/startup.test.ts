import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  resolveStartup,
  runtimeImages,
  validationDirectory,
} from '../../app/desktop/startup';

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
  '宿主在JS初始化前退出时，原生监督保留实际退出码',
  async () => {
    const child = spawn(
      path.resolve('dist/native/watch-owner'),
      [process.execPath, '-e', 'process.exit(64)'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
      },
    );
    let receipt = '';
    child.stdio.at(6)?.on('data', (data: Buffer) => {
      receipt += data.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('NATIVE_EXIT_RECEIPT_TIMEOUT')),
          3000,
        );
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(receipt.split('\n')).toContain('exit:64:0');
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        process.kill(-child.pid!, 'SIGKILL');
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  '安装布局中的独立宿主映像须由同包控制者经原生监督启动',
  async () => {
    const bundle = path.join(folder(), 'helpr.app');
    const controller = path.join(bundle, 'Contents/MacOS/helpr');
    const host = path.join(
      bundle,
      'Contents/Frameworks/helpr Workspace.app/Contents/MacOS/helpr Workspace Helper',
    );
    for (const file of [controller, host]) {
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync(process.execPath, file);
    }
    const production = folder();
    const fixtureProfile = folder(validationDirectory());
    const hostScript = `(async () => {
      const { resolveStartup } = await import(process.argv[1]);
      const result = resolveStartup({ argv:['--workspace-host','--remote-debugging-pipe'], connected:process.connected, executable:process.execPath, controllerExecutable:process.argv[5], hostExecutable:process.execPath, parentPid:process.ppid, production:process.argv[2], env:{HELPR_WORKSPACE_DATA:process.argv[2]}, probe:process.argv[3], watcher:process.argv[4] });
      const base = {argv:['--workspace-host','--remote-debugging-pipe','--workspace-fixture'],connected:process.connected,executable:process.execPath,controllerExecutable:process.argv[5],hostExecutable:process.execPath,parentPid:process.ppid,production:process.argv[2],probe:process.argv[3],watcher:process.argv[4]};
      const fixture = resolveStartup({...base,env:{HELPR_WORKSPACE_DATA:process.argv[6],HELPR_FIXTURE_ORIGIN:'http://127.0.0.1:43210'}});
      let rejected;try{resolveStartup({...base,env:{HELPR_WORKSPACE_DATA:process.argv[2],HELPR_FIXTURE_ORIGIN:'http://127.0.0.1:43210'}});}catch(error){rejected=error.message;}
      process.send({result,fixture,rejected}, () => process.exit(0));
    })().catch(() => process.exit(1));`;
    const controllerScript = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.argv[1], [process.argv[2], '-e', process.argv[3], ...process.argv.slice(4)], {detached:true,stdio:['ignore','ignore','ignore','pipe','pipe','ipc','pipe']});
      child.on('message', m => process.send(m));
      child.once('exit', code => process.exit(code ?? 1));
    `;
    const child = spawn(
      controller,
      [
        '-e',
        controllerScript,
        path.resolve('dist/native/watch-owner'),
        host,
        hostScript,
        pathToFileURL(path.resolve('app/desktop/startup.ts')).href,
        production,
        path.resolve('dist/native/process-path'),
        path.resolve('dist/native/watch-owner'),
        controller,
        fixtureProfile,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('DISTINCT_HOST_STARTUP_TIMEOUT'));
      }, 5000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('DISTINCT_HOST_NOT_STARTED'));
      });
    });
    expect(result).toEqual({
      result: { role: 'host', root: production, validation: false },
      fixture: {
        role: 'host',
        root: fixtureProfile,
        validation: true,
        fixtureOrigin: 'http://127.0.0.1:43210',
      },
      rejected: 'STARTUP_NOT_AUTHORIZED',
    });
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  },
);

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

test('宿主普通打开只转交外层入口，不能冒用控制者或继承任意通道', () => {
  const bundle = path.join(folder(), '我的 helpr.app');
  const controller = path.join(bundle, 'Contents/MacOS/helpr');
  const host = path.join(
    bundle,
    'Contents/Frameworks/helpr Workspace.app/Contents/MacOS/helpr Workspace Helper',
  );
  for (const file of [controller, host]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'test image');
  }
  const images = runtimeImages(controller, true);
  expect(runtimeImages(host, true)).toEqual(images);
  const input = {
    ...options(),
    controllerExecutable: images.controller,
    hostExecutable: images.host,
  };
  expect(resolveStartup({ ...input, executable: host })).toEqual({
    role: 'reopen',
    root: input.production,
    validation: false,
  });
  expect(() =>
    resolveStartup({ ...input, executable: host, connected: true }),
  ).toThrow('APPLICATION_IMAGE_REQUIRED');
  expect(() =>
    resolveStartup({
      ...input,
      executable: controller,
      argv: ['--workspace-host', '--remote-debugging-pipe'],
      connected: true,
    }),
  ).toThrow('APPLICATION_IMAGE_REQUIRED');
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

test('无人值守虚构入口必须显式选择且仅绑定继承通道、临时资料与本机来源', () => {
  const input = options();
  expect(() =>
    resolveStartup({
      ...input,
      argv: ['--workspace-fixture'],
      env: { HELPR_FIXTURE_ORIGIN: 'http://127.0.0.1:43210' },
    }),
  ).toThrow('STARTUP_NOT_AUTHORIZED');
  const valid = {
    ...input,
    argv: ['--workspace-validation', '--workspace-fixture'],
    connected: true,
    env: {
      HELPR_VALIDATION_DATA: folder(validationDirectory()),
      HELPR_FIXTURE_ORIGIN: 'http://127.0.0.1:43210',
    },
  };
  expect(resolveStartup(valid)).toMatchObject({
    validation: true,
    fixtureOrigin: 'http://127.0.0.1:43210',
  });
  for (const origin of [
    'https://example.com',
    'http://localhost:43210',
    'http://127.0.0.1:43210/path',
    'http://user@127.0.0.1:43210',
    '',
  ])
    expect(() =>
      resolveStartup({
        ...valid,
        env: { ...valid.env, HELPR_FIXTURE_ORIGIN: origin },
      }),
    ).toThrow('VALIDATION_PROFILE_REQUIRED');
  expect(() => resolveStartup({ ...valid, connected: false })).toThrow(
    'VALIDATION_PROFILE_REQUIRED',
  );
  expect(() =>
    resolveStartup({
      ...valid,
      env: { ...valid.env, HELPR_VALIDATION_DATA: input.production },
    }),
  ).toThrow('VALIDATION_PROFILE_REQUIRED');
});
