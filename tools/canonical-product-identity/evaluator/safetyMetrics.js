'use strict';

/**
 * Primary metrics (spec section 24; Addendum A.4 metric definitions over the
 * ground-truth x decision cross). This module is pure aggregation over an
 * already-computed pairwise evaluation array - it never calls the resolver
 * itself, so scoring logic and resolver logic can be reasoned about and
 * tested independently.
 *
 * FALSE-MERGE RATE is the spec section 25 promotion safety gate: any
 * configuration with falseMergeCount > 0 is NOT_PROMOTABLE for that
 * corpus/configuration, full stop, regardless of how good every other
 * number looks.
 */

const { GROUND_TRUTH_LABELS, RESOLVER_DECISIONS } = require('../schema/identitySchema');

// A.4: "FALSE-MERGE RATE - auto-merged pairs whose ground truth is
// UNDECIDABLE, NEAR_DUPLICATE_DISTINCT, or DISTINCT - each violates the
// section 25 gate." SIBLING_VARIANT is deliberately excluded here - an
// auto-merged sibling-variant pair is a VARIANT-SEPARATION failure, a
// distinct and separately-reported failure mode, not a false-merge-gate
// violation (A.4's own metric list keeps the two concepts apart).
const FALSE_MERGE_GROUND_TRUTHS = ['UNDECIDABLE', 'NEAR_DUPLICATE_DISTINCT', 'DISTINCT'];

function buildConfusionMatrix(pairEvals) {
  const matrix = {};
  for (const gt of GROUND_TRUTH_LABELS) {
    matrix[gt] = {};
    for (const d of RESOLVER_DECISIONS) matrix[gt][d] = 0;
  }
  for (const r of pairEvals) {
    if (!matrix[r.groundTruthLabel]) continue; // defensive; every label in REGISTRY is a known GROUND_TRUTH_LABELS member
    matrix[r.groundTruthLabel][r.decision] += 1;
  }
  return matrix;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** Core safety metrics (spec section 24 + Addendum A.4). */
function computeSafetyMetrics(pairEvals) {
  const totalPairs = pairEvals.length;
  const autoMerged = pairEvals.filter((r) => r.decision === 'AUTO_MERGE');
  const proposedReview = pairEvals.filter((r) => r.decision === 'PROPOSED_REVIEW');
  const abstained = pairEvals.filter((r) => r.decision === 'ABSTAIN');
  const separated = pairEvals.filter((r) => r.decision === 'SEPARATE');

  const sameVariantPairs = pairEvals.filter((r) => r.groundTruthLabel === 'SAME_VARIANT');
  const siblingVariantPairs = pairEvals.filter((r) => r.groundTruthLabel === 'SIBLING_VARIANT');
  const undecidablePairs = pairEvals.filter((r) => r.groundTruthLabel === 'UNDECIDABLE');

  const autoMergeSameVariant = autoMerged.filter((r) => r.groundTruthLabel === 'SAME_VARIANT');
  const falseMerges = autoMerged.filter((r) => FALSE_MERGE_GROUND_TRUTHS.includes(r.groundTruthLabel));
  const siblingAutoMerged = siblingVariantPairs.filter((r) => r.decision === 'AUTO_MERGE');
  const missedMerges = sameVariantPairs.filter((r) => r.decision !== 'AUTO_MERGE');
  const abstainedUndecidable = undecidablePairs.filter((r) => r.decision === 'ABSTAIN');

  const autoMergePrecision = ratio(autoMergeSameVariant.length, autoMerged.length);
  const autoMergeRecall = ratio(autoMergeSameVariant.length, sameVariantPairs.length);
  // falseMergeRate is expressed against auto-merge volume (of everything we
  // merged, what fraction was wrong) - the section 25 gate cares about this
  // being exactly zero, not about its size relative to the whole corpus.
  const falseMergeRate = ratio(falseMerges.length, autoMerged.length) ?? 0;

  const f1 = autoMergePrecision !== null && autoMergeRecall !== null && (autoMergePrecision + autoMergeRecall) > 0
    ? (2 * autoMergePrecision * autoMergeRecall) / (autoMergePrecision + autoMergeRecall)
    : null;

  return {
    totalPairsEvaluated: totalPairs,
    decisionCounts: {
      AUTO_MERGE: autoMerged.length,
      PROPOSED_REVIEW: proposedReview.length,
      ABSTAIN: abstained.length,
      SEPARATE: separated.length,
    },
    autoMergePrecision,
    autoMergeRecall,
    falseMergeCount: falseMerges.length,
    falseMergeRate,
    falseMergeGateStatus: falseMerges.length === 0
      ? 'PASS - zero false merges (section 25 gate satisfied for this corpus/configuration)'
      : `FAIL - ${falseMerges.length} false merge(s) - NOT_PROMOTABLE for this corpus/configuration (section 25)`,
    missedMergeCount: missedMerges.length,
    missedMergeRate: ratio(missedMerges.length, sameVariantPairs.length),
    abstentionRate: ratio(abstained.length, totalPairs),
    undecidablePairCount: undecidablePairs.length,
    abstentionCorrectness: ratio(abstainedUndecidable.length, undecidablePairs.length),
    sameVariantPairCount: sameVariantPairs.length,
    siblingVariantPairCount: siblingVariantPairs.length,
    siblingVariantAutoMergedCount: siblingAutoMerged.length,
    f1Secondary: f1,
    f1Note: 'F1 reported secondarily only (section 24) - never a substitute for precision/recall/false-merge-rate.',
    confusionMatrix: buildConfusionMatrix(pairEvals),
  };
}

module.exports = { computeSafetyMetrics, buildConfusionMatrix, FALSE_MERGE_GROUND_TRUTHS };
