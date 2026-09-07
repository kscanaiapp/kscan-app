'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeSafetyMetrics, buildConfusionMatrix, FALSE_MERGE_GROUND_TRUTHS } = require('./safetyMetrics');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');
const { evaluateAllPairs } = require('./pairwiseEvaluation');

function pair(decision, groundTruthLabel) {
  return { offerIdA: 'a', offerIdB: 'b', decision, groundTruthLabel };
}

// spec section 43#18: false-merge metric is independently correct.
test('SAFETY METRICS: falseMergeRate counts ONLY auto-merged pairs whose ground truth is UNDECIDABLE/NEAR_DUPLICATE_DISTINCT/DISTINCT, never SIBLING_VARIANT or SAME_VARIANT (Addendum A.4)', () => {
  const evals = [
    pair('AUTO_MERGE', 'SAME_VARIANT'), // correct merge, not a false merge
    pair('AUTO_MERGE', 'SIBLING_VARIANT'), // wrong variant boundary, but NOT counted in falseMergeRate per A.4 (tracked separately)
    pair('AUTO_MERGE', 'DISTINCT'), // a genuine false merge
    pair('AUTO_MERGE', 'NEAR_DUPLICATE_DISTINCT'), // a genuine false merge
    pair('AUTO_MERGE', 'UNDECIDABLE'), // a genuine false merge
    pair('SEPARATE', 'DISTINCT'),
  ];
  const metrics = computeSafetyMetrics(evals);
  assert.equal(metrics.falseMergeCount, 3);
  assert.equal(metrics.siblingVariantAutoMergedCount, 1);
  assert.equal(metrics.falseMergeRate, 3 / 5); // 3 false merges out of 5 total AUTO_MERGE decisions
});

test('SAFETY METRICS: zero auto-merges yields falseMergeRate 0 (vacuously safe), not null or NaN', () => {
  const evals = [pair('ABSTAIN', 'DISTINCT'), pair('SEPARATE', 'SAME_VARIANT')];
  const metrics = computeSafetyMetrics(evals);
  assert.equal(metrics.falseMergeRate, 0);
  assert.equal(metrics.falseMergeCount, 0);
});

test('SAFETY METRICS: any false merge produces a FAIL / NOT_PROMOTABLE gate status (section 25)', () => {
  const evals = [pair('AUTO_MERGE', 'DISTINCT')];
  const metrics = computeSafetyMetrics(evals);
  assert.ok(/FAIL/.test(metrics.falseMergeGateStatus));
  assert.ok(/NOT_PROMOTABLE/.test(metrics.falseMergeGateStatus));
});

test('SAFETY METRICS: zero false merges produces a PASS gate status', () => {
  const evals = [pair('AUTO_MERGE', 'SAME_VARIANT')];
  const metrics = computeSafetyMetrics(evals);
  assert.ok(/PASS/.test(metrics.falseMergeGateStatus));
});

test('SAFETY METRICS: abstentionCorrectness measures ABSTAIN specifically on UNDECIDABLE ground truth, not overall abstention rate', () => {
  const evals = [
    pair('ABSTAIN', 'UNDECIDABLE'),
    pair('ABSTAIN', 'UNDECIDABLE'),
    pair('PROPOSED_REVIEW', 'UNDECIDABLE'), // an UNDECIDABLE pair that did NOT abstain
    pair('ABSTAIN', 'DISTINCT'), // abstained but not an UNDECIDABLE pair - irrelevant to abstentionCorrectness
  ];
  const metrics = computeSafetyMetrics(evals);
  assert.equal(metrics.undecidablePairCount, 3);
  assert.equal(metrics.abstentionCorrectness, 2 / 3);
  assert.equal(metrics.abstentionRate, 3 / 4); // overall: 3 of 4 total pairs abstained
});

test('SAFETY METRICS: missedMergeRate counts SAME_VARIANT pairs that did not AUTO_MERGE', () => {
  const evals = [
    pair('AUTO_MERGE', 'SAME_VARIANT'),
    pair('PROPOSED_REVIEW', 'SAME_VARIANT'),
    pair('ABSTAIN', 'SAME_VARIANT'),
  ];
  const metrics = computeSafetyMetrics(evals);
  assert.equal(metrics.missedMergeCount, 2);
  assert.equal(metrics.missedMergeRate, 2 / 3);
});

test('SAFETY METRICS: confusion matrix covers every ground-truth label x decision cell, including zero cells', () => {
  const matrix = buildConfusionMatrix([pair('AUTO_MERGE', 'SAME_VARIANT')]);
  assert.equal(matrix.SAME_VARIANT.AUTO_MERGE, 1);
  assert.equal(matrix.DISTINCT.AUTO_MERGE, 0); // present and zero, not missing
  assert.equal(Object.keys(matrix).length, 5); // all 5 A.4 ground-truth labels present
});

test('SAFETY METRICS: F1 is reported only as a secondary metric, alongside (never instead of) precision/recall/falseMergeRate', () => {
  const evals = [pair('AUTO_MERGE', 'SAME_VARIANT'), pair('SEPARATE', 'DISTINCT')];
  const metrics = computeSafetyMetrics(evals);
  assert.ok('f1Secondary' in metrics);
  assert.ok('autoMergePrecision' in metrics && 'autoMergeRecall' in metrics && 'falseMergeRate' in metrics);
});

// Independently re-run on the real corpus as an integration-level check
// that the whole pipeline stays inside the section 25 gate on the shipped default.
test('SAFETY METRICS (integration): the real synthetic corpus, at the shipped default operating point, has zero false merges', () => {
  const corpus = loadSyntheticCorpus();
  const pairEvals = evaluateAllPairs(corpus);
  const metrics = computeSafetyMetrics(pairEvals);
  assert.equal(metrics.falseMergeCount, 0);
  assert.equal(FALSE_MERGE_GROUND_TRUTHS.length, 3);
});
