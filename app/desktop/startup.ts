import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const debuggingSwitches = [
  'remote-debugging-port',
  'remote-debugging-address',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
];

// 固定 OS 目录，不使用调用者的 TMPDIR；资料必须是真实子目录。
export function validationDirectory(): string {
  const base = realpathSync(
    process.platform === 'darwin' ? '/private/tmp' : '/tmp',
  );
  const root = path.join(
    base,
    `helpr-workspace-validation-${process.getuid?.() ?? 'local'}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root)
    throw new Error('VALIDATION_PROFILE_REQUIRED');
  return root;
}
function validationProfile(input: string | undefined): string {
  if (!input) throw new Error('VALIDATION_PROFILE_REQUIRED');
  const root = validationDirectory();
  const actual = realpathSync(input);
  if (actual !== path.resolve(input) || !actual.startsWith(root + path.sep))
    throw new Error('VALIDATION_PROFILE_REQUIRED');
  return actual;
}

/** 应用启动公开边界；完成检查前不能设置资料区或打开网页。 */
export function resolveStartup(input: {
  argv: string[];
  runtimeSwitches?: string[];
  connected: boolean;
  executable: string;
  parentPid: number;
  production: string;
  env: NodeJS.ProcessEnv;
  probe: string;
  watcher: string;
}): { role: 'controller' | 'host'; root: string; validation: boolean } {
  const switches = [
    ...input.argv
      .filter((arg) => arg.startsWith('-'))
      .map((arg) => arg.replace(/^-{1,2}/, '').split('=')[0]),
    ...(input.runtimeSwitches ?? []),
  ];
  const host = switches.includes('workspace-host');
  const validation = switches.includes('workspace-validation');
  if (
    switches.some(
      (arg) =>
        arg?.startsWith('remote-debugging-') &&
        !(host && arg === 'remote-debugging-pipe'),
    ) ||
    switches.some((arg) => arg?.startsWith('inspect'))
  )
    throw new Error('STARTUP_NOT_AUTHORIZED');
  if (host) {
    if (
      !input.connected ||
      validation ||
      !switches.includes('remote-debugging-pipe') ||
      process.platform !== 'darwin'
    )
      throw new Error('HOST_OWNER_REQUIRED');
    // proc_pidpath 读取 OS 中的映像路径，不信任 argv[0]、自报 PID 或环境令牌。
    let owner: string;
    try {
      owner = execFileSync(input.probe, [String(input.parentPid)], {
        encoding: 'utf8',
        timeout: 2000,
        env: {},
        maxBuffer: 8192,
      }).trim();
      if (realpathSync(owner) !== realpathSync(input.watcher))
        throw new Error();
      const controller = execFileSync(
        input.probe,
        ['--parent-of', String(input.parentPid)],
        { encoding: 'utf8', timeout: 2000, env: {}, maxBuffer: 8192 },
      ).trim();
      if (realpathSync(controller) !== realpathSync(input.executable))
        throw new Error();
    } catch {
      throw new Error('HOST_OWNER_REQUIRED');
    }
    const root = input.env.HELPR_WORKSPACE_DATA;
    if (root === path.resolve(input.production))
      return { role: 'host', root, validation: false };
    try {
      return { role: 'host', root: validationProfile(root), validation: true };
    } catch {
      throw new Error('HOST_PROFILE_REQUIRED');
    }
  }
  if (validation) {
    if (!input.connected) throw new Error('VALIDATION_PROFILE_REQUIRED');
    return {
      role: 'controller',
      root: validationProfile(input.env.HELPR_VALIDATION_DATA),
      validation: true,
    };
  }
  return {
    role: 'controller',
    root: path.resolve(input.production),
    validation: false,
  };
}
