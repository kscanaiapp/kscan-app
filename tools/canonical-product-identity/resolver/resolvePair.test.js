'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePair } = require('./resolvePair');
const { generateValidGtin13 } = require('../lib/identifierNormalize');

const GTIN_A = generateValidGtin13({ int: (min, max) => Math.floor((min + max) / 2) });
const GTIN_B = generateValidGtin13({ int: () => 7 });

function offer(overrides) {
  return {
    offerId: overrides.offerId,
    retailer: 'Retailer',
    brand: 'Aritzia',
    title: 'Aritzia Cropped Moto Jacket - Black Lambskin',
    category: 'jacket',
    color: 'black',
    material: 'lambskin',
    ...overrides,
  };
}

// spec section 43#4: same variant across retailers merges.
test('RESOLVE PAIR: matching validated GTIN across different retailers is AUTO_MERGE eligible (Tier 1)', () => {
  const a = offer({ offerId: 'a', retailer: 'Nordstrom', gtin: GTIN_A });
  const b = offer({ offerId: 'b', retailer: 'Revolve', gtin: GTIN_A });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'AUTO_MERGE');
  assert.equal(result.tier, 'TIER1');
});

// spec section 43#5: size differences do not split identity.
test('RESOLVE PAIR: size availability is never consulted for identity - two offers differing only in sizeAvailable still auto-merge on GTIN', () => {
  const a = offer({ offerId: 'a', gtin: GTIN_A, sizeAvailable: ['S', 'M'] });
  const b = offer({ offerId: 'b', gtin: GTIN_A, sizeAvailable: ['L', 'XL'] });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'AUTO_MERGE');
});

// spec section 43#6: meaningful color differences create sibling variants (never AUTO_MERGE, never a hidden match).
test('RESOLVE PAIR: a color conflict is hard-negative evidence and blocks merge even with strong supporting evidence', () => {
  const a = offer({ offerId: 'a', color: 'black' });
  const b = offer({ offerId: 'b', color: 'brown', title: 'Aritzia Cropped Moto Jacket - Brown Lambskin' });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'SEPARATE');
  assert.ok(result.negativeEvidence.some((e) => e.includes('color_conflict')));
  assert.ok(result.variantAttributeConflict);
});

// spec section 43#7: meaningful material differences create sibling variants.
test('RESOLVE PAIR: a material conflict is hard-negative evidence and blocks merge', () => {
  const a = offer({ offerId: 'a', material: 'lambskin' });
  const b = offer({ offerId: 'b', material: 'suede', title: 'Aritzia Cropped Moto Jacket - Black Suede' });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'SEPARATE');
  assert.ok(result.negativeEvidence.some((e) => e.includes('material_conflict')));
});

// spec section 43#8: price differences do not prevent identity.
test('RESOLVE PAIR: a large price difference does not block a GTIN match', () => {
  const a = offer({ offerId: 'a', gtin: GTIN_A, price: 475 });
  const b = offer({ offerId: 'b', gtin: GTIN_A, price: 149 });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'AUTO_MERGE');
});

// spec section 43#9: retailer differences do not prevent identity.
test('RESOLVE PAIR: different retailers alone do not block a GTIN match, and retailer identity never appears as evidence', () => {
  const a = offer({ offerId: 'a', retailer: 'Saks Fifth Avenue', gtin: GTIN_A });
  const b = offer({ offerId: 'b', retailer: 'Poshmark', gtin: GTIN_A });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'AUTO_MERGE');
  const allEvidence = [...result.positiveEvidence, ...result.negativeEvidence, ...result.missingEvidence];
  assert.ok(!allEvidence.some((e) => /retailer/i.test(e)), 'retailer must never appear as identity evidence (section 12)');
});

// spec section 43#10: URLs alone do not establish identity.
test('RESOLVE PAIR: two offers sharing NOTHING but a URL-shaped field and no other evidence never AUTO_MERGE', () => {
  const a = { offerId: 'a', retailer: 'X', url: 'https://example.com/p/1' };
  const b = { offerId: 'b', retailer: 'Y', url: 'https://example.com/p/1' }; // identical URL, zero other signals
  const result = resolvePair(a, b);
  assert.notEqual(result.decision, 'AUTO_MERGE');
});

// spec section 43#11: same-brand adjacent styles do not merge.
test('RESOLVE PAIR: same brand, different style name (adjacent product) does not merge even with matching color/material', () => {
  const a = offer({ offerId: 'a', title: 'Aritzia Oversized Bomber Jacket - Black Lambskin' });
  const b = offer({ offerId: 'b', title: 'Aritzia Cropped Moto Jacket - Black Lambskin' });
  const result = resolvePair(a, b);
  assert.notEqual(result.decision, 'AUTO_MERGE');
});

