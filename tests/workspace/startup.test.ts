import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
});

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
  '宿主须由同一可执行程序拥有，伪装参数与继承 IPC 不足以授权',
  () => {
    const input = options();
    const host = {
      ...input,
      argv: ['--workspace-host', '--remote-debugging-pipe'],
      connected: true,
      parentPid: process.pid,
      env: { HELPR_WORKSPACE_DATA: input.production },
    };
    expect(resolveStartup(host)).toEqual({
      role: 'host',
      root: input.production,
      validation: false,
    });
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
    const outside = folder();
    mkdirSync(path.join(outside, 'browser'));
    expect(() =>
      resolveStartup({ ...host, env: { HELPR_WORKSPACE_DATA: outside } }),
    ).toThrow('HOST_PROFILE_REQUIRED');
  },
);
