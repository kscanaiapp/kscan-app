const { expectedReceiptAdvance } = require('./helpers/receiptQuotaPromotion');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const canonical = '5df63c052ad0e9e757016d8f2100f9a7fdbab836';
const previousMobile = '50387a2be4e3406b9ce43b4b0ffb56c4b82262c6';
const files = [
  "supabase/functions/stylechat-generate/packingWeather.test.ts",
  "supabase/functions/stylechat-generate/packingWeather.ts"
];
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/build35-hostile-source-promotion.json'), 'utf8'));
const previous = JSON.parse(execFileSync('git', ['show', previousMobile + ':config/build35-hostile-source-promotion.json'], { cwd: root, encoding: 'utf8' }));
const approved = new Map(files.map(file => [file, execFileSync('git', ['show', canonical + ':' + file], { cwd: root })]));
const actual = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file))]));
function verify(bytes) {
  assert.equal(policy.canonicalBackend, '31be5f99341b606a070bbbe0b3062588f320f089');
  assert.equal(previous.files.length, 51);
  assert.equal(policy.files.length, 57);
  assert.equal(new Set(policy.files.map(row => row.file)).size, 57);
  assert.deepEqual(policy.files.filter(row => !files.includes(row.file) && row.file !== 'supabase/migrations/20261102125053_saved_scan_explicit_restore.sql' && !["supabase/migrations/20261031162813_saved_scans_active_account_guard.sql","supabase/functions/stylechat-generate/index.ts","supabase/functions/stylechat-generate/invalidBodyHostile.test.ts"].includes(row.file)), expectedReceiptAdvance(previous.files));
  assert.deepEqual(policy.sharedSigningRegressionRegistration, previous.sharedSigningRegressionRegistration);
  for (const file of files) {
    const row = policy.files.find(row => row.file === file);
    assert.equal(row.source, canonical);
    assert.equal(row.sha256, crypto.createHash('sha256').update(approved.get(file)).digest('hex'));
    assert.ok(bytes.get(file).equals(approved.get(file)), file + ' must equal reviewed canonical bytes');
  }
}
test('E016 Unicode weather promotion preserves canonical bytes and every prior reviewed grant', () => {
  verify(actual);
  const authority = JSON.parse(fs.readFileSync(path.join(root, 'config/backend-authority.json'), 'utf8'));
  assert.equal(authority.role, 'integration-convergence-non-authoritative');
  assert.equal(authority.build35CampaignConvergence.sha, '31be5f99341b606a070bbbe0b3062588f320f089');
  const local = JSON.parse(fs.readFileSync(path.join(root, 'config/edge-function-manifest.json'), 'utf8'));
  const backend = JSON.parse(execFileSync('git', ['show', '19bcc5d699f878561aaef1f9bc914c998e2a0de7:config/edge-function-manifest.json'], { cwd: root, encoding: 'utf8' }));
  const find = m => m.parity.functions.find(f => f.name === 'stylechat-generate');
  for (const field of ['bundleHash', 'treeHash']) assert.equal(find(local)[field], find(backend)[field]);
});
test('E016 promotion refuses an unreviewed mutation in either weather source or regression file', () => {
  for (const file of files) {
    const changed = new Map(actual);
    changed.set(file, Buffer.concat([actual.get(file), Buffer.from('\n// unreviewed mutation\n')]));
    assert.throws(() => verify(changed), assert.AssertionError, file);
  }
});
