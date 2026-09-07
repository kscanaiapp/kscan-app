'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pairedDeltas,
  bootstrapMeanCI,
  estimateNoiseFloor,
  classifyComparison,
  compareScoreMaps,
  MIN_N_FOR_DECISION_GRADE,
} = require('./bootstrap');

test('STATISTICS: paired deltas are computed per fixture and are deterministic in ordering', () => {
  const baseline = { b: 0.5, a: 0.4, c: 0.9 };
  const candidate = { b: 0.6, a: 0.4, c: 0.85 };
  const deltas1 = pairedDeltas(baseline, candidate);
  const deltas2 = pairedDeltas(baseline, candidate);
  assert.deepEqual(deltas1, deltas2);
  assert.deepEqual(deltas1.map((d) => d.fixtureId), ['a', 'b', 'c']); // sorted, not insertion order
  assert.equal(deltas1[1].delta, 0.6 - 0.5);
});

test('STATISTICS: bootstrap CI is deterministic for a fixed seed', () => {
  const deltas = [0.1, 0.2, -0.05, 0.3, 0.0, 0.15];
  const ci1 = bootstrapMeanCI(deltas, { seed: 'fixed-seed-1', iterations: 500 });
  const ci2 = bootstrapMeanCI(deltas, { seed: 'fixed-seed-1', iterations: 500 });
  assert.deepEqual(ci1, ci2);
});

test('STATISTICS: bootstrap CI differs for a different seed (not silently constant)', () => {
  const deltas = [0.1, 0.2, -0.05, 0.3, 0.0, 0.15, 0.22, -0.1];
  const ci1 = bootstrapMeanCI(deltas, { seed: 'seed-a', iterations: 500 });
  const ci2 = bootstrapMeanCI(deltas, { seed: 'seed-b', iterations: 500 });
  assert.notDeepEqual(ci1, ci2);
});

test('STATISTICS: a low sample count is marked NOT_DECISION_GRADE regardless of effect size', () => {
  const ci = { n: 3, lower: 0.5, upper: 0.6, mean: 0.55 };
  const { status } = classifyComparison(ci, { stdDev: null });
  assert.equal(status, 'NOT_DECISION_GRADE');
});

test('STATISTICS: a confidence interval crossing zero is NOT_SIGNIFICANT, never called an improvement', () => {
  const ci = { n: MIN_N_FOR_DECISION_GRADE + 5, lower: -0.02, upper: 0.03, mean: 0.01 };
  const { status } = classifyComparison(ci, { stdDev: null });
  assert.equal(status, 'NOT_SIGNIFICANT');
});

test('STATISTICS: a mean delta within the measured noise floor is WITHIN_NOISE, not IMPROVED', () => {
  const ci = { n: MIN_N_FOR_DECISION_GRADE + 5, lower: 0.01, upper: 0.05, mean: 0.03 };
  const { status } = classifyComparison(ci, { stdDev: 0.05, meanVariance: 0.0025 });
  assert.equal(status, 'WITHIN_NOISE');
});

test('STATISTICS: sufficient N, CI excluding zero, and effect above noise floor is DECISION_GRADE', () => {
  const ci = { n: MIN_N_FOR_DECISION_GRADE + 5, lower: 0.10, upper: 0.20, mean: 0.15 };
  const { status } = classifyComparison(ci, { stdDev: 0.02 });
  assert.equal(status, 'DECISION_GRADE');
});

test('STATISTICS: noise floor is only estimated from fixtures with >=2 repeated runs', () => {
  const noise = estimateNoiseFloor({
    fixtureA: [0.5, 0.52, 0.49],
    fixtureB: [0.7], // single run - excluded
  });
  assert.equal(noise.fixturesWithRepetition, 1);
  assert.ok(noise.stdDev !== null);
});

test('STATISTICS: no repeated-run data yields an honest null noise floor, not a fabricated zero', () => {
  const noise = estimateNoiseFloor({ fixtureA: [0.5] });
  assert.equal(noise.stdDev, null);
  assert.equal(noise.meanVariance, null);
});

test('STATISTICS: compareScoreMaps never returns a DECISION_GRADE status for empty input', () => {
  const result = compareScoreMaps({}, {});
  assert.equal(result.sampleCount, 0);
  assert.notEqual(result.status, 'DECISION_GRADE');
});

test('STATISTICS: full comparison report is deterministic end to end for a fixed seed', () => {
  const baseline = { a: 0.4, b: 0.5, c: 0.6, d: 0.3 };
  const candidate = { a: 0.5, b: 0.5, c: 0.55, d: 0.35 };
  const r1 = compareScoreMaps(baseline, candidate, { seed: 'compare-seed-x' });
  const r2 = compareScoreMaps(baseline, candidate, { seed: 'compare-seed-x' });
  assert.deepEqual(r1, r2);
});
