'use strict';

/**
 * Incumbent comparison (spec section 27). "Use the existing Match Quality
 * duplicate machinery as the incumbent" - tools/fashion-match-quality/
 * duplicates/duplicateClassifier.js, run unmodified on this lab's own
 * corpus via a pure field-mapping adapter (Addendum A.3 DM-003). Neither
 * FMQL nor its classifier is touched by this file.
 *
 * FMQL's classifier has no "auto-merge" concept of its own - it is a
 * measurement tool, not a merge decision engine. To compare like-for-like
 * against this lab's AUTO_MERGE/PROPOSED_REVIEW/ABSTAIN/SEPARATE decision
 * vocabulary (Addendum A.4), its four classification labels are mapped to
 * the closest equivalent decision by confidence:
 *   CONFIRMED_DUPLICATE -> AUTO_MERGE      (incumbent's highest-confidence bucket)
 *   LIKELY_DUPLICATE     -> PROPOSED_REVIEW
 *   DISTINCT_VARIANT     -> SEPARATE
 *   UNKNOWN               -> ABSTAIN
 * This mapping is the ONLY new logic here; classifyPair itself is called
 * unmodified, so any resulting "better/equal/worse" verdict reflects
 * FMQL's actual classifier, not a strawman.
 */

const { classifyPair } = require('../../fashion-match-quality/duplicates/duplicateClassifier');
const { offerToFmqlProduct } = require('./offerToFmqlProduct');
const { buildGroundTruthIndex } = require('../corpus/groundTruth');
const { computeSafetyMetrics } = require('../evaluator/safetyMetrics');
const { evaluateAllPairs } = require('../evaluator/pairwiseEvaluation');

const INCUMBENT_DECISION_MAP = {
  CONFIRMED_DUPLICATE: 'AUTO_MERGE',
  LIKELY_DUPLICATE: 'PROPOSED_REVIEW',
  DISTINCT_VARIANT: 'SEPARATE',
  UNKNOWN: 'ABSTAIN',
};

function evaluateIncumbentAllPairs(corpus, { offers = corpus.offers } = {}) {
  const { groundTruthForPair } = buildGroundTruthIndex(corpus);
  const fmqlProducts = offers.map((o) => offerToFmqlProduct(o));
  const results = [];
  for (let i = 0; i < offers.length; i += 1) {
    for (let j = i + 1; j < offers.length; j += 1) {
      const { classification } = classifyPair(fmqlProducts[i], fmqlProducts[j]);
      const decision = INCUMBENT_DECISION_MAP[classification] || 'ABSTAIN';
      const gt = groundTruthForPair(offers[i].offerId, offers[j].offerId);
      results.push({
        offerIdA: offers[i].offerId,
        offerIdB: offers[j].offerId,
        incumbentClassification: classification,
        decision,
        groundTruthLabel: gt.label,
      });
    }
  }
  return results;
}

function verdict(resolverValue, incumbentValue, { higherIsBetter = true, epsilon = 1e-9 } = {}) {
  if (resolverValue === null || incumbentValue === null) return 'N/A';
  const diff = resolverValue - incumbentValue;
  if (Math.abs(diff) < epsilon) return 'EQUAL';
  const resolverWins = higherIsBetter ? diff > 0 : diff < 0;
  return resolverWins ? 'RESOLVER_BETTER' : 'INCUMBENT_BETTER';
}

/**
 * Run both systems on the identical corpus and report better/equal/worse
 * by metric (spec section 27) - never rewrites or alters FMQL to make the
 * comparison favorable (both classifiers run through their own unmodified code).
 */
function compareAgainstIncumbent(corpus, { resolverPairEvals } = {}) {
  const incumbentPairEvals = evaluateIncumbentAllPairs(corpus);
  const resolverMetrics = resolverPairEvals || evaluateAllPairs(corpus);
  const resolverSafety = computeSafetyMetrics(resolverMetrics);
  const incumbentSafety = computeSafetyMetrics(incumbentPairEvals);

  const byMetric = {
    autoMergePrecision: verdict(resolverSafety.autoMergePrecision, incumbentSafety.autoMergePrecision, { higherIsBetter: true }),
    autoMergeRecall: verdict(resolverSafety.autoMergeRecall, incumbentSafety.autoMergeRecall, { higherIsBetter: true }),
    falseMergeRate: verdict(resolverSafety.falseMergeRate, incumbentSafety.falseMergeRate, { higherIsBetter: false }),
    missedMergeRate: verdict(resolverSafety.missedMergeRate, incumbentSafety.missedMergeRate, { higherIsBetter: false }),
    abstentionRate: verdict(resolverSafety.abstentionRate, incumbentSafety.abstentionRate, { higherIsBetter: false }),
  };

  return {
    resolverSafety,
    incumbentSafety,
    byMetric,
    decisionMap: INCUMBENT_DECISION_MAP,
    note: "Incumbent = tools/fashion-match-quality/duplicates/duplicateClassifier.js, called unmodified via a pure field-mapping adapter (compare/offerToFmqlProduct.js). FMQL's classifier is a MEASUREMENT tool with no auto-merge concept of its own - its CONFIRMED_DUPLICATE bucket is mapped to AUTO_MERGE only for this comparison's purposes, which is more permissive than how FMQL itself is actually used in production measurement. This makes the comparison conservative FOR the incumbent (best-case reading of its output), not against it.",
  };
}

module.exports = { evaluateIncumbentAllPairs, compareAgainstIncumbent, INCUMBENT_DECISION_MAP, verdict };
