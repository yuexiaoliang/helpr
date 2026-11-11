import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileHash, sha256 } from './release-inputs.mjs';

// 包自带的声明和正文分别记录；嵌套第三方文本不冒充本包许可证。
export function collectPackageNotices(directory) {
  const texts = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^(?:licen[sc]e|copying|notice|third[-_]?party)/i.test(entry.name)) {
        const bytes = fs.readFileSync(path.join(directory, file));
        texts.push({ path: file, sha256: sha256(bytes), text: bytes.toString('utf8') });
      }
    }
  };
  walk('');
  return texts.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function prepareReleaseNotices(output, root = process.cwd()) {
  const listings = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  }));
  const lockfile = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const sourceDir = path.join(root, 'scripts/release-licenses');
  const sources = JSON.parse(fs.readFileSync(path.join(sourceDir, 'sources.json')));
  const packages = new Map();
  for (const entry of Object.values(listings).flat()) for (const directory of entry.paths) {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    const texts = collectPackageNotices(directory);
    const key = `${pkg.name}@${pkg.version}`;
    const origin = sources[key];
    if (origin) {
      const resolution = `\n    resolution: {integrity: ${origin.integrity}}\n`;
      if (pkg.license !== origin.declaredLicense ||
          ![key, `'${key}'`].some((id) => lockfile.includes(`\n  ${id}:${resolution}`)))
        throw Error(`RELEASE_LICENSE_SOURCE_MISMATCH:${key}`);
      for (const { file, source, sha256: expected } of origin.files) {
        const bytes = fs.readFileSync(path.join(sourceDir, file));
        if (sha256(bytes) !== expected) throw Error(`RELEASE_LICENSE_TEXT_CHANGED:${file}`);
        texts.push({ path: `release-licenses/${file}`, source, sha256: expected, text: bytes.toString('utf8') });
      }
    }
    const item = {
      name: pkg.name, version: pkg.version, declaredLicense: pkg.license ?? null,
      packageJsonSha256: fileHash(path.join(directory, 'package.json')),
      // 标准许可条款可随包保留；独立发布包的归属未确认时仍记录缺口。
      rootLicensePresent: origin?.kind === 'upstream-revision' ||
        texts.some((t) => !t.path.includes('/') && /^(?:licen[sc]e|copying)/i.test(t.path)),
      ...(origin && { licenseSource: origin }),
      notices: texts,
    };
    const prior = packages.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw Error('RELEASE_DEPENDENCY_CONTENT_CONFLICT');
    packages.set(key, item);
  }
  const ordered = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const extras = ['node_modules/electron/dist/LICENSE', 'node_modules/electron/dist/LICENSES.chromium.html', 'app/renderer/assets/PHOSPHOR-LICENSE.txt'];
  const materials = extras.map((file) => ({ path: file, sha256: fileHash(path.join(root, file)) }));
  const manifest = {
    schema: 2, lockSha256: sha256(lockfile),
    electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version,
    packages: ordered.map(({ notices, ...p }) => ({ ...p, notices: notices.map(({ text: _text, ...n }) => n) })),
    materials, missingRootLicense: ordered.filter((p) => !p.rootLicensePresent).map((p) => `${p.name}@${p.version}`),
    scope: 'Installed production dependency declarations, exact upstream notices and separately identified standard license terms.',
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'DEPENDENCIES.json'), JSON.stringify(manifest, null, 2) + '\n');
  const text = ordered.map((p) => `\n===== ${p.name}@${p.version} (${JSON.stringify(p.declaredLicense)}) =====\n` +
    (p.licenseSource ? `Release metadata: ${p.licenseSource.registry}\n` : '') +
    (p.rootLicensePresent ? '' : 'Package-specific upstream notice unavailable. Any standard terms below are based on the registry declaration.\n') +
    p.notices.map((n) => `\n--- ${n.path} / SHA-256 ${n.sha256} ---\n${n.source ? `Source: ${n.source}\n` : ''}${n.text}\n`).join('')).join('');
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), text);
  for (const file of extras) fs.copyFileSync(path.join(root, file), path.join(output,
    file.endsWith('/LICENSE') ? 'ELECTRON-LICENSE.txt' : path.basename(file)));
  return manifest;
}
