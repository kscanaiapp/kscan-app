'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateFixture, validateCorpus } = require('./fixtureSchema');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');
const { generateSyntheticCorpus } = require('../fixtures/generator');
const { buildCorpusManifest } = require('../fixtures/manifest');

function baseFixture(overrides = {}) {
  return {
    fixtureId: 'test-fixture-1',
    corpusTier: 'SYNTHETIC',
    captureProfile: 'ios-current-v1',
    pairedFixtureId: null,
    groundTruth: {
      source: 'synthetic_generator_construction',
      confidence: 'authoritative',
      category: 'dress',
    },
    garmentIdentification: { item_type: 'dress' },
    candidateProducts: [{ id: 'p1' }, { id: 'p2' }],
    ...overrides,
  };
}

test('SCHEMA: a valid fixture is accepted', () => {
  const { valid, errors } = validateFixture(baseFixture());
  assert.equal(valid, true, errors.join('; '));
});

test('SCHEMA: duplicate fixture id across a corpus is rejected', () => {
  const a = baseFixture({ fixtureId: 'dup-id' });
  const b = baseFixture({ fixtureId: 'dup-id' });
  const { valid, errors } = validateCorpus([a, b]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('duplicate fixtureId')));
});

test('SCHEMA: duplicate product id within one fixture is rejected', () => {
  const fixture = baseFixture({ candidateProducts: [{ id: 'same' }, { id: 'same' }] });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('duplicate product ids')));
});

test('SCHEMA: missing ground-truth provenance is rejected', () => {
  const fixture = baseFixture({ groundTruth: { confidence: 'authoritative', category: 'dress' } });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('groundTruth.source')));
});

test('SCHEMA: a SYNTHETIC fixture claiming retailer_pdp provenance is rejected (no fabricated provenance)', () => {
  const fixture = baseFixture({
    groundTruth: { source: 'retailer_pdp', confidence: 'authoritative', category: 'dress' },
  });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('synthetic_generator_construction')));
});

test('SCHEMA: an APPROVED_REAL fixture cannot use the synthetic ground-truth source', () => {
  const fixture = baseFixture({
    corpusTier: 'APPROVED_REAL',
    groundTruth: { source: 'synthetic_generator_construction', confidence: 'authoritative', category: 'dress' },
  });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('must not use the synthetic ground-truth source')));
});

test('SCHEMA: unsupported corpusTier value is rejected (unsupported fields handled correctly)', () => {
  const fixture = baseFixture({ corpusTier: 'MADE_UP_TIER' });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('corpusTier must be one of')));
});

test('SCHEMA: unsupported captureProfile value is rejected', () => {
  const fixture = baseFixture({ captureProfile: 'windows-phone-v1' });
  const { valid, errors } = validateFixture(fixture);
  assert.equal(valid, false);
});

test('SCHEMA: generator is deterministic - two calls produce byte-identical corpora', () => {
  const a = generateSyntheticCorpus();
  const b = generateSyntheticCorpus();
  assert.deepEqual(a, b);
});

test('SCHEMA: fixture/corpus manifest hash is stable for identical content', () => {
  const fixtures = generateSyntheticCorpus();
  const h1 = buildCorpusManifest(fixtures).manifestHash;
  const h2 = buildCorpusManifest(fixtures).manifestHash;
  assert.equal(h1, h2);
});

test('SCHEMA: manifest hash changes if fixture content changes', () => {
  const fixtures = generateSyntheticCorpus();
  const mutated = fixtures.map((f, i) => (i === 0 ? { ...f, groundTruth: { ...f.groundTruth, category: 'mutated' } } : f));
  const h1 = buildCorpusManifest(fixtures).manifestHash;
  const h2 = buildCorpusManifest(mutated).manifestHash;
  assert.notEqual(h1, h2);
});

test('SCHEMA: the committed synthetic corpus on disk validates cleanly', () => {
  const fixtures = loadSyntheticCorpus();
  assert.ok(fixtures.length > 0, 'expected at least one committed synthetic fixture');
  const { valid, errors } = validateCorpus(fixtures);
  assert.equal(valid, true, errors.join('; '));
});
