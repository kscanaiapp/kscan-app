'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateDedupWasteMetrics } = require('./dedupWasteMetrics');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

// spec section 24: DUPLICATE-INVENTORY WASTE@K, UNIQUE CANONICAL PRODUCTS@K, RETAILER-DIVERSITY DELTA.
test('DEDUP WASTE METRICS: reports every required K size with waste/unique-canonical/retailer-diversity fields', () => {
  const corpus = loadSyntheticCorpus();
  const result = aggregateDedupWasteMetrics(corpus, { kSizes: [10] });
  assert.ok(result.byK[10]);
  for (const field of ['averageWasteRaw', 'averageWasteCanonical', 'averageUniqueCanonicalProducts', 'averageConcentrationDelta']) {
    assert.ok(field in result.byK[10], `missing field: ${field}`);
  }
});

test('DEDUP WASTE METRICS: canonical waste is never negative and never exceeds 1', () => {
  const corpus = loadSyntheticCorpus();
  const result = aggregateDedupWasteMetrics(corpus, { kSizes: [10, 20] });
  for (const w of result.perWindow) {
    assert.ok(w.wasteCanonical >= 0 && w.wasteCanonical <= 1);
  }
});

test('DEDUP WASTE METRICS: canonicalCount never exceeds the window size (canonicalization can only reduce or hold the visible product count)', () => {
  const corpus = loadSyntheticCorpus();
  const result = aggregateDedupWasteMetrics(corpus, { kSizes: [10, 20, 40] });
  for (const w of result.perWindow) {
    assert.ok(w.canonicalCount <= w.windowSize);
  }
});
