import fs from 'node:fs';
import assert from 'node:assert/strict';
import {captureReleaseInputs,inventoryDirectory} from '../../../../scripts/release-inputs.mjs';
const dir='docs/testing/evidence/release-23-rich-text-locator',build=JSON.parse(fs.readFileSync(dir+'/'+process.argv[2]));
assert.deepEqual(captureReleaseInputs().files,build.source.files);assert.deepEqual(inventoryDirectory(build.app),build.bundle);
fs.writeFileSync(dir+'/BUNDLE-VERIFIED.json',JSON.stringify({build:build.build,checkedAt:new Date().toISOString(),bundleSha256:build.bundle.sha256,inputsUnchangedAfterBuild:true,bundleUnchangedAfterRun:true},null,2)+'\n');
