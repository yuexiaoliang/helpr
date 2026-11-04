import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validationRoot } from './workspace-budget.mjs';

function checkedRoot(root) {
  assert.equal(root, path.join(validationRoot, 'upgrade09-download-new/helpr.app'));
  assert.equal(fs.realpathSync(root), root);
}

export function readUpgradeDownloadQuarantine(root) {
  checkedRoot(root);
  const output = execFileSync('/usr/bin/xattr', ['-r', '-px', 'com.apple.quarantine', root], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const entries = new Map();
  let file, hex = '';
  const finish = () => {
    if (!file) return;
    assert(hex.length > 0 && hex.length % 2 === 0 && /^[a-fA-F0-9]+$/.test(hex));
    const actual = fs.realpathSync(file);
    assert(actual === root || actual.startsWith(root + path.sep));
    const relative = path.relative(root, actual) || '.';
    if (entries.has(relative)) assert.equal(entries.get(relative), hex.toLowerCase());
    entries.set(relative, hex.toLowerCase());
  };
  for (const line of output.split('\n')) {
    if (line.startsWith(root) && line.endsWith(': ')) {
      finish(); file = line.slice(0, -2); hex = '';
    } else if (line.trim()) hex += line.replace(/\s/g, '');
  }
  finish();
  return [...entries].map(([file, hex]) => ({ path: file, hex }));
}

export function restoreUpgradeDownloadQuarantine(snapshotFile, root) {
  checkedRoot(root);
  assert.equal(snapshotFile, path.join(validationRoot, 'delivery09-41/quarantine-originals.json'));
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile));
  assert.equal(snapshot.root, root);
  assert(Array.isArray(snapshot.entries) && snapshot.entries.length > 0 && snapshot.entries.length < 10000);
  const groups = new Map();
  for (const entry of snapshot.entries) {
    assert(typeof entry.hex === 'string' && /^(?:[a-f0-9]{2}){1,2048}$/.test(entry.hex));
    const file = path.resolve(root, entry.path);
    assert(file === root || file.startsWith(root + path.sep));
    assert.equal(fs.realpathSync(file), file);
    if (!groups.has(entry.hex)) groups.set(entry.hex, []);
    groups.get(entry.hex).push(file);
  }
  for (const [hex, files] of groups)
    for (let i = 0; i < files.length; i += 100)
      execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.quarantine', hex, ...files.slice(i, i + 100)], { timeout: 15000 });
  const actual = new Map(readUpgradeDownloadQuarantine(root).map(e => [e.path, e.hex]));
  for (const entry of snapshot.entries) assert.equal(actual.get(entry.path), entry.hex);
  return snapshot.entries.length;
}
