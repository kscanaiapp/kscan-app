'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateClusters, purityAndCompleteness } = require('./clusterMetrics');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');
const { evaluateAllPairs } = require('./pairwiseEvaluation');

// spec section 24: CLUSTER PURITY / CLUSTER COMPLETENESS.
test('CLUSTER METRICS: purityAndCompleteness scores a perfect partition as 1.0/1.0', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const trueLabel = { a: 'style1', b: 'style1', c: 'style2', d: 'style2' };
  const produced = { a: 'cA', b: 'cA', c: 'cB', d: 'cB' };
  const { purity, completeness } = purityAndCompleteness(ids, (id) => trueLabel[id], (id) => produced[id]);
  assert.equal(purity, 1);
  assert.equal(completeness, 1);
});

test('CLUSTER METRICS: purityAndCompleteness penalizes a cluster that mixes two true labels', () => {
  const ids = ['a', 'b', 'c'];
  const trueLabel = { a: 'style1', b: 'style1', c: 'style2' };
  const produced = { a: 'cA', b: 'cA', c: 'cA' }; // c incorrectly folded into the same cluster
  const { purity } = purityAndCompleteness(ids, (id) => trueLabel[id], (id) => produced[id]);
  assert.ok(purity < 1);
});

// Addendum A.4: VARIANT-SEPARATION ACCURACY.
test('CLUSTER METRICS (integration): variantClusterPurity is 1.0 on the real corpus at the shipped default (zero false merges anywhere)', () => {
  const corpus = loadSyntheticCorpus();
  const pairEvals = evaluateAllPairs(corpus);
  const result = evaluateClusters(corpus, pairEvals);
  assert.equal(result.variantClusterPurity, 1);
});

test('CLUSTER METRICS (integration): variantSeparationAccuracy and failure list are internally consistent', () => {
  const corpus = loadSyntheticCorpus();
  const pairEvals = evaluateAllPairs(corpus);
  const result = evaluateClusters(corpus, pairEvals);
  assert.ok(result.variantSeparationPairCount > 0);
  const expectedAccuracy = 1 - result.variantSeparationFailureCount / result.variantSeparationPairCount;
  assert.ok(Math.abs(result.variantSeparationAccuracy - expectedAccuracy) < 1e-9);
});
