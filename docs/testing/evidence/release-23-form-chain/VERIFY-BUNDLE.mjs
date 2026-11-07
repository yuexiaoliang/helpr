import fs from 'node:fs';
import assert from 'node:assert/strict';
import { captureReleaseInputs, inventoryDirectory } from '../../../../scripts/release-inputs.mjs';
const dir = 'docs/testing/evidence/release-23-form-chain';
const build = JSON.parse(fs.readFileSync(dir + '/BUILD-93.json'));
const inputs = captureReleaseInputs();
const changed = Object.keys({ ...build.source.files, ...inputs.files }).filter(key => build.source.files[key] !== inputs.files[key]);
assert.deepEqual(changed, ['scripts/form-navigation-validation.mjs']);
const retry = JSON.parse(fs.readFileSync(dir + '/RETRY-INPUTS.json'));
for (const row of retry.changes) { assert.equal(build.source.files[row.file], row.built); assert.equal(inputs.files[row.file], row.current); }
assert.deepEqual(inventoryDirectory(build.app), build.bundle);
const report = JSON.parse(fs.readFileSync(dir + '/INDEPENDENT.json'));
Object.assign(report, { bundleSha256: build.bundle.sha256, bundleUnchangedAfterRun: true, inputChangesAfterBuild: retry.changes });
fs.writeFileSync(dir + '/INDEPENDENT.json', JSON.stringify(report, null, 2) + '\n');
