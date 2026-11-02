const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { root, canonical, reviewed, handler, files, gitBlob, approvedRow, expectedReceiptAdvance } = require('./helpers/receiptQuotaPromotion');
const base = '560028ef3f5327989077b19ee6ccbba34f344927';
const json = file => JSON.parse(fs.readFileSync(root + '/' + file, 'utf8'));
const previous = JSON.parse(gitBlob('config/build35-hostile-source-promotion.json', base));
const oldManifest = JSON.parse(gitBlob('config/edge-function-manifest.json', base));
const canonicalManifest = JSON.parse(gitBlob('config/edge-function-manifest.json'));
const policy = json('config/build35-hostile-source-promotion.json');
const actual = new Map(files.map(file => [file, fs.readFileSync(root + '/' + file)]));
const expectedMeta = { canonicalSource: canonical, reviewedSource: reviewed, sourceTree: 'eede8c68273e7b6c6b7bd44dbdfd9c7f96026d68', files };
function verify(p, bytes, manifest) {
  assert.equal(p.files.length, previous.files.length);
  assert.equal(p.files.length, 57);
  assert.deepEqual(p.files, expectedReceiptAdvance(previous.files), 'only the exact reviewed handler row may advance; every other grant is unchanged');
  assert.equal(p.canonicalBackend, canonical);
  assert.deepEqual(p.receiptQuotaIdPromotion, expectedMeta);
  const priorMeta = { ...p }; delete priorMeta.receiptQuotaIdPromotion;
  assert.deepEqual(priorMeta, { ...previous, canonicalBackend: canonical, files: expectedReceiptAdvance(previous.files) });
  assert.deepEqual(p.files.find(row => row.file === handler), approvedRow());
  const tree = sha => execFileSync('git', ['show', '-s', '--format=%T', sha], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(tree(canonical), tree(reviewed));
  for (const file of files) assert.ok(bytes.get(file).equals(gitBlob(file)), file + ' must be exact merged canonical bytes');
  const receipt = m => m.parity.functions.find(f => f.name === 'purchase-import-extract');
  assert.deepEqual(receipt(manifest), receipt(canonicalManifest));
  assert.deepEqual(manifest.parity.functions.filter(f => f.name !== 'purchase-import-extract'), oldManifest.parity.functions.filter(f => f.name !== 'purchase-import-extract'));
}
test('C023 promotes only reviewed receipt source and regressions with all prior grants preserved', () => {
  verify(policy, actual, json('config/edge-function-manifest.json'));
  const authority = json('config/backend-authority.json');
  assert.equal(authority.role, 'integration-convergence-non-authoritative');
  assert.equal(authority.build35CampaignConvergence.sha, canonical);
});
test('unreviewed source, grants, canonical provenance or unrelated manifest mutations are refused', () => {
  for (const file of files) {
    const bad = new Map(actual); bad.set(file, Buffer.concat([bad.get(file), Buffer.from('\n// unreviewed mutation\n')]));
    assert.throws(() => verify(policy, bad, json('config/edge-function-manifest.json')), assert.AssertionError);
  }
  for (const mutate of [p => { p.files[0].sha256 = '0'.repeat(64); }, p => { p.files.find(x => x.file === handler).source = '0'.repeat(40); }, p => { p.files.push({ file: 'supabase/unreviewed.sql' }); }, p => { p.receiptQuotaIdPromotion.files.push('*'); }]) {
    const bad = structuredClone(policy); mutate(bad);
    assert.throws(() => verify(bad, actual, json('config/edge-function-manifest.json')), assert.AssertionError);
  }
  const bad = json('config/edge-function-manifest.json'); bad.parity.functions.find(f => f.name !== 'purchase-import-extract').bundleHash = '0'.repeat(64);
  assert.throws(() => verify(policy, actual, bad), assert.AssertionError);
});
