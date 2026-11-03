const { expectedReceiptAdvance } = require('./helpers/receiptQuotaPromotion');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const canonical = '14746f6516399dafbe27ade713f392ba0fff7725';
const mobile = '113a1895aac8af974b1aca18724f5286e9967237';
const files = ['supabase/migrations/20261031162813_saved_scans_active_account_guard.sql',
  'supabase/functions/stylechat-generate/index.ts',
  'supabase/functions/stylechat-generate/invalidBodyHostile.test.ts'];
const regression = '__tests__/savedScansAccountStateSql.test.js';
const git = (ref, file) => execFileSync('git', ['show', ref + ':' + file], { cwd: root });
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const policy = json('config/build35-hostile-source-promotion.json');
const prior = JSON.parse(git(mobile, 'config/build35-hostile-source-promotion.json'));
const bytes = new Map([...files, regression].map(file => [file, read(file)]));
function verify(p, actual) {
  assert.equal(p.canonicalBackend, '31be5f99341b606a070bbbe0b3062588f320f089');
  assert.equal(prior.files.length, 53);
  assert.equal(p.files.length, 57);
  assert.equal(new Set(p.files.map(row => row.file)).size, 57);
  assert.deepEqual(p.files.filter(row => !files.includes(row.file) && row.file !== 'supabase/migrations/20261102125053_saved_scan_explicit_restore.sql'), expectedReceiptAdvance(prior.files),
    'all previous53 byte-bound grants remain unchanged');
  assert.deepEqual(p.files.filter(row => files.includes(row.file)).map(row => row.file), files);
  assert.deepEqual(p.sharedSigningRegressionRegistration, prior.sharedSigningRegressionRegistration);
  for (const file of [...files, regression]) {
    const approved = git(canonical, file);
    assert.ok(actual.get(file).equals(approved), file + ' is exact canonical source');
    if (file === regression) continue;
    const row = p.files.find(row => row.file === file);
    assert.equal(row.source, canonical);
    assert.equal(row.sha256, hash(approved));
  }
}
test('F017/C015 promotion pins exact canonical bytes and every prior source grant', () => {
  verify(policy, bytes);
  const authority = json('config/backend-authority.json');
  assert.equal(authority.role, 'integration-convergence-non-authoritative');
  assert.equal(authority.build35CampaignConvergence.sha, '31be5f99341b606a070bbbe0b3062588f320f089');
  const currentManifest = json('config/edge-function-manifest.json');
  const canonicalManifest = JSON.parse(git(canonical, 'config/edge-function-manifest.json'));
  const find = m => m.parity.functions.find(f => f.name === 'stylechat-generate');
  for (const field of ['bundleHash', 'treeHash']) assert.equal(find(currentManifest)[field], find(canonicalManifest)[field]);
});
test('promotion refuses mutation in each migrated source or regression file', () => {
  for (const file of [...files, regression]) {
    const changed = new Map(bytes);
    changed.set(file, Buffer.concat([bytes.get(file), Buffer.from('\n-- unreviewed mutation\n')]));
    assert.throws(() => verify(policy, changed), assert.AssertionError, file);
  }
});
test('a new grant or altered previous grant cannot hide inside this promotion', () => {
  const extra = structuredClone(policy);
  extra.files.push({file:'supabase/functions/unreviewed/index.ts',sha256:'0'.repeat(64),source:canonical});
  assert.throws(() => verify(extra, bytes), assert.AssertionError);
  const altered = structuredClone(policy);
  altered.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => verify(altered, bytes), assert.AssertionError);
});
test('both environment declarations stay pending and preserve every previous migration decision', () => {
  const current = json('config/migration-authority-manifest.json');
  const original = JSON.parse(git(mobile,'config/migration-authority-manifest.json'));
  const backend = JSON.parse(git(canonical,'config/migration-authority-manifest.json'));
  for (const ref of ['yzqjvdfgefveprobvvyw','wyyuqfdxucjksghsmhry']) {
    const rows = current.ledgerReconciliation.environments[ref].knownPending;
    const existing = original.ledgerReconciliation.environments[ref].knownPending;
    assert.deepEqual(rows.filter(r => !['20261031162813','20261102125053'].includes(r.localVersion)), existing);
    const selected = rows.filter(r => r.localVersion === '20261031162813');
    assert.equal(selected.length,1);
    assert.deepEqual(selected[0],backend.ledgerReconciliation.environments[ref].knownPending.find(r => r.localVersion === '20261031162813'));
    assert.equal(selected[0].disposition,'KNOWN_FUTURE_UNAPPLIED');
  }
  // Reset only the two added declarations and require the entire remaining ledger to match.
  for (const ref of ['yzqjvdfgefveprobvvyw','wyyuqfdxucjksghsmhry']) current.ledgerReconciliation.environments[ref].knownPending = original.ledgerReconciliation.environments[ref].knownPending;
  assert.deepEqual(current,original);
});
