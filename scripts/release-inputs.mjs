import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fileHash = (file) => sha256(fs.readFileSync(file));

// 只收集产品、构建与检查输入；不读取凭据、验证资料和生成目录。
export function captureReleaseInputs(root = process.cwd()) {
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }).trim();
  const names = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'app', 'scripts', 'tests/workspace', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', '.node-version', '*.config.*', 'tsconfig.json',
  ]).split('\0').filter(Boolean);
  const files = Object.fromEntries([...new Set(names)].sort().map((name) => {
    if (!fs.lstatSync(path.join(root, name)).isFile()) throw Error('RELEASE_INPUT_NOT_FILE');
    return [name, fileHash(path.join(root, name))];
  }));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const pnpm = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
  if (process.version !== `v${pkg.engines.node}` || pnpm !== pkg.engines.pnpm ||
      pkg.packageManager !== `pnpm@${pnpm}` ||
      fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim() !== pkg.engines.node)
    throw Error('RELEASE_TOOLCHAIN_MISMATCH');
  const format = fs.readFileSync(path.join(root, 'app/shared/record-format.ts'), 'utf8');
  const dataFormat = Number(format.match(/CURRENT_DATA_FORMAT = (\d+);/)?.[1]);
  const stateModel = Number(format.match(/CURRENT_STATE_MODEL = (\d+);/)?.[1]);
  if (!dataFormat || !stateModel) throw Error('RELEASE_FORMAT_MISSING');
  return {
    schema: 1, commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
    version: pkg.version, toolchain: { node: process.version, pnpm },
    dataFormat, stateModel, files, sha256: sha256(JSON.stringify(files)),
  };
}

export function assertSameInputs(before, after) {
  if (before.sha256 !== after.sha256 || JSON.stringify(before.files) !== JSON.stringify(after.files))
    throw Error('RELEASE_INPUT_CHANGED_DURING_BUILD');
}

// 固定整个包，包括解包的原生组件和资源；符号链接只记录内部目标，不跟随出包。
export function inventoryDirectory(root) {
  const result = [];
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(fs.realpathSync(root) + path.sep)) throw Error('RELEASE_LINK_OUTSIDE_BUNDLE');
      result.push({ path: relative, link: target });
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      result.push({ path: relative, bytes: stat.size, mode: stat.mode & 0o777, sha256: fileHash(file) });
    } else throw Error('RELEASE_SPECIAL_FILE');
  };
  visit('');
  return { files: result, sha256: sha256(JSON.stringify(result)) };
}
