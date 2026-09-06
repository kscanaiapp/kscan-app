'use strict';

const { classifyPair } = require('../../duplicates/duplicateClassifier');

/**
 * LAB-ONLY experimental post-ranking filter (spec section 28). Never wired
 * into production.
 *
 * HYPOTHESIS: because production dedup is exact-id/exact-URL only (see
 * authority/pipelineMap.json DEDUPLICATION stage), a CONFIRMED_DUPLICATE or
 * LIKELY_DUPLICATE cross-retailer listing of the same garment can occupy a
 * second top-K slot that a genuinely distinct product could have used -
 * wasting a result slot without the shopper gaining any additional option
 * (spec section 6: "Are top results being wasted by duplicates?").
 * Suppressing all but the highest-scored member of each detected
 * CONFIRMED/LIKELY duplicate cluster should raise average substitute
 * diversity in the top-K without harming identity metrics (the surviving
 * member is always the best-scored one).
 */
function suppressDuplicates(rankedProducts) {
  const kept = [];
  for (const candidate of rankedProducts) {
    const duplicateOfKept = kept.find((k) => {
      const { classification } = classifyPair(k, candidate);
      return classification === 'CONFIRMED_DUPLICATE' || classification === 'LIKELY_DUPLICATE';
    });
    if (!duplicateOfKept) {
      kept.push(candidate);
    }
    // else: candidate is a lower-ranked duplicate of something already
    // kept (input is assumed pre-sorted by matchScore desc, matching L1's
    // rankRecommendedProducts contract) - drop it.
  }
  return kept;
}

module.exports = {
  id: 'duplicate-suppression-v1',
  hypothesis:
    'Suppressing all but the best-scored member of each detected duplicate cluster raises effective top-K diversity without harming identity metrics, because the highest-scored member of a cluster is always kept.',
  why:
    'Production deduplication (mergeProductCandidates) is exact-id/exact-URL only; a cross-retailer near-duplicate is invisible to it (spec section 20/21). This variant applies AFTER the real production ranking (L1), so it only changes which already-ranked results survive into the top-K, not how they were scored.',
  suppressDuplicates,
};
