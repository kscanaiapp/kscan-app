'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRanking, aggregateRetrievalMetrics, buildFailureTaxonomyBreakdown } = require('../retrievalEvaluator');

/**
 * Constructed fixtures (never FMQ's real synthetic ones) so each metric can
 * be demonstrated in isolation. Candidates set `color_family` directly (not
 * just `color`/`color_normalized`) to actually exercise
 * FASHION_COMPONENTS's color_family rule - see this file's header note in
 * retrievalEvaluator.js and the PR's LIMITATIONS section for why FMQ's own
 * real synthetic fixtures do not do this and therefore always score
 * color_family as wrong, for control and challenger alike.
 */
function fixture(overrides = {}) {
  return {
    fixtureId: 'unit-test-fixture',
    groundTruth: {
      identitySku: 'SKU-EXACT-1',
      brandNormalized: 'vince',
      category: 'top',
      titleNormalized: 'vince navy fitted top',
      color_family: 'navy',
      material: 'cotton',
      silhouette: 'fitted',
      pattern: 'solid',
    },
    candidateProducts: [
      {
        id: 'exact',
        identitySku: 'SKU-EXACT-1',
        brandNormalized: 'vince',
        category: 'top',
        titleNormalized: 'vince navy fitted top',
        color_family: 'navy',
        material: 'cotton',
        silhouette: 'fitted',
        pattern: 'solid',
        purchaseUrl: 'https://retailer.example/exact',
        availability: 'in_stock',
      },
      {
        id: 'strong-substitute',
        brandNormalized: 'other-brand',
        category: 'top',
        titleNormalized: 'other-brand navy fitted top',
        color_family: 'navy',
        material: 'cotton',
        silhouette: 'fitted',
        pattern: 'solid',
        purchaseUrl: 'https://retailer.example/strong',
        availability: 'in_stock',
      },
      {
        id: 'wrong-color',
        brandNormalized: 'vince',
        category: 'top',
        titleNormalized: 'vince red fitted top',
        color_family: 'red',
        material: 'cotton',
        silhouette: 'fitted',
        pattern: 'solid',
        purchaseUrl: 'https://retailer.example/wrong-color',
        availability: 'in_stock',
      },
      {
        id: 'wrong-category',
        brandNormalized: 'someone-else',
        category: 'footwear',
        titleNormalized: 'someone-else sneaker',
        purchaseUrl: null,
        availability: 'out_of_stock',
      },
      {
        id: 'exact-dup',
        identitySku: 'SKU-EXACT-1',
        brandNormalized: 'vince',
        category: 'top',
        titleNormalized: 'vince navy fitted top',
        color_family: 'navy',
        material: 'cotton',
        silhouette: 'fitted',
        pattern: 'solid',
        purchaseUrl: 'https://other-retailer.example/exact-dup',
        availability: 'in_stock',
      },
    ],
    ...overrides,
  };
}

test('EVALUATOR: the exact candidate at rank 1 scores exactTop1 and usefulTop1 true', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['exact', 'strong-substitute', 'wrong-color', 'wrong-category'], { topK: 5 });
  assert.equal(result.exactTop1, true);
  assert.equal(result.usefulTop1, true);
  assert.equal(result.identityTop1.level, 'EXACT');
});

test('EVALUATOR: the exact candidate buried at rank 3 still counts for exactTop5 but not exactTop1', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['wrong-category', 'wrong-color', 'exact', 'strong-substitute'], { topK: 5 });
  assert.equal(result.exactTop1, false);
  assert.equal(result.exactTopK, true);
});

test('EVALUATOR: a wrong-category, no-purchase-path top result is irrelevant', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['wrong-category', 'exact'], { topK: 5 });
  assert.equal(result.irrelevantTop1, true, JSON.stringify(result));
});

test('EVALUATOR: componentsTop1 flags the wrong-color candidate\'s color_family as 0 (strictly wrong)', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['wrong-color', 'exact'], { topK: 5 });
  assert.equal(result.componentsTop1.color_family, 0);
});

test('EVALUATOR: a top-5 result set containing the exact candidate and its cross-retailer duplicate is flagged hasDuplicateInTopK', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['exact', 'exact-dup', 'strong-substitute'], { topK: 5 });
  assert.equal(result.hasDuplicateInTopK, true);
});

test('EVALUATOR: a result set with no duplicates is not flagged', () => {
  const f = fixture();
  const result = evaluateRanking(f, ['exact', 'wrong-category'], { topK: 5 });
  assert.equal(result.hasDuplicateInTopK, false);
});

test('AGGREGATE: exactTop1Rate/usefulTop1Rate/wrong*Rate compute correctly across a small batch', () => {
  const perFixture = [
    evaluateRanking(fixture({ fixtureId: 'f1' }), ['exact', 'strong-substitute'], { topK: 5 }),
    evaluateRanking(fixture({ fixtureId: 'f2' }), ['wrong-color', 'exact'], { topK: 5 }),
  ];
  const metrics = aggregateRetrievalMetrics(perFixture);
  assert.equal(metrics.n, 2);
  assert.equal(metrics.exactTop1Rate, 0.5);
  assert.equal(metrics.exactTop5Rate, 1);
  assert.equal(metrics.wrongColorRate.rate, 0.5);
  assert.equal(metrics.wrongColorRate.n, 2);
});

test('AGGREGATE: wrongSubtypeRate is explicitly unavailable, never guessed', () => {
  const metrics = aggregateRetrievalMetrics([evaluateRanking(fixture(), ['exact'], { topK: 5 })]);
  assert.equal(metrics.wrongSubtypeRate.rate, null);
  assert.match(metrics.wrongSubtypeRate.reason, /UNAVAILABLE/);
});

test('AGGREGATE: an empty result set produces null rates, not divide-by-zero garbage', () => {
  const metrics = aggregateRetrievalMetrics([]);
  assert.equal(metrics.n, 0);
  assert.equal(metrics.exactTop1Rate, null);
  assert.equal(metrics.duplicateRate, null);
});

test('FAILURE TAXONOMY BREAKDOWN: is structurally complete (every label present) even with zero cases', () => {
  const breakdown = buildFailureTaxonomyBreakdown([]);
  assert.equal(breakdown.totalCasesConsidered, 0);
  assert.ok(Object.keys(breakdown.counts).length > 0);
  assert.ok(Object.values(breakdown.counts).every((n) => n === 0));
});

test('FAILURE TAXONOMY BREAKDOWN: counts real per-case failureTaxonomy labels when present', () => {
  const cases = [{ failureTaxonomy: ['BLACK_NAVY_CONFUSION'] }, { failureTaxonomy: ['BLACK_NAVY_CONFUSION', 'MATERIAL_CONFUSION'] }, {}];
  const breakdown = buildFailureTaxonomyBreakdown(cases);
  assert.equal(breakdown.totalCasesConsidered, 3);
  assert.equal(breakdown.counts.BLACK_NAVY_CONFUSION, 2);
  assert.equal(breakdown.counts.MATERIAL_CONFUSION, 1);
  assert.equal(breakdown.counts.PATTERN_CONFUSION, 0);
});
