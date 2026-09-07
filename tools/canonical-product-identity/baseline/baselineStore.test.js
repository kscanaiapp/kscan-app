'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBaseline, writeBaseline, readBaseline, assertBaselinesComparable } = require('./baselineStore');

function baseArgs(overrides = {}) {
  return {
    sourceSha: 'a'.repeat(40),
    corpus: { corpusTier: 'SYNTHETIC', corpusId: 'test', generatorVersion: 'gen-v1' },
    corpusManifest: { manifestHash: 'hash-1' },
    resolverVersion: 'resolver-v1',
    normalizationVersion: 'norm-v1',
    identitySchemaVersion: 'schema-v1',
    operatingParameters: { tier2AutoMergeThreshold: Infinity },
    metrics: { falseMergeCount: 0 },
    ...overrides,
  };
}

// spec section 43#24: baseline overwrite fails.
test('BASELINE: writeBaseline refuses to overwrite an existing DIFFERENT baseline without force', () => {
  const tmp = path.join(os.tmpdir(), `cpil-baseline-test-${process.pid}-${Date.now()}.json`);
  try {
    const first = createBaseline(baseArgs());
    writeBaseline(tmp, first);
    const second = createBaseline(baseArgs({ resolverVersion: 'resolver-v2' }));
    assert.throws(() => writeBaseline(tmp, second), /BASELINE_OVERWRITE_REFUSED/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('BASELINE: writeBaseline succeeds with force:true when replacing a different baseline', () => {
  const tmp = path.join(os.tmpdir(), `cpil-baseline-test-force-${process.pid}-${Date.now()}.json`);
  try {
    const first = createBaseline(baseArgs());
    writeBaseline(tmp, first);
    const second = createBaseline(baseArgs({ resolverVersion: 'resolver-v2' }));
    const result = writeBaseline(tmp, second, { force: true });
    assert.equal(result.written, true);
    const reread = readBaseline(tmp);
    assert.equal(reread.resolverVersion, 'resolver-v2');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('BASELINE: writing an IDENTICAL baseline over itself is always a no-op success, never an error', () => {
  const tmp = path.join(os.tmpdir(), `cpil-baseline-test-identical-${process.pid}-${Date.now()}.json`);
  try {
    const baseline = createBaseline(baseArgs());
    writeBaseline(tmp, baseline);
    const result = writeBaseline(tmp, baseline);
    assert.equal(result.written, false);
    assert.equal(result.reason, 'identical_baseline_already_present');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('BASELINE: createBaseline throws if a required field is missing', () => {
  const args = baseArgs();
  delete args.resolverVersion;
  assert.throws(() => createBaseline(args), /BASELINE_MISSING_REQUIRED_FIELD/);
});

// Addendum A.5#30: fixture manifest-hash mismatch fails.
test('BASELINE: assertBaselinesComparable rejects a corpus-hash (fixture manifest hash) mismatch', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ corpusManifest: { manifestHash: 'hash-2' } }));
  assert.throws(() => assertBaselinesComparable(a, b), /corpus_hash_mismatch/);
});

// Addendum A.5#31: comparison against an incompatible baseline (resolver /
// generator / normalization / schema version) fails.
test('BASELINE: assertBaselinesComparable rejects a resolver-version mismatch', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ resolverVersion: 'resolver-v2' }));
  assert.throws(() => assertBaselinesComparable(a, b), /resolver_version_mismatch/);
});

test('BASELINE: assertBaselinesComparable rejects a generator-version mismatch', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ corpus: { ...baseArgs().corpus, generatorVersion: 'gen-v2' } }));
  assert.throws(() => assertBaselinesComparable(a, b), /generator_version_mismatch/);
});

test('BASELINE: assertBaselinesComparable rejects a normalization-version mismatch', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ normalizationVersion: 'norm-v2' }));
  assert.throws(() => assertBaselinesComparable(a, b), /normalization_version_mismatch/);
});

test('BASELINE: assertBaselinesComparable rejects an identity-schema-version mismatch', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ identitySchemaVersion: 'schema-v2' }));
  assert.throws(() => assertBaselinesComparable(a, b), /identity_schema_version_mismatch/);
});

// spec section 43#22 (A.5#30): comparison across corpus tiers fails.
test('BASELINE: assertBaselinesComparable rejects comparing a SYNTHETIC baseline against an APPROVED_REAL one', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs({ corpus: { ...baseArgs().corpus, corpusTier: 'APPROVED_REAL' } }));
  assert.throws(() => assertBaselinesComparable(a, b), /corpus_tier_mismatch/);
});

test('BASELINE: assertBaselinesComparable accepts two baselines from the same corpus/versions', () => {
  const a = createBaseline(baseArgs());
  const b = createBaseline(baseArgs());
  const { compatible } = assertBaselinesComparable(a, b);
  assert.equal(compatible, true);
});

test('BASELINE: createBaseline rejects a privacy violation anywhere in metrics', () => {
  assert.throws(() => createBaseline(baseArgs({ metrics: { user_id: 'abc' } })), /PRIVACY_GUARD_REJECTED/);
});
