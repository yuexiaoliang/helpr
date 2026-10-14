import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build, Platform, Arch } from 'electron-builder';
import {
  flipFuses,
  getCurrentFuseWire,
  FuseVersion,
  FuseV1Options as F,
} from '@electron/fuses';
import { spend, validationRoot } from './workspace-budget.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('MAC_ARM64_REQUIRED');
if (
  fs.readFileSync('node_modules/electron/dist/version', 'utf8').trim() !==
  '44.7.2'
)
  throw Error('ELECTRON_VERSION_MISMATCH');
const budget = spend('builds');
const output = path.resolve('dist/packages');
const manifest = {
  build: budget.used.builds,
  started: new Date().toISOString(),
  toolchain: { node: process.version, pnpm: '11.7.0' },
  appId: 'local.helpr.desktop',
  signature: 'ad-hoc, current Mac self-use only',
  hashes: {},
};
try {
  execFileSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' });
  execFileSync('./node_modules/.bin/electron-vite', ['build'], {
    stdio: 'inherit',
  });
  await build({
    targets: Platform.MAC.createTarget(['dir'], Arch.arm64),
    config: {
      electronDist: path.resolve('node_modules/electron/dist'),
      appId: manifest.appId,
      productName: 'helpr',
      directories: { output },
      files: [
        'dist/main/**',
        'dist/preload/**',
        'dist/renderer/**',
        'package.json',
      ],
      extraResources: [
        { from: 'app/records/migrations', to: 'migrations' },
        { from: 'dist/native/process-path', to: 'process-path' },
        { from: 'app/renderer/assets/PHOSPHOR-LICENSE.txt', to: 'licenses/PHOSPHOR-LICENSE.txt' },
      ],
      asar: true,
      asarUnpack: ['**/*.node'],
      npmRebuild: true,
      nativeRebuilder: 'sequential',
      mac: {
        identity: '-',
        minimumSystemVersion: '14.0',
        category: 'public.app-category.productivity',
        hardenedRuntime: false,
      },
      afterPack: async (context) => {
        const appPath = path.join(context.appOutDir, 'helpr.app');
        await flipFuses(appPath, {
          version: FuseVersion.V1,
          [F.RunAsNode]: false,
          [F.EnableCookieEncryption]: true,
          [F.EnableNodeOptionsEnvironmentVariable]: false,
          [F.EnableNodeCliInspectArguments]: false,
          [F.EnableEmbeddedAsarIntegrityValidation]: true,
          [F.OnlyLoadAppFromAsar]: true,
          [F.GrantFileProtocolExtraPrivileges]: false,
        });
        manifest.fuses = await getCurrentFuseWire(appPath);
      },
    },
  });
  const appPath = path.join(output, 'mac-arm64/helpr.app');
  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', appPath],
    { stdio: 'pipe' },
  );
  for (const file of ['Contents/MacOS/helpr', 'Contents/Resources/app.asar'])
    manifest.hashes[file] = createHash('sha256')
      .update(fs.readFileSync(path.join(appPath, file)))
      .digest('hex');
  manifest.prepared = true;
  manifest.app = appPath;
} catch (error) {
  manifest.prepared = false;
  manifest.error = error.message;
  process.exitCode = 1;
}
fs.writeFileSync(
  path.join(validationRoot, `build-${budget.used.builds}.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    build: manifest.build,
    prepared: manifest.prepared,
    app: manifest.app,
    error: manifest.error,
  }),
);
