import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
// 产品只交付当前 Mac。Linux CI 仍检查跨平台的记录和界面，不抵算 Mac 原生核对。
if (process.platform === 'darwin') {
  if (process.arch !== 'arm64') throw Error('MAC_ARM64_REQUIRED');
  fs.mkdirSync('dist/native', { recursive: true });
  for (const name of ['process-path', 'watch-owner']) {
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=14.0', '-Wall', '-Wextra', '-Werror', `app/native/${name}.c`, '-o', `dist/native/${name}`], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', `dist/native/${name}`], { stdio: 'pipe' });
  }
}
