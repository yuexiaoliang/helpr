import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { captureReleaseInputs, assertSameInputs, inventoryDirectory, fileHash } from './release-inputs.mjs';
import { prepareReleaseNotices } from './release-notices.mjs';

// 只读核对固定构建；不会启动应用、安装、读取用户配置或联系模型／业务网站。
const args = process.argv.slice(2);
if (args.length !== 2 || !args[0].startsWith('--manifest=') || !args[1].startsWith('--out='))
  throw Error('USAGE: node scripts/validate-release.mjs --manifest=<build.json> --out=<new-directory>');
const manifestFile = path.resolve(args[0].slice(11));
const output = path.resolve(args[1].slice(6));
fs.mkdirSync(output, { recursive: false, mode: 0o700 });
const build = JSON.parse(fs.readFileSync(manifestFile));
const report = {
  schema: 1, checkedAt: new Date().toISOString(), scope: 'artifact-preflight-only',
  build: build.build, manifestSha256: fileHash(manifestFile),
  artifactVerified: false, licenseMaterialsComplete: false,
  releaseAccepted: false,
  notEvaluated: ['clean-install', 'real-model', 'real-websites', 'business-matrix',
    'native-human-input', 'manual-upgrade', 'full-data-recovery', 'performance'],
};
try {
  assert(build.prepared && build.source && build.bundle, 'RELEASE_PROVENANCE_REQUIRED');
  assertSameInputs(build.source, captureReleaseInputs());
  const bundle = inventoryDirectory(build.app);
  assert.deepEqual(bundle, build.bundle, 'RELEASE_BUNDLE_CHANGED');
  report.bundleSha256 = bundle.sha256;
  report.fileCount = bundle.files.length;
  execFileSync(process.execPath, ['scripts/validate-host-package.mjs', build.app], {
    timeout: 60000, stdio: 'pipe', maxBuffer: 1024 * 1024,
  });
  report.hostAndSignatureVerified = true;
  const resources = path.join(build.app, 'Contents/Resources');
  const source = JSON.parse(fs.readFileSync(path.join(resources, 'release/SOURCE.json')));
  assert.deepEqual(source, build.source, 'RELEASE_SOURCE_METADATA_CHANGED');
  const dependenciesFile = path.join(resources, 'release/DEPENDENCIES.json');
  assert.equal(fileHash(dependenciesFile), build.releaseMetadataSha256);
  const dependencies = JSON.parse(fs.readFileSync(dependenciesFile));
  assert.deepEqual(dependencies, build.dependencies);
  assert.equal(dependencies.lockSha256, source.files['pnpm-lock.yaml']);
  if (dependencies.schema >= 2) {
    const expected = path.join(output, 'notices');
    prepareReleaseNotices(expected);
    assert.deepEqual(
      inventoryDirectory(path.join(resources, 'release')).files.filter((file) => file.path !== 'SOURCE.json'),
      inventoryDirectory(expected).files,
      'PACKAGED_RELEASE_NOTICES_CHANGED',
    );
    report.packagedNoticesVerified = true;
  }
  const require = createRequire(import.meta.url);
  const asar = createRequire(require.resolve('electron-builder'))('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map((f) => f.slice(1));
  const readJSON = (file) => JSON.parse(asar.extractFile(archive, file));
  const pkg = readJSON('package.json');
  assert.equal(pkg.version, source.version);
  assert.equal(pkg.helprBuild, build.build);
  report.packages = files.filter((f) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(f)).map((file) => {
    const item = readJSON(file);
    const expected = dependencies.packages.find((p) => p.name === item.name && p.version === item.version);
    assert(expected, `UNLISTED_PACKAGED_DEPENDENCY:${item.name}@${item.version}`);
    return { name: item.name, version: item.version, archivePath: file };
  }).sort((a, b) => a.archivePath.localeCompare(b.archivePath, 'en'));
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    const item = report.packages.find((p) => p.name === name);
    assert(item, `DIRECT_DEPENDENCY_MISSING:${name}`);
    const installed = dependencies.packages.find((p) => p.name === name);
    assert.equal(item.version, installed.version);
    if (!version.startsWith('https:')) assert.equal(item.version, version);
  }
  report.sourceOnlyPackages = dependencies.packages.filter((p) => !report.packages.some((i) => i.name === p.name && i.version === p.version)).map((p) => `${p.name}@${p.version}`);
  report.nativeComponents = bundle.files.filter((f) => /\.node$|\/process-path$|\/watch-owner$|input-bridge.build.json$/.test(f.path));
  const migrations = inventoryDirectory(path.join(resources, 'migrations'));
  assert.deepEqual(migrations, inventoryDirectory(path.resolve('app/records/migrations')), 'PACKAGED_MIGRATIONS_CHANGED');
  report.migrations = migrations;
  report.version = source.version;
  report.dataFormat = source.dataFormat;
  report.stateModel = source.stateModel;
  report.sourceSha256 = source.sha256;
  report.toolchain = source.toolchain;
  report.missingRootLicense = dependencies.missingRootLicense;
  report.licenseMaterialsComplete = dependencies.missingRootLicense.length === 0;
  report.artifactVerified = true;
  if (!report.licenseMaterialsComplete) process.exitCode = 2;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(output, 'PREFLIGHT.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ build: report.build, artifactVerified: report.artifactVerified,
    licenseMaterialsComplete: report.licenseMaterialsComplete, releaseAccepted: false,
    error: report.error, report: path.join(output, 'PREFLIGHT.json') }));
}
