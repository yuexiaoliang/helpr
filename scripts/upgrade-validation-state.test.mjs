import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openUpgradeFixture,
  confirmUpgradeUI,
  requireUpgradeNativePreflight,
  recordUpgradeCleanup,
  writeUpgradeJSON,
} from './upgrade-validation-state.mjs';

test('服务中断后仍保留同一虚构密钥、会话、到期、原端口与效果累计，损坏时拒绝重新生成身份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-fixture-state-'));
  try {
    const first = openUpgradeFixture(root);
    Object.assign(first.state, {
      httpPort: 55540,
      httpsPort: 55541,
      expires: 1793770153,
      counts: { A: 1, B: 1 },
    });
    first.save();
    const next = openUpgradeFixture(root);
    assert.deepEqual(next.state, first.state);
    const file = path.join(root, 'private-fixture.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    assert.throws(
      () => openUpgradeFixture(root),
      /PRIVATE_FIXTURE_PERMISSIONS/,
    );
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => openUpgradeFixture(root), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧版或访达的界面确认不能放行新版，过期观察不能算窗口已响应', () => {
  const row = { start: 103, at: 100000, ready: { hostPid: 80328 } };
  const receipt = {
    source: 'cua-native-window',
    start: 103,
    hostPid: 80328,
    observedAt: 110000,
    title: 'helpr',
    evidence: 'CUA工具记录中的新版实际窗口树',
  };
  assert.equal(confirmUpgradeUI(row, receipt, 110500).start, 103);
  for (const change of [
    { start: 102 },
    { hostPid: 78301 },
    { title: 'Finder' },
    { source: 'script-ready' },
    { observedAt: 90000 },
    { observedAt: 120000 },
  ])
    assert.throws(() =>
      confirmUpgradeUI(row, { ...receipt, ...change }, 110500),
    );
  assert.throws(
    () => confirmUpgradeUI(row, receipt, 180000),
    /FRESH_NATIVE_OBSERVATION_REQUIRED/,
  );
});

test('强制清理的实际退出码与OS剩余同时保留，未清空不允许下一次启动', () => {
  const app = { row: { exit: { code: 1, signal: null } }, cleared: false };
  recordUpgradeCleanup(app, [{ pid: 123 }], 'signals');
  assert.equal(app.cleared, false);
  recordUpgradeCleanup(app, [], 'signals');
  assert.equal(app.cleared, true);
  assert.deepEqual(app.row.remaining, []);
  assert.equal(app.row.exit.code, 1);
  assert.equal(app.row.cleanup.method, 'signals');
});

test('启动前仅清单恢复或一次陈旧成功都不够；窗口和图像须在本次预检响应', () => {
  const receipt = {
    source: 'cua-native-window',
    observedAt: 100000,
    elapsedMs: 900,
    windowRead: true,
    screenshotRead: true,
  };
  assert.doesNotThrow(() => requireUpgradeNativePreflight(receipt, 110000));
  for (const change of [
    { source: 'list-apps' },
    { windowRead: false },
    { screenshotRead: false },
    { observedAt: 200000 },
    { elapsedMs: 45000 },
  ])
    assert.throws(() =>
      requireUpgradeNativePreflight({ ...receipt, ...change }, 110000),
    );
  assert.throws(
    () => requireUpgradeNativePreflight(receipt, 300000),
    /NATIVE_PREFLIGHT_EXPIRED/,
  );
  assert.throws(() => requireUpgradeNativePreflight(undefined, 110000));
});

test('报告写入失败仍保留上一个完整检查点，不留下半份JSON', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'upgrade-evidence-state-'),
  );
  try {
    const file = path.join(root, 'result.json');
    writeUpgradeJSON(file, { phase: 'old-baseline', starts: 2 });
    const circular = {};
    circular.self = circular;
    assert.throws(() => writeUpgradeJSON(file, circular), TypeError);
    const originalWrite = fs.writeFileSync.bind(fs);
    const failure = t.mock.method(fs, 'writeFileSync', (target, bytes) => {
      originalWrite(target, bytes.slice(0, 4));
      throw Error('SIMULATED_DISK_FULL_AFTER_PARTIAL_WRITE');
    });
    assert.throws(
      () => writeUpgradeJSON(file, { phase: 'new-package', starts: 3 }),
      /SIMULATED_DISK_FULL_AFTER_PARTIAL_WRITE/,
    );
    failure.mock.restore();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      phase: 'old-baseline',
      starts: 2,
    });
    assert.deepEqual(fs.readdirSync(root), ['result.json']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
