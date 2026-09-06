'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBaseline,
  writeBaseline,
  readBaseline,
  assertBaselinesComparable,
} = require('./baselineStore');
const { buildCorpusManifest } = require('../fixtures/manifest');
const { generateSyntheticCorpus } = require('../fixtures/generator');
const { RUBRIC_VERSION } = require('../evaluator/rubric');

function tmpPath() {
  return path.join(os.tmpdir(), `fmql-baseline-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeBaseline(overrides = {}) {
  const manifest = buildCorpusManifest(generateSyntheticCorpus());
  return createBaseline({
    sourceSha: 'a'.repeat(40),
    fixtureManifest: manifest,
    rubricVersion: RUBRIC_VERSION,
    evaluationMode: 'TEST',
    metrics: { ok: true },
    perFixtureScore: { f1: 0.9 },
    ...overrides,
  });
}

test('BASELINE: required fields are present on every created baseline', () => {
  const baseline = makeBaseline();
  for (const field of ['sourceSha', 'fixtureManifestHash', 'corpusTier', 'rubricVersion', 'schemaVersion', 'capturePolicy', 'evaluationMode', 'generatedAt']) {
    assert.ok(baseline[field] !== undefined && baseline[field] !== null, `missing ${field}`);
  }
});

test('BASELINE: writing a new baseline succeeds', () => {
  const file = tmpPath();
  const baseline = makeBaseline();
  const result = writeBaseline(file, baseline);
  assert.equal(result.written, true);
  const readBack = readBaseline(file);
  assert.equal(readBack.contentHash, baseline.contentHash);
  fs.unlinkSync(file);
});

test('BASELINE: overwrite is refused without force (immutability, spec section 23)', () => {
  const file = tmpPath();
  const original = makeBaseline();
  writeBaseline(file, original);
  const different = makeBaseline({ metrics: { ok: false } });
  assert.throws(() => writeBaseline(file, different), /BASELINE_OVERWRITE_REFUSED/);
  fs.unlinkSync(file);
});

test('BASELINE: overwrite succeeds with force:true', () => {
  const file = tmpPath();
  const original = makeBaseline();
  writeBaseline(file, original);
  const different = makeBaseline({ metrics: { ok: false } });
  const result = writeBaseline(file, different, { force: true });
  assert.equal(result.written, true);
  fs.unlinkSync(file);
});

test('BASELINE: re-writing an identical baseline is a no-op, not an error', () => {
  const file = tmpPath();
  const baseline = makeBaseline();
  writeBaseline(file, baseline);
  const result = writeBaseline(file, baseline);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'identical_baseline_already_present');
  fs.unlinkSync(file);
});

test('BASELINE: reading a missing baseline throws', () => {
  assert.throws(() => readBaseline(tmpPath()), /BASELINE_NOT_FOUND/);
});

test('BASELINE: reading a malformed baseline (missing required field) throws', () => {
  const file = tmpPath();
  fs.writeFileSync(file, JSON.stringify({ sourceSha: 'x' }));
  assert.throws(() => readBaseline(file), /BASELINE_MALFORMED/);
  fs.unlinkSync(file);
});

test('BASELINE: comparing baselines with mismatched fixture manifest hash is rejected', () => {
  const a = makeBaseline();
  const differentFixtures = generateSyntheticCorpus().slice(0, 1);
  const b = createBaseline({
    sourceSha: 'b'.repeat(40),
    fixtureManifest: buildCorpusManifest(differentFixtures),
    rubricVersion: RUBRIC_VERSION,
    evaluationMode: 'TEST',
    metrics: {},
    perFixtureScore: {},
  });
  assert.throws(() => assertBaselinesComparable(a, b), /fixture_manifest_hash_mismatch/);
});

test('BASELINE: comparing baselines with mismatched rubric version is rejected', () => {
  const a = makeBaseline();
  const b = makeBaseline({ rubricVersion: 'some-other-rubric-v9' });
  assert.throws(() => assertBaselinesComparable(a, b), /rubric_version_mismatch/);
});

test('BASELINE: comparing two identically-configured baselines is accepted', () => {
  const a = makeBaseline();
  const b = makeBaseline();
  const { compatible } = assertBaselinesComparable(a, b);
  assert.equal(compatible, true);
});
