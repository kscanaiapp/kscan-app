'use strict';

const { SeededRandom } = require('../lib/seededRandom');

/**
 * Statistical comparison machinery (spec section 18).
 *
 * Everything here is deterministic for a fixed seed - two runs over the
 * same paired deltas with the same seed produce bit-identical confidence
 * intervals (proven by statistics/bootstrap.test.js).
 */

const STATUSES = Object.freeze([
  'DECISION_GRADE',
  'NOT_DECISION_GRADE',
  'NOT_SIGNIFICANT',
  'WITHIN_NOISE',
]);

// Below this sample size, no comparison is treated as decision-grade,
// regardless of the observed effect (spec section 17 "Minimum N").
const MIN_N_FOR_DECISION_GRADE = 30;

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

/**
 * Paired per-fixture deltas: candidateScores[i] - baselineScores[i] for the
 * same fixtureId, in fixtureId-sorted order (deterministic iteration order
 * regardless of input order).
 */
function pairedDeltas(baselineByFixture, candidateByFixture) {
  const fixtureIds = Object.keys(baselineByFixture)
    .filter((id) => Object.prototype.hasOwnProperty.call(candidateByFixture, id))
    .sort();

  return fixtureIds.map((fixtureId) => ({
    fixtureId,
    baseline: baselineByFixture[fixtureId],
    candidate: candidateByFixture[fixtureId],
    delta: candidateByFixture[fixtureId] - baselineByFixture[fixtureId],
  }));
}

/**
 * Seeded bootstrap CI for the mean delta. `seed` must be supplied by the
 * caller (typically derived from the baseline+candidate identifiers) so the
 * same comparison always reproduces the same CI.
 */
function bootstrapMeanCI(deltas, { iterations = 2000, seed = 'fmql-bootstrap-default-seed', alpha = 0.05 } = {}) {
  if (deltas.length === 0) {
    return { lower: 0, upper: 0, mean: 0, n: 0 };
  }
  const rng = new SeededRandom(seed);
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < deltas.length; j += 1) {
      sample.push(deltas[rng.int(0, deltas.length - 1)]);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  const lowerIdx = Math.floor((alpha / 2) * means.length);
  const upperIdx = Math.ceil((1 - alpha / 2) * means.length) - 1;
  return {
    lower: means[Math.max(0, lowerIdx)],
    upper: means[Math.min(means.length - 1, upperIdx)],
    mean: mean(deltas),
    n: deltas.length,
  };
}

/**
 * Estimate a run-to-run noise floor from repeated-run samples of the SAME
 * fixture (spec section 18 - "N >= 3 runs per fixture" for future live
 * methodology). Returns { meanVariance, stdDev } across fixtures that have
 * >= 2 repetitions; fixtures with < 2 repetitions are excluded (not
 * defaulted to zero noise).
 */
function estimateNoiseFloor(repeatedRunsByFixture) {
  const variances = [];
  for (const runs of Object.values(repeatedRunsByFixture)) {
    if (Array.isArray(runs) && runs.length >= 2) {
      variances.push(variance(runs));
    }
  }
  if (variances.length === 0) {
    return { meanVariance: null, stdDev: null, fixturesWithRepetition: 0 };
  }
  const meanVariance = mean(variances);
  return {
    meanVariance,
    stdDev: Math.sqrt(meanVariance),
    fixturesWithRepetition: variances.length,
  };
}

/**
 * Classify a comparison. Never auto-declares a winner (spec section 18):
 *   - n < MIN_N_FOR_DECISION_GRADE                     -> NOT_DECISION_GRADE
 *   - CI crosses zero                                  -> NOT_SIGNIFICANT
 *   - |mean delta| <= noiseFloor.stdDev (when known)    -> WITHIN_NOISE
 *   - otherwise, CI excludes zero and n is sufficient   -> DECISION_GRADE
 */
function classifyComparison(ci, noiseFloor) {
  if (ci.n === 0) {
    return { status: 'NOT_SIGNIFICANT', reason: 'no_paired_fixtures' };
  }
  if (ci.n < MIN_N_FOR_DECISION_GRADE) {
    return { status: 'NOT_DECISION_GRADE', reason: `n=${ci.n} below minimum ${MIN_N_FOR_DECISION_GRADE}` };
  }
  const crossesZero = ci.lower <= 0 && ci.upper >= 0;
  if (crossesZero) {
    return { status: 'NOT_SIGNIFICANT', reason: 'confidence_interval_crosses_zero' };
  }
  if (noiseFloor && typeof noiseFloor.stdDev === 'number' && Math.abs(ci.mean) <= noiseFloor.stdDev) {
    return { status: 'WITHIN_NOISE', reason: 'mean_delta_within_measured_noise_floor' };
  }
  return { status: 'DECISION_GRADE', reason: 'ci_excludes_zero_and_n_sufficient' };
}

/**
 * Full comparison report for two named score maps (fixtureId -> score in
 * [0,1], typically a substitute-rollup or identity-indicator score).
 */
function compareScoreMaps(baselineByFixture, candidateByFixture, opts = {}) {
  const deltas = pairedDeltas(baselineByFixture, candidateByFixture);
  const deltaValues = deltas.map((d) => d.delta);
  const ci = bootstrapMeanCI(deltaValues, opts);
  const noiseFloor = opts.repeatedRunsByFixture
    ? estimateNoiseFloor(opts.repeatedRunsByFixture)
    : { meanVariance: null, stdDev: null, fixturesWithRepetition: 0 };
  const { status, reason } = classifyComparison(ci, noiseFloor);

  return {
    sampleCount: ci.n,
    meanDelta: ci.mean,
    confidenceInterval: { lower: ci.lower, upper: ci.upper },
    noiseFloor,
    status,
    reason,
    perFixtureDeltas: deltas,
  };
}

module.exports = {
  STATUSES,
  MIN_N_FOR_DECISION_GRADE,
  mean,
  variance,
  pairedDeltas,
  bootstrapMeanCI,
  estimateNoiseFloor,
  classifyComparison,
  compareScoreMaps,
};
