const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const canonical = 'f64d8b7f3ce175f8fd3b2ff3a9b57cafbcfb5fee';
const runner = 'scripts/run-backend-tests.js';
const mobileBase = 'a9503e135162824ed8127f6a3066fac1deab3e67';
const files = [
  'supabase/functions/shared-room-image-url/index.ts',
  'supabase/functions/shared-room-image-url/validation.ts',
  'supabase/functions/shared-room-image-url/validation.test.ts',
  'supabase/functions/shared-room-image-url/signingResponse.test.ts'];
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/build35-hostile-source-promotion.json'), 'utf8'));
const authority = JSON.parse(fs.readFileSync(path.join(root, 'config/backend-authority.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const approved = new Map(files.map(file => [file, execFileSync('git', ['show', `${canonical}:${file}`], { cwd: root })]));
const originalRunner = execFileSync('git', ['show', `${mobileBase}:${runner}`], { cwd: root, encoding: 'utf8' });
const addedRegistration = "  // B35-F-012: keep private image signing response validation in the default gate.\n  'shared-room-image-url',\n";
const expectedRunner = Buffer.from(originalRunner.replace("  'handle-user-deletion',\n", "  'handle-user-deletion',\n" + addedRegistration));
const allFiles = [runner, ...files];
const actual = new Map(allFiles.map(file => [file, fs.readFileSync(path.join(root, file))]));
function verify(bytes) {
  assert.equal(policy.canonicalBackend, canonical);
  assert.equal(policy.files.length, 51, '47 prior exact entries plus four canonical F012 function/test files');
  assert.ok(!policy.files.some(entry => entry.file === runner), 'Preserve the mobile-owned runner difference explicitly');
  for (const file of files) {
    const row = policy.files.find(entry => entry.file === file);
    assert.equal(row?.source, canonical, file);
    assert.equal(row.sha256, hash(approved.get(file)), file);
    assert.ok(bytes.get(file).equals(approved.get(file)), `${file} must match the approved canonical bytes`);
  }
  assert.equal(policy.sharedSigningRegressionRegistration.baseMobileSha, mobileBase);
  assert.equal(policy.sharedSigningRegressionRegistration.canonicalSource, canonical);
  assert.equal(policy.sharedSigningRegressionRegistration.sha256, hash(expectedRunner));
  assert.ok(bytes.get(runner).equals(expectedRunner), 'Only the approved registration may change the mobile runner');
}
test('F012 promotion contains exact canonical source and regression coverage without deployment authority', () => {
  verify(actual);
  assert.equal(authority.role, 'integration-convergence-non-authoritative');
  assert.equal(authority.build35CampaignConvergence.sha, canonical);
  assert.ok(originalRunner.includes("'purchase-import-extract'"));
  const canonicalRunner = execFileSync('git', ['show', `${canonical}:${runner}`], { cwd: root, encoding: 'utf8' });
  assert.ok(canonicalRunner.includes(addedRegistration), 'Registration comes from the reviewed canonical repair');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'config/edge-function-manifest.json'), 'utf8'));
  const backend = JSON.parse(execFileSync('git', ['show', `${canonical}:config/edge-function-manifest.json`], { cwd: root, encoding: 'utf8' }));
  const find = manifest => manifest.parity.functions.find(f => f.name === 'shared-room-image-url');
  for (const field of ['bundleHash', 'treeHash']) assert.equal(find(current)[field], find(backend)[field]);
});
test('F012 promotion refuses a byte mutation in each canonical file and the derived mobile runner', () => {
  for (const file of allFiles) {
    const altered = new Map(actual);
    altered.set(file, Buffer.concat([actual.get(file), Buffer.from('\n// unapproved drift\n')]));
    assert.throws(() => verify(altered), assert.AssertionError, file);
  }
});
