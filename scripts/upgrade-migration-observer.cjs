// 仅供受管离线诊断预加载：观察真实SQLite提交，不改变SQL或事务。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const folder = process.env.HELPR_MIGRATION_OBSERVER;
assert(folder && process.argv.includes('--workspace-validation'), 'OWNED_MIGRATION_OBSERVER_REQUIRED');
assert(folder.startsWith(`/private/tmp/helpr-workspace-validation-${process.getuid()}/upgrade09-offline-`));
assert.equal(fs.realpathSync(folder), folder);
const location = require.resolve('better-sqlite3');
const Database = require(location);
function ObservedDatabase(file, options) {
  let installationDDL = false;
  return new Database(file, {
    ...options,
    verbose(sql) {
      // 不保存SQL、参数或业务资料，只确认冻结09迁移及随后的提交。
      if (/^CREATE TABLE `installation`\s*\(/.test(sql.trim())) installationDDL = true;
      if (installationDDL && /^COMMIT\s*;?$/i.test(sql.trim())) {
        const receipt = { stage: 'migration-commit-entered', pid: process.pid, at: Date.now() };
        fs.writeFileSync(path.join(folder, 'migration-commit.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      }
    },
  });
}
ObservedDatabase.prototype = Database.prototype;
Object.setPrototypeOf(ObservedDatabase, Database);
require.cache[location].exports = ObservedDatabase;
