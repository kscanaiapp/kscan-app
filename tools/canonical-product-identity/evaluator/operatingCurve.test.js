'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sweepOperatingCurve, firstUnsafeThreshold, DEFAULT_SWEEP_THRESHOLDS } = require('./operatingCurve');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

// spec section 43#19: operating curve is complete.
test('OPERATING CURVE: sweeps every configured threshold and reports the full precision/recall/false-merge/missed-merge/abstention set at each point', () => {
  const corpus = loadSyntheticCorpus();
  const curve = sweepOperatingCurve(corpus, { thresholds: [Infinity, 0.9, 0.5] });
  assert.equal(curve.length, 3);
  for (const point of curve) {
    for (const field of ['autoMergePrecision', 'autoMergeRecall', 'falseMergeRate', 'falseMergeCount', 'missedMergeRate', 'abstentionRate', 'falseMergeGateStatus']) {
      assert.ok(field in point, `operating curve point missing field: ${field}`);
    }
  }
});

test('OPERATING CURVE: the shipped default (Infinity) point has zero false merges on the committed corpus', () => {
  const corpus = loadSyntheticCorpus();
  const curve = sweepOperatingCurve(corpus, { thresholds: [Infinity] });
  assert.equal(curve[0].falseMergeCount, 0);
});

test('OPERATING CURVE: lowering the threshold never DECREASES recall (monotonic non-decreasing as the gate loosens)', () => {
  const corpus = loadSyntheticCorpus();
  const curve = sweepOperatingCurve(corpus, { thresholds: [1, 0.9, 0.8, 0.5, 0] });
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i].autoMergeRecall >= curve[i - 1].autoMergeRecall, `recall decreased when loosening from ${curve[i - 1].tier2AutoMergeThreshold} to ${curve[i].tier2AutoMergeThreshold}`);
  }
});

test('OPERATING CURVE: DEFAULT_SWEEP_THRESHOLDS always includes the shipped default (Infinity) as its first point', () => {
  assert.equal(DEFAULT_SWEEP_THRESHOLDS[0], Infinity);
});

test('OPERATING CURVE: firstUnsafeThreshold correctly identifies the first point (scanning conservative -> loose) where a false merge appears', () => {
  const corpus = loadSyntheticCorpus();
  const curve = sweepOperatingCurve(corpus);
  const unsafe = firstUnsafeThreshold(curve);
  if (unsafe !== null) {
    const idx = curve.findIndex((p) => p.tier2AutoMergeThreshold === unsafe);
    assert.equal(curve[idx].falseMergeCount > 0, true);
    for (let i = 0; i < idx; i += 1) assert.equal(curve[i].falseMergeCount, 0, 'every point before the first-unsafe threshold must itself be safe');
  }
});
