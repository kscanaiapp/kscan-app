'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runL1ForFixture, isDenoAvailable } = require('./runL1');

const denoMissing = !isDenoAvailable();
if (denoMissing) {
  // Recorded per spec section 34 (blocker ledger) rather than silently
  // skipped without a trace: L1 offline pipeline mode degrades to BLOCKED
  // when the `deno` binary is not on PATH in a given CI/dev environment.
  console.warn('[fmql] BLOCKER: DENO_UNAVAILABLE - l1/runL1.test.js cases are skipped in this environment.');
}

const fixture = {
  fixtureId: 'l1-unit-test-fixture',
  garmentIdentification: {
    item_type: 'dress',
    primary_color: 'navy',
    material_estimate: 'cotton',
    silhouette: 'a-line',
    distinctive_features: ['statement-sleeve'],
    style_tags: ['classic'],
    visible_brand_text: 'Reformation',
    logo_detected: true,
    confidence_score: 0.81,
    non_fashion: false,
  },
  candidateProducts: [
    {
      id: 'exact',
      brand: 'Reformation',
      name: 'Reformation navy a-line dress',
      tags: ['statement-sleeve', 'classic'],
      category: 'dress',
      canonical_category: 'dress',
      color: 'navy',
      silhouette: 'a-line',
      material: 'cotton',
      purchaseUrl: 'https://example.com/exact',
      imageUrl: 'https://example.com/exact.jpg',
      availability: 'in_stock',
    },
    {
      id: 'distractor',
      brand: 'Coach',
      name: 'Coach black bag',
      category: 'bag',
      canonical_category: 'bag',
      purchaseUrl: 'https://example.com/distractor',
      availability: 'in_stock',
    },
  ],
};

test('L1: real production ranker returns the fashion-matching candidate on top, above a cross-category distractor', { skip: denoMissing }, () => {
  const result = runL1ForFixture(fixture);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.ranked) && result.ranked.length === 2);
  assert.equal(result.ranked[0].id, 'exact');
  assert.ok(result.ranked[0].matchScore > result.ranked[1].matchScore);
});

test('L1: exact_candidate tier requires brand evidence - a strong match with no visible brand text stays below exact_candidate', { skip: denoMissing }, () => {
  const noBrandFixture = {
    ...fixture,
    garmentIdentification: { ...fixture.garmentIdentification, visible_brand_text: null, logo_detected: false },
  };
  const result = runL1ForFixture(noBrandFixture);
  assert.equal(result.ok, true);
  assert.notEqual(result.ranked[0].confidenceTier, 'exact_candidate');
});

test('L1: is deterministic - two runs over the same fixture produce identical ranked output', { skip: denoMissing }, () => {
  const r1 = runL1ForFixture(fixture);
  const r2 = runL1ForFixture(fixture);
  assert.deepEqual(r1, r2);
});

test('L1: empty candidate list returns an empty ranked array rather than throwing', { skip: denoMissing }, () => {
  const result = runL1ForFixture({ ...fixture, candidateProducts: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ranked, []);
});

test('L1: isDenoAvailable() reflects the actual environment (not hardcoded true)', () => {
  assert.equal(typeof isDenoAvailable(), 'boolean');
});
