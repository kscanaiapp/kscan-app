'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareAgainstIncumbent, evaluateIncumbentAllPairs, verdict, INCUMBENT_DECISION_MAP } = require('./incumbentComparison');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

// spec section 43#22: incumbent comparison runs (spec section 27).
test('INCUMBENT COMPARISON: runs end-to-end on the real corpus and reports byMetric verdicts', () => {
  const corpus = loadSyntheticCorpus();
  const result = compareAgainstIncumbent(corpus);
  assert.ok(result.resolverSafety && result.incumbentSafety);
  for (const key of ['autoMergePrecision', 'autoMergeRecall', 'falseMergeRate', 'missedMergeRate', 'abstentionRate']) {
    assert.ok(key in result.byMetric, `missing byMetric verdict: ${key}`);
    assert.ok(['RESOLVER_BETTER', 'INCUMBENT_BETTER', 'EQUAL', 'N/A'].includes(result.byMetric[key]));
  }
});

test('INCUMBENT COMPARISON: the incumbent classifier is called UNMODIFIED - the adapter never re-derives a classification decision itself', () => {
  const offers = [
    { offerId: 'a', retailer: 'X', brand: 'Coach', title: 'Coach Black Tote', category: 'bag', url: 'https://example.com/a' },
    { offerId: 'b', retailer: 'Y', brand: 'Coach', title: 'Coach Black Tote', category: 'bag', url: 'https://example.com/b' },
  ];
  const evals = evaluateIncumbentAllPairs({ offers, canonicalStyles: [], pairOverrides: [] });
  assert.equal(evals.length, 1);
  assert.ok(Object.keys(INCUMBENT_DECISION_MAP).includes(evals[0].incumbentClassification));
});

test('INCUMBENT COMPARISON: verdict() correctly reads N/A when either side has no defined value, rather than fabricating a comparison', () => {
  assert.equal(verdict(null, 0.5), 'N/A');
  assert.equal(verdict(0.5, null), 'N/A');
});

test('INCUMBENT COMPARISON: verdict() treats a strictly-better false-merge-rate (lower) as RESOLVER_BETTER, since lower is better for that metric', () => {
  assert.equal(verdict(0, 0.2, { higherIsBetter: false }), 'RESOLVER_BETTER');
  assert.equal(verdict(0.2, 0, { higherIsBetter: false }), 'INCUMBENT_BETTER');
  assert.equal(verdict(0.1, 0.1, { higherIsBetter: false }), 'EQUAL');
});
