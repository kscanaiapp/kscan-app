#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ReleaseManifestError,
  generateReleaseManifest,
  freezeManifest,
  verifyFreeze,
} = require('../../security/release/generate-release-manifest');
const { findEmbeddedSecrets } = require('../../security/scripts/lib/secret-shape-guard');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');

const REPO_ROOT = path.join(__dirname, '..', '..');

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-test-1',
  sourceSha: '7d7c73bd4065ad9a25349e42f347418117d91867',
  sourceTreeSha: 'tree-abc123',
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});

const gen = (overrides = {}) => generateReleaseManifest({ ...BASE, ...overrides });

/**
 * Copies the parts of the repo the generator reads into a temp dir, so
 * mutation tests never touch the real working tree.
 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-release-manifest-'));
  const copyDir = (rel) => {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(root, rel);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDir(path.join(rel, entry.name));
      else if (entry.isFile()) fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join('supabase', 'functions'));
  copyDir(path.join('supabase', 'migrations'));
  copyDir(path.join('security', 'release'));
  copyDir('constants');
  fs.mkdirSync(path.join(root, 'supabase'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'supabase', 'config.toml'), path.join(root, 'supabase', 'config.toml'));
  return root;
}

// ---- determinism ----

test('two generations from identical governed inputs produce an identical identityDigest', () => {
  const a = gen();
  const b = gen();
  assert.equal(a.identityDigest, b.identityDigest);
});

test('observational metadata does not affect identity: different releaseId/createdAt, same digest', () => {
  const a = gen({ releaseId: 'rel-A', createdAt: '2026-01-01T00:00:00.000Z' });
  const b = gen({ releaseId: 'rel-B', createdAt: '2099-12-31T23:59:59.000Z' });
  assert.notEqual(a.releaseId, b.releaseId);
  assert.notEqual(a.createdAt, b.createdAt);
  assert.equal(a.identityDigest, b.identityDigest, 'timestamp/release metadata must not corrupt deterministic comparison');
});

// ---- freeze invalidation ----

test('source SHA change invalidates a prior freeze', () => {
  const frozen = freezeManifest(gen(), { frozenAt: '2026-08-12T00:00:00.000Z' });
  const mutated = gen({ sourceSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  const result = verifyFreeze(frozen, mutated);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('SOURCE_SHA_CHANGED'));
  assert.ok(result.reasons.includes('IDENTITY_DIGEST_CHANGED'));
});

test('source tree change invalidates a prior freeze', () => {
  const frozen = freezeManifest(gen());
  const result = verifyFreeze(frozen, gen({ sourceTreeSha: 'tree-different' }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('SOURCE_TREE_SHA_CHANGED'));
});

test('an unchanged candidate still validates against its freeze', () => {
  const manifest = gen();
  const frozen = freezeManifest(manifest);
  assert.deepEqual(verifyFreeze(frozen, gen()), { valid: true, reasons: [] });
});

test('migration set change invalidates a prior freeze', () => {
  const sandbox = makeSandbox();
  const frozen = freezeManifest(gen({ repoRoot: sandbox }));

  fs.writeFileSync(
    path.join(sandbox, 'supabase', 'migrations', '20260812000000_release_freeze_probe.sql'),
    'create table if not exists public.freeze_probe (id uuid primary key);\n',
  );
  // A brand-new migration with no classification must be refused outright.
  assert.throws(() => gen({ repoRoot: sandbox }), (err) => err instanceof ReleaseManifestError && err.code === 'UNCLASSIFIED_MIGRATION');

  // Once classified, the manifest regenerates - and the freeze is invalid.
  const registryPath = path.join(sandbox, 'security', 'release', 'migration-risk-classifications.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.classifications.release_freeze_probe = { classification: 'EXPANSION_SAFE', rationale: 'test fixture' };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const result = verifyFreeze(frozen, gen({ repoRoot: sandbox }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('MIGRATION_SET_CHANGED'));
  assert.ok(result.reasons.includes('IDENTITY_DIGEST_CHANGED'));
});

test('Edge Function source change invalidates a prior freeze', () => {
  const sandbox = makeSandbox();
  const frozen = freezeManifest(gen({ repoRoot: sandbox }));

  const target = path.join(sandbox, 'supabase', 'functions', 'scan-identify', 'index.ts');
  fs.appendFileSync(target, '\n// release-freeze probe\n');

  const result = verifyFreeze(frozen, gen({ repoRoot: sandbox }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('IDENTITY_DIGEST_CHANGED'));
});

test('shared dependency change invalidates a prior freeze even though no function directory changed', () => {
  const sandbox = makeSandbox();
  const frozen = freezeManifest(gen({ repoRoot: sandbox }));

  const shared = path.join(sandbox, 'supabase', 'functions', '_shared', 'llmModelRouting.ts');
  fs.appendFileSync(shared, '\n// shared probe\n');

  const result = verifyFreeze(frozen, gen({ repoRoot: sandbox }));
  assert.equal(result.valid, false, '_shared changes alter governed function behaviour and must invalidate the freeze');
  assert.ok(result.reasons.includes('IDENTITY_DIGEST_CHANGED'));
});

test('governed config structure change invalidates a prior freeze', () => {
  const frozen = freezeManifest(gen({ env: {} }));
  // Presence of an allowlisted env var is structural, so it moves the fingerprint.
  const result = verifyFreeze(frozen, gen({ env: { KSCAN_DEPLOY_VERSION: 'set-to-something' } }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('CONFIG_FINGERPRINT_CHANGED'));
});

test('config fingerprint tracks env var PRESENCE, never its value', () => {
  const a = gen({ env: { GEMINI_API_KEY: 'value-one' } });
  const b = gen({ env: { GEMINI_API_KEY: 'a-completely-different-value' } });
  assert.equal(a.configFingerprint, b.configFingerprint, 'the fingerprint must not vary with a secret value');
  assert.equal(a.configStructure.environmentVariablePresence.GEMINI_API_KEY, true);

  const absent = gen({ env: {} });
  assert.notEqual(a.configFingerprint, absent.configFingerprint, 'presence vs absence is structural and must be tracked');
});

// ---- secrets ----

// The env values below are deliberately SENTINELS, not realistic credentials.
// They match secret-shape-guard's regexes (so the assertion genuinely proves a
// credential-shaped value cannot reach the manifest) while spelling out that
// they are not real tokens, so repository secret scanning and GitHub Push
// Protection do not fire on this file.
test('generated manifest contains no credential-shaped values', () => {
  const manifest = gen({
    env: {
      GEMINI_API_KEY: 'sbp_NOTAREALTOKENONLYATESTSENTINEL',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'eyJNOT_A_REAL_TOKEN_ONLY_A_TEST_SENTINEL.placeholder',
    },
  });
  // Self-check: the sentinels must genuinely be credential-SHAPED, otherwise
  // the assertion below would pass vacuously for the wrong reason.
  assert.equal(findEmbeddedSecrets('sbp_NOTAREALTOKENONLYATESTSENTINEL').length, 1);
  assert.equal(findEmbeddedSecrets('eyJNOT_A_REAL_TOKEN_ONLY_A_TEST_SENTINEL.placeholder').length, 1);

  assert.deepEqual(findEmbeddedSecrets(manifest, 'manifest'), []);
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes('NOTAREALTOKEN'), 'env values must never reach the manifest');
  assert.ok(!serialized.includes('NOT_A_REAL_TOKEN'), 'env values must never reach the manifest');
});

// ---- governance classification ----

test('quarantined and heritage functions are represented but never release-included', () => {
  const manifest = gen({ liveFunctionNames: ['product-match', 'privacy-controls', 'public-sale-share-opt-out'] });
  const byName = Object.fromEntries(manifest.edgeFunctions.map((f) => [f.name, f]));

  assert.equal(byName['product-match'].class, 'QUARANTINED');
  assert.equal(byName['product-match'].releaseIncluded, false);
  assert.equal(byName['privacy-controls'].class, 'HERITAGE_UNMANAGED');
  assert.equal(byName['privacy-controls'].releaseIncluded, false);
  assert.equal(byName['public-sale-share-opt-out'].class, 'HERITAGE_UNMANAGED');
  assert.equal(byName['public-sale-share-opt-out'].releaseIncluded, false);
});

test('staging-health is excluded with an explicit reason rather than silently dropped', () => {
  const manifest = gen();
  const entry = manifest.edgeFunctions.find((f) => f.name === 'staging-health');
  assert.equal(entry.class, 'EXCLUDED_WITH_REASON');
  assert.equal(entry.releaseIncluded, false);
});

test('an unclassified live-only function is rejected, not ignored', () => {
  assert.throws(
    () => gen({ liveFunctionNames: ['some-function-nobody-classified'] }),
    (err) => err instanceof ReleaseManifestError && err.code === 'UNCLASSIFIED_EDGE_FUNCTION',
  );
});

test('an unclassified repository function directory is rejected, not ignored', () => {
  const sandbox = makeSandbox();
  fs.mkdirSync(path.join(sandbox, 'supabase', 'functions', 'brand-new-surface'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'supabase', 'functions', 'brand-new-surface', 'index.ts'), 'export default 1;\n');
  assert.throws(
    () => gen({ repoRoot: sandbox }),
    (err) => err instanceof ReleaseManifestError && err.code === 'UNCLASSIFIED_EDGE_FUNCTION',
  );
});

test('governed function coverage extends well beyond the prior two-function manifest', () => {
  const manifest = gen();
  const governed = manifest.edgeFunctions.filter((f) => f.releaseIncluded);
  assert.ok(governed.length >= 16, `expected broad governed coverage, got ${governed.length}`);
  for (const name of ['scan-identify', 'stylechat-generate', 'style-outfit-generate', 'handle-user-deletion']) {
    assert.ok(governed.some((f) => f.name === name), `${name} should be governed`);
  }
  for (const fn of governed) {
    assert.ok(fn.sourceHash, `${fn.name} must carry a source hash`);
    assert.ok(fn.sharedDependencyHash, `${fn.name} must carry the shared dependency hash`);
  }
});

// ---- environment authority ----

test('manifest generation fails closed when the declared environment and project ref disagree', () => {
  assert.throws(
    () => gen({ candidateEnvironment: 'staging', candidateProjectRef: PRODUCTION_REF }),
    { code: 'ENVIRONMENT_MISMATCH' },
  );
  assert.throws(
    () => gen({ candidateEnvironment: 'production', candidateProjectRef: STAGING_REF }),
    { code: 'ENVIRONMENT_MISMATCH' },
  );
  assert.throws(() => gen({ candidateProjectRef: 'not-a-real-ref' }), { code: 'MALFORMED_IDENTITY' });
});

// ---- manifest content ----

test('manifest carries the required fields and starts as DRAFT with LKG UNKNOWN', () => {
  const manifest = gen();
  for (const field of [
    'releaseId', 'schemaVersion', 'sourceSha', 'sourceTreeSha', 'createdAt', 'candidateEnvironment',
    'edgeFunctions', 'migrations', 'databaseSchemaState', 'configFingerprint', 'healthContractVersion',
    'featureFlags', 'rollbackTargets', 'lastKnownGood', 'deploymentOrder', 'riskClassification',
    'productionMigrationReconciliation', 'status',
  ]) {
    assert.ok(field in manifest, `manifest must carry ${field}`);
  }
  assert.equal(manifest.status, 'DRAFT');
  assert.equal(manifest.lastKnownGood, 'UNKNOWN');
  assert.equal(manifest.productionMigrationReconciliation.status, 'PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED');
});

test('every repository migration is inventoried with a source hash', () => {
  const manifest = gen();
  const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.equal(manifest.migrations.length, onDisk.length);
  for (const m of manifest.migrations) assert.match(m.sourceHash, /^[a-f0-9]{64}$/);
});
