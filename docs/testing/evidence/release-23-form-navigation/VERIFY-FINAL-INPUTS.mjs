import fs from 'node:fs';
import assert from 'node:assert/strict';
import {captureReleaseInputs,inventoryDirectory} from '../../../../scripts/release-inputs.mjs';
const dir='docs/testing/evidence/release-23-form-navigation';
const build=JSON.parse(fs.readFileSync(dir+'/BUILD-92.json')),current=captureReleaseInputs();
const changes=Object.keys({...build.source.files,...current.files}).filter(file=>build.source.files[file]!==current.files[file]);
assert.deepEqual(changes,['tests/workspace/created-target.test.ts']);
assert.deepEqual(inventoryDirectory(build.app),build.bundle);
fs.writeFileSync(dir+'/FINAL-INPUTS.json',JSON.stringify({checkedAt:new Date().toISOString(),bundleUnchanged:true,bundleSha256:build.bundle.sha256,productAndValidationScriptsUnchanged:true,changes:changes.map(file=>({file,buildSha256:build.source.files[file],finalSha256:current.files[file]})),reason:'Only strengthen schema counterexamples with a valid stripped-source baseline and positive assertion; targeted and static checks rerun. Runtime input equality was checked before this test edit.'},null,2)+'\n');
