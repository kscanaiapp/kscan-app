const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const S = require('./helpers/scannerNullBodyPromotion');
const source = '53bf7cc2aeeeceb556ef2d01671c941038c83bfc';
const review = '28321246252babb1f2e47e18f7c5c9883691f0f1';
const tree = 'de0ef02cabad3bd4788af937c76780449833326c';
const base = 'ab26dd9b0dbe5fab9a8e06ea31deb0e5568ffedf';
const json = file => JSON.parse(fs.readFileSync(S.root + '/' + file, 'utf8'));
const prior = file => JSON.parse(S.gitBlob(file, base));
const oldPolicy = prior('config/build35-hostile-source-promotion.json');
const oldManifest = prior('config/edge-function-manifest.json');
const oldAuthority = prior('config/backend-authority.json');
const policy = json('config/build35-hostile-source-promotion.json');
const actual = new Map(S.files.map(f => [f, fs.readFileSync(S.root + '/' + f)]));
const note = ' Exact owner-authorized PR698/B004 Scanner contract-router guard and actual-handler regression; no migration, auth/quota change, deployment or activation grant.';
function verify(p, bytes, manifest, cross, authority, migrations) {
  assert.equal(S.canonical, source); assert.equal(S.reviewed, review); assert.equal(S.tree, tree); assert.equal(S.base, base);
  assert.equal(oldPolicy.files.length, 64); assert.equal(p.files.length, 66);
  assert.equal(new Set(p.files.map(r => r.file)).size, 66);
  assert.deepEqual(p, { ...oldPolicy, canonicalBackend: source, files: S.advance(oldPolicy.files) }, 'preserve every catalog/F025/earlier grant and historical metadata');
  for (const file of S.files) assert.ok(bytes.get(file).equals(S.gitBlob(file)), file + ' must be exact merged canonical bytes');
  const getTree = ref => cp.execFileSync('git', ['show', '-s', '--format=%T', ref], { cwd: S.root, encoding: 'utf8' }).trim();
  assert.equal(getTree(source), tree); assert.equal(getTree(review), tree);
  assert.deepEqual(manifest.parity.functions, S.functionAdvance(oldManifest.parity.functions), 'only exact B004 scan runtime/test files advance; discovery and every other function remain intact');
  const expectedCross = prior('config/cross-path-parity-manifest.json');
  for (const rows of Object.values(expectedCross.groups)) for (const row of rows) if (row.path === S.files[0]) row.sha256 = S.hash(S.gitBlob(row.path));
  assert.deepEqual(cross, expectedCross, 'same twenty governed files; only the canonical router hash changes');
  assert.deepEqual(authority, { ...oldAuthority, build35CampaignConvergence: { ...oldAuthority.build35CampaignConvergence, sha: source, note: oldAuthority.build35CampaignConvergence.note + note } });
  assert.equal(authority.role, 'integration-convergence-non-authoritative');
  assert.deepEqual(migrations, prior('config/migration-authority-manifest.json'), 'no migration execution/disposition/history change');
}
const inputs = () => [json('config/edge-function-manifest.json'), json('config/cross-path-parity-manifest.json'), json('config/backend-authority.json'), json('config/migration-authority-manifest.json')];

test('B004 promotes exact canonical repair/regressions and preserves current discovery and platform governance', () => {
  verify(policy, actual, ...inputs());
  for (const file of ['app.json', 'eas.json', 'supabase/config.toml', 'scripts/run-backend-tests.js', 'scripts/edge-function-manifest-lib.js', 'supabase/functions/scan-identify/index.ts', 'components/scan-results/BlackOwnedDiscoveryShelf.tsx']) {
    assert.equal(fs.readFileSync(S.root + '/' + file, 'utf8').replace(/\r\n/g, '\n'), S.gitBlob(file, base).toString('utf8').replace(/\r\n/g, '\n'), file + ' stays at the approved mobile baseline');
  }
});

test('B004 refuses unrelated grants, historical provenance, source changes, deployment authority and migration approval', () => {
  for (const file of S.files) {
    const bad = new Map(actual); bad.set(file, Buffer.concat([bad.get(file), Buffer.from('\n// unauthorized\n')]));
    assert.throws(() => verify(policy, bad, ...inputs()), assert.AssertionError);
  }
  for (const mutate of [p => { p.files[0].sha256 = '0'.repeat(64); }, p => { p.files.push({ file: 'supabase/unreviewed.sql' }); }, p => { p.trustedQuotaSettlementPromotion.canonicalSource = source; }, p => { p.files.find(r => r.file === S.files[0]).source = '*'; }]) {
    const bad = structuredClone(policy); mutate(bad);
    assert.throws(() => verify(bad, actual, ...inputs()), assert.AssertionError);
  }
  const cases = inputs(); cases[0].parity.functions.find(f => f.name === 'black-owned-discovery').bundleHash = '0'.repeat(64);
  assert.throws(() => verify(policy, actual, ...cases), assert.AssertionError);
  const scan = inputs(); scan[0].parity.functions.find(f => f.name === 'scan-identify').files.find(f => f.path.endsWith('/index.ts')).sha256 = '0'.repeat(64);
  assert.throws(() => verify(policy, actual, ...scan), assert.AssertionError);
  const authority = inputs(); authority[2].role = 'canonical';
  assert.throws(() => verify(policy, actual, ...authority), assert.AssertionError);
  const migration = inputs(); migration[3].ledgerReconciliation.environments.yzqjvdfgefveprobvvyw.knownPending[0].disposition = 'APPLY';
  assert.throws(() => verify(policy, actual, ...migration), assert.AssertionError);
});
