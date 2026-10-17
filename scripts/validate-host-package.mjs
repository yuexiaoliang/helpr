import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getCurrentFuseWire } from '@electron/fuses';
import { verifyDevelopmentSignature } from './development-signing.mjs';

const bundle = path.resolve(process.argv[2] ?? 'dist/packages/mac-arm64/helpr.app');
const signing = verifyDevelopmentSignature(bundle);
const host = path.join(bundle, 'Contents/Frameworks/helpr Workspace.app');
const readInfo = app => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
const info = readInfo(host);
assert.equal(info.CFBundleIdentifier, 'local.helpr.desktop.workspace');
assert.equal(info.CFBundleExecutable, 'helpr Workspace Helper');
assert.equal(info.ElectronMainProcess, true, 'HOST_MAIN_BUNDLE_REQUIRED');
assert.equal(info.CFBundleName, 'helpr');
for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
  const helper = path.join(host, `Contents/Frameworks/helpr Helper${suffix}.app`);
  assert(fs.existsSync(path.join(helper, `Contents/MacOS/helpr Helper${suffix}`)), 'HOST_HELPER_MISSING');
  assert(readInfo(helper).CFBundleIdentifier.startsWith(info.CFBundleIdentifier + '.helper'));
}
const frame = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
assert(fs.existsSync(path.join(host, frame)), 'HOST_FRAMEWORK_MISSING');
assert(fs.realpathSync(path.join(host, frame)).startsWith(fs.realpathSync(host) + path.sep), 'HOST_FRAMEWORK_OUTSIDE_BUNDLE');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(path.join(host, 'Contents/Resources/app.asar')), hash(path.join(bundle, 'Contents/Resources/app.asar')));
assert.equal(hash(path.join(host, 'Contents/Resources/input-bridge.build.json')), hash(path.join(bundle, 'Contents/Resources/input-bridge.build.json')), 'HOST_INPUT_BRIDGE_MISMATCH');
// 证书签名的 CMS 时间可不同；CodeDirectory 覆盖相同代码及权限，不含 CMS 签名封装。
const bridges = ['Contents/Resources/input-bridge.node', 'Contents/Frameworks/helpr Workspace.app/Contents/Resources/input-bridge.node'].map(file => {
  assert.equal(execFileSync('/usr/bin/lipo', ['-archs', path.join(bundle,file)], {encoding:'utf8'}).trim(), 'arm64');
  const image = signing.images.find(image=>image.path===file);
  assert(image, 'HOST_INPUT_BRIDGE_MISSING');
  return image;
});
for (const key of ['codeDirectorySha256','identifier','requirement']) assert.equal(bridges[0][key],bridges[1][key],'HOST_INPUT_BRIDGE_MISMATCH');
const executable = path.join(host, 'Contents/MacOS', info.CFBundleExecutable);
assert(!fs.readFileSync(executable).includes(Buffer.from('This is a helper executable and cannot be launched directly')), 'BROWSER_ENTRY_REQUIRED');
const loadCommands = execFileSync('/usr/bin/otool', ['-l', executable], { encoding: 'utf8' });
assert(loadCommands.includes('path @executable_path/../Frameworks '), 'HOST_RPATH_REQUIRED');
assert.deepEqual(await getCurrentFuseWire(host), await getCurrentFuseWire(bundle));
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
console.log(JSON.stringify({ hostLayout: 'standard complete main bundle', helpers: 4, independentIdentity: true, sameApplicationArchive: true, sameFuses: true, deepStrictSignatureVerified: true, certificateSha256: signing.certificateSha256, signedImages: signing.images.length }));
