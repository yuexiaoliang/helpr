import fs from 'node:fs';
import assert from 'node:assert/strict';
import {captureReleaseInputs,inventoryDirectory} from '../../../../scripts/release-inputs.mjs';
const base='docs/testing/evidence/release-23-summary-result';
const build=JSON.parse(fs.readFileSync(base+'/BUILD-107.json'));
const changes=JSON.parse(fs.readFileSync(base+'/HARNESS-INPUTS.json'));
const expected={...build.source.files};for(const [file,change] of Object.entries(changes)){assert.equal(expected[file],change.before);expected[file]=change.after;}
assert.deepEqual(captureReleaseInputs().files,expected);
assert.deepEqual(inventoryDirectory(build.app),build.bundle);
fs.writeFileSync(base+'/BUNDLE-VERIFIED.json',JSON.stringify({checkedAt:new Date().toISOString(),build:build.build,sourceCommit:build.source.commit,bundleSha256:build.bundle.sha256,allBuildInputsUnchanged:false,exactHarnessChanges:changes,bundleUnchanged:true},null,2)+'\n');
