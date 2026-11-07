import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryDirectory, assertSameInputs } from './release-inputs.mjs';
import { collectPackageNotices } from './release-notices.mjs';

const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpr-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('包清单覆盖原生文件、资源、执行位与内部链接，拒绝链接出包', (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'native'));
  const file = path.join(dir, 'native', 'bridge.node');
  fs.writeFileSync(file, 'native-before');
  fs.symlinkSync('native/bridge.node', path.join(dir, 'current'));
  const before = inventoryDirectory(dir);
  assert.equal(before.files.length, 2);
  assert.equal(before.files[0].link, 'native/bridge.node');
  fs.writeFileSync(file, 'native-after');
  assert.notEqual(inventoryDirectory(dir).sha256, before.sha256);
  const changed = inventoryDirectory(dir);
  fs.chmodSync(file, 0o700);
  assert.notEqual(inventoryDirectory(dir).sha256, changed.sha256);
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'outside'));
  assert.throws(() => inventoryDirectory(dir), /RELEASE_LINK_OUTSIDE_BUNDLE/);
});

test('构建途中改变、删减或伪造相同摘要的源码清单均拒绝', () => {
  const before = { sha256: 'a', files: { 'app/a.ts': 'first' } };
  assert.doesNotThrow(() => assertSameInputs(before, structuredClone(before)));
  assert.throws(() => assertSameInputs(before, { ...before, sha256: 'b' }), /RELEASE_INPUT_CHANGED/);
  assert.throws(() => assertSameInputs(before, { ...before, files: {} }), /RELEASE_INPUT_CHANGED/);
  assert.throws(() => assertSameInputs(before, { ...before, files: { 'app/a.ts': 'second' } }), /RELEASE_INPUT_CHANGED/);
});

test('许可证正文包括嵌套第三方说明，保留字节摘要，跳过其它包与外部链接', (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'vendor'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'Original license\r\n');
  fs.writeFileSync(path.join(dir, 'vendor', 'NOTICE.txt'), 'Third party notice\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'LICENSE'), 'Other package');
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'linked'));
  const files = collectPackageNotices(dir);
  assert.deepEqual(files.map((f) => f.path), ['LICENSE', 'vendor/NOTICE.txt']);
  assert.equal(files[0].text, 'Original license\r\n');
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
});