// spec section 43#12: cross-brand lookalikes do not merge.
test('RESOLVE PAIR: identical category/color/material but different brand is a hard negative, never merges', () => {
  const a = offer({ offerId: 'a', brand: 'Vince' });
  const b = offer({ offerId: 'b', brand: 'Theory' });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'SEPARATE');
  assert.ok(result.negativeEvidence.some((e) => e.includes('brand_conflict')));
});

// spec section 43#13: conflicting strong IDs block merge.
test('RESOLVE PAIR: conflicting validated GTINs block merge regardless of matching supporting evidence', () => {
  const a = offer({ offerId: 'a', gtin: GTIN_A });
  const b = offer({ offerId: 'b', gtin: GTIN_B });
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'SEPARATE');
  assert.ok(result.negativeEvidence.some((e) => e.includes('validated_gtin_conflict')));
});

// spec section 43#14: missing IDs safely fall through (no identifier crash/false claim, resolver still reasons from supporting evidence).
test('RESOLVE PAIR: neither offer has any strong identifier - resolver falls through to Tier 2 without throwing', () => {
  const a = offer({ offerId: 'a' });
  const b = offer({ offerId: 'b' });
  assert.doesNotThrow(() => resolvePair(a, b));
  const result = resolvePair(a, b);
  assert.notEqual(result.tier, 'TIER1');
});

// spec section 43#15: uncertain cases abstain.
test('RESOLVE PAIR: two offers with almost no shared evidence ABSTAIN rather than guessing', () => {
  const a = { offerId: 'a', retailer: 'X', title: 'Item' };
  const b = { offerId: 'b', retailer: 'Y', title: 'Item' };
  const result = resolvePair(a, b);
  assert.equal(result.decision, 'ABSTAIN');
});

// spec section 43#16: pairwise evidence is complete (full explainability record).
test('RESOLVE PAIR: every result carries the full explainability record (section 16)', () => {
  const a = offer({ offerId: 'a', gtin: GTIN_A });
  const b = offer({ offerId: 'b', gtin: GTIN_A });
  const result = resolvePair(a, b);
  for (const field of ['decision', 'tier', 'positiveEvidence', 'negativeEvidence', 'missingEvidence', 'normalizationVersion', 'resolverVersion']) {
    assert.ok(field in result, `missing explainability field: ${field}`);
  }
  // Tier 2 is still computed and reported even when Tier 1 already decided
  // the outcome (brand+category agree here, so it is styleEligible) - the
  // heuristic score is informational, correctly labeled, and never what
  // drove this particular AUTO_MERGE (tier === 'TIER1').
  assert.equal(result.tier, 'TIER1');
  assert.equal(result.heuristicScoreLabel, 'HEURISTIC SCORE - NOT CALIBRATED PROBABILITY');
});

test('RESOLVE PAIR: a Tier 2 heuristic score is always labeled, never presented as a calibrated probability (section 16)', () => {
  const a = offer({ offerId: 'a' });
  const b = offer({ offerId: 'b' });
  const result = resolvePair(a, b);
  if (result.heuristicScore !== null) {
    assert.equal(result.heuristicScoreLabel, 'HEURISTIC SCORE - NOT CALIBRATED PROBABILITY');
  }
});

// spec section 43#23: resolver is deterministic.
test('RESOLVE PAIR: identical input produces byte-identical output across repeated calls', () => {
  const a = offer({ offerId: 'a', gtin: GTIN_A });
  const b = offer({ offerId: 'b', gtin: GTIN_A });
  const r1 = JSON.stringify(resolvePair(a, b));
  const r2 = JSON.stringify(resolvePair(a, b));
  const r3 = JSON.stringify(resolvePair(a, b));
  assert.equal(r1, r2);
  assert.equal(r2, r3);
});

test('RESOLVE PAIR: throws on a self-pair (identical offerId) rather than silently returning a decision', () => {
  const a = offer({ offerId: 'same' });
  assert.throws(() => resolvePair(a, { ...a }));
});

test('RESOLVE PAIR: Tier 2 auto-merge is disabled by default (threshold Infinity) - a perfect structured match without an identifier still PROPOSED_REVIEWs, never auto-merges', () => {
  const a = offer({ offerId: 'a' });
  const b = offer({ offerId: 'b' });
  const result = resolvePair(a, b);
  assert.notEqual(result.decision, 'AUTO_MERGE');
});
