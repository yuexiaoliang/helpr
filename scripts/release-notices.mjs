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
  const packages = new Map();
  for (const entry of Object.values(listings).flat()) for (const directory of entry.paths) {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    const texts = collectPackageNotices(directory);
    const item = {
      name: pkg.name, version: pkg.version, declaredLicense: pkg.license ?? null,
      packageJsonSha256: fileHash(path.join(directory, 'package.json')),
      // 源发布包根部没有正文的情况明确列为待补；不以 SPDX 标识填充或推定。
      rootLicensePresent: texts.some((t) => !t.path.includes('/') && /^(?:licen[sc]e|copying)/i.test(t.path)),
      notices: texts,
    };
    const key = `${pkg.name}@${pkg.version}`;
    const prior = packages.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw Error('RELEASE_DEPENDENCY_CONTENT_CONFLICT');
    packages.set(key, item);
  }
  const ordered = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const extras = ['node_modules/electron/dist/LICENSE', 'node_modules/electron/dist/LICENSES.chromium.html', 'app/renderer/assets/PHOSPHOR-LICENSE.txt'];
  const materials = extras.map((file) => ({ path: file, sha256: fileHash(path.join(root, file)) }));
  const manifest = {
    schema: 1, lockSha256: fileHash(path.join(root, 'pnpm-lock.yaml')),
    electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version,
    packages: ordered.map(({ notices, ...p }) => ({ ...p, notices: notices.map(({ text: _text, ...n }) => n) })),
    materials, missingRootLicense: ordered.filter((p) => !p.rootLicensePresent).map((p) => `${p.name}@${p.version}`),
    scope: 'Installed production dependency declarations and available upstream notices; not a legal approval or release acceptance.',
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'DEPENDENCIES.json'), JSON.stringify(manifest, null, 2) + '\n');
  const text = ordered.map((p) => `\n===== ${p.name}@${p.version} (${JSON.stringify(p.declaredLicense)}) =====\n` +
    (p.rootLicensePresent ? '' : 'Root license text missing from installed package; unresolved.\n') +
    p.notices.map((n) => `\n--- ${n.path} / SHA-256 ${n.sha256} ---\n${n.text}\n`).join('')).join('');
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), text);
  for (const file of extras) fs.copyFileSync(path.join(root, file), path.join(output,
    file.endsWith('/LICENSE') ? 'ELECTRON-LICENSE.txt' : path.basename(file)));
  return manifest;
}
