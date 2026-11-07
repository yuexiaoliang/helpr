import fs from 'node:fs';
import assert from 'node:assert/strict';
import { captureReleaseInputs, inventoryDirectory } from '../../../../scripts/release-inputs.mjs';
const dir = 'docs/testing/evidence/release-23-rich-text-inline-frame';
const build = JSON.parse(fs.readFileSync(dir + '/' + process.argv[2]));
const retry = JSON.parse(fs.readFileSync(dir + '/RETRY-INPUTS.json'));
assert.equal(retry.build, build.build);
assert.deepEqual(retry.differences.map(d=>d.file).sort(),['scripts/rich-text-lines-fixture.test.mjs','scripts/rich-text-lines-validation.mjs']);
const current = captureReleaseInputs(), expected={...build.source.files};
for(const d of retry.differences){assert.equal(expected[d.file],d.before);expected[d.file]=d.after;}
assert.deepEqual(current.files,expected);assert.equal(current.sha256,retry.currentSourceSha256);assert.equal(build.source.sha256,retry.builtSourceSha256);
assert.deepEqual(inventoryDirectory(build.app), build.bundle);
const target = dir + (process.argv[3] ? '/' + process.argv[3] : '') + '/INDEPENDENT.json';
const report = JSON.parse(fs.readFileSync(target));
Object.assign(report, { bundleSha256: build.bundle.sha256, bundleUnchangedAfterRun: true, inputsUnchangedAfterBuild: false, productInputsUnchangedAfterBuild: true, validationInputDifferences: retry.differences });
fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
