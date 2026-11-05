import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeValidationJSON } from './validation-json.mjs';

export { writeValidationJSON as writeUpgradeJSON };

// 仅本机虚构服务的身份；不读取产品密钥，不进入公开报告或业务备份。
export function openUpgradeFixture(root) {
  const file = path.join(root, 'private-fixture.json');
  const validate = (value) => {
    assert(
      value?.version === 1 &&
        /^upgrade09-test-[a-f0-9-]{36}$/.test(value.apiKey) &&
        /^[a-f0-9-]{36}$/.test(value.sessionToken),
      'FIXTURE_IDENTITY_INVALID',
    );
    assert(
      Number.isSafeInteger(value.expires) && value.expires >= 0,
      'FIXTURE_EXPIRY_INVALID',
    );
    for (const port of [value.httpPort, value.httpsPort])
      assert(
        port === null || (Number.isInteger(port) && port > 0 && port <= 65535),
        'FIXTURE_PORT_INVALID',
      );
    for (const name of ['A', 'B'])
      assert(
        Number.isInteger(value.counts?.[name]) &&
          value.counts[name] >= 0 &&
          value.counts[name] <= 4,
        'FIXTURE_COUNTS_INVALID',
      );
    return value;
  };
  let state;
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existed = stat !== undefined;
  if (existed) {
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      'PRIVATE_FIXTURE_PERMISSIONS',
    );
    state = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else
    state = {
      version: 1,
      apiKey: 'upgrade09-test-' + randomUUID(),
      sessionToken: randomUUID(),
      expires: 0,
      httpPort: null,
      httpsPort: null,
      counts: { A: 0, B: 0 },
    };
  const identity = { apiKey: state.apiKey, sessionToken: state.sessionToken };
  const save = () => {
    validate(state);
    assert(
      state.apiKey === identity.apiKey &&
        state.sessionToken === identity.sessionToken,
      'FIXTURE_IDENTITY_CHANGED',
    );
    writeValidationJSON(file, state);
  };
  if (!existed) save();
  return { state, save };
}

// 这是操作者对真实CUA观察的登记，不是脚本ready或截图标签的替代证明。
export function confirmUpgradeUI(row, receipt, now = Date.now()) {
  assert(
    receipt && typeof receipt === 'object',
    'CURRENT_NATIVE_WINDOW_REQUIRED',
  );
  assert(
    receipt.source === 'cua-native-window' &&
      receipt.start === row.start &&
      receipt.hostPid === row.ready?.hostPid,
    'CURRENT_NATIVE_WINDOW_REQUIRED',
  );
  assert(
    Number.isSafeInteger(receipt.observedAt) &&
      receipt.observedAt >= row.at &&
      receipt.observedAt <= now &&
      now - receipt.observedAt <= 60000,
    'FRESH_NATIVE_OBSERVATION_REQUIRED',
  );
  assert(
    receipt.title === 'helpr' &&
      typeof receipt.evidence === 'string' &&
      receipt.evidence.trim().length > 0,
    'NATIVE_OBSERVATION_EVIDENCE_REQUIRED',
  );
  return { ...receipt, confirmedAt: now };
}

export function requireUpgradeNativePreflight(receipt, now = Date.now()) {
  assert(
    receipt?.source === 'cua-native-window' &&
      receipt.windowRead === true &&
      receipt.screenshotRead === true,
    'NATIVE_WINDOW_PREFLIGHT_REQUIRED',
  );
  assert(
    Number.isSafeInteger(receipt.observedAt) &&
      receipt.observedAt <= now &&
      now - receipt.observedAt <= 120000,
    'NATIVE_PREFLIGHT_EXPIRED',
  );
  assert(
    Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= 15000,
    'NATIVE_PREFLIGHT_TOO_SLOW',
  );
}

export function recordUpgradeCleanup(app, remaining, method) {
  app.row.remaining = remaining;
  app.row.cleanup = { method, remaining };
  app.cleared = remaining.length === 0;
}
