'use strict';

/**
 * Operating curve (spec section 26). The agent never chooses a production
 * threshold - this module sweeps the Tier 2 auto-merge threshold and
 * reports precision/recall/false-merge-rate/missed-merge-rate/abstention
 * volume at every point, so the owner can pick an operating point later.
 *
 * The default resolver configuration (tier2AutoMergeThreshold: Infinity)
 * is always included as the first sweep point, since it is what the
 * resolver ships with today (Tier 2 never auto-merges by default).
 */

const { evaluateAllPairs } = require('./pairwiseEvaluation');
const { computeSafetyMetrics } = require('./safetyMetrics');

// 0 and 1 are included as the extremes (merge everything Tier-2-eligible /
// merge nothing via Tier 2). Infinity is the shipped default. The rest
// samples the [0,1] heuristic-score range at a resolution fine enough to
// show where false merges start appearing.
const DEFAULT_SWEEP_THRESHOLDS = [
  Infinity, 1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0,
];

function sweepOperatingCurve(corpus, { thresholds = DEFAULT_SWEEP_THRESHOLDS } = {}) {
  return thresholds.map((tier2AutoMergeThreshold) => {
    const pairEvals = evaluateAllPairs(corpus, { operatingParameters: { tier2AutoMergeThreshold } });
    const metrics = computeSafetyMetrics(pairEvals);
    return {
      tier2AutoMergeThreshold: tier2AutoMergeThreshold === Infinity ? 'Infinity (shipped default - Tier 2 never auto-merges)' : tier2AutoMergeThreshold,
      autoMergePrecision: metrics.autoMergePrecision,
      autoMergeRecall: metrics.autoMergeRecall,
      falseMergeRate: metrics.falseMergeRate,
      falseMergeCount: metrics.falseMergeCount,
      missedMergeRate: metrics.missedMergeRate,
      abstentionRate: metrics.abstentionRate,
      reviewVolume: metrics.decisionCounts.PROPOSED_REVIEW,
      autoMergeVolume: metrics.decisionCounts.AUTO_MERGE,
      falseMergeGateStatus: metrics.falseMergeGateStatus,
    };
  });
}

/** First threshold (scanning from most conservative to least) at which any false merge appears. */
function firstUnsafeThreshold(curve) {
  // curve is ordered most-conservative (Infinity/1) -> least-conservative (0).
  const unsafe = curve.find((point) => point.falseMergeCount > 0);
  return unsafe ? unsafe.tier2AutoMergeThreshold : null;
}

module.exports = { sweepOperatingCurve, firstUnsafeThreshold, DEFAULT_SWEEP_THRESHOLDS };
