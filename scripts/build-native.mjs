import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// 产品只交付当前 Mac。Linux CI 仍检查跨平台的记录和界面，不抵算 Mac 原生核对。
if (process.platform === 'darwin') {
  if (process.arch !== 'arm64') throw Error('MAC_ARM64_REQUIRED');
  fs.mkdirSync('dist/native', { recursive: true });
  execFileSync(process.execPath, ['node_modules/node-gyp/bin/node-gyp.js', 'rebuild', '--directory', 'app/native', '--arch=arm64'], { stdio: 'inherit' });
  fs.copyFileSync('app/native/build/Release/input_bridge.node', 'dist/native/input-bridge.node');
  fs.writeFileSync('dist/native/input-bridge.build.json', JSON.stringify({
    node: process.version, napi: 8, nodeGyp: JSON.parse(fs.readFileSync('node_modules/node-gyp/package.json', 'utf8')).version,
    architecture: 'arm64', deploymentTarget: '14.0', sdk: execFileSync('/usr/bin/xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).trim(),
    sdkBuild: execFileSync('/usr/bin/xcrun', ['--show-sdk-build-version'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(['app/native/input-bridge.mm', 'app/native/binding.gyp'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  }, null, 2)+'\n');
  for (const name of ['process-path', 'watch-owner']) {
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=14.0', '-Wall', '-Wextra', '-Werror', `app/native/${name}.c`, '-o', `dist/native/${name}`], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', `dist/native/${name}`], { stdio: 'pipe' });
  }
}
