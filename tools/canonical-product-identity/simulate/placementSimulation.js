'use strict';

/**
 * Performance placement simulation (spec section 29; Addendum A.1/BL-002:
 * PR #315's Curiosity Gap artifacts are not present at this lab's base, so
 * placement facts are DERIVED_FROM_SOURCE - read directly from the actual
 * scan-identify pipeline via tools/fashion-match-quality/authority/
 * pipelineMap.json (itself a direct source read, SHA 909df864) - rather
 * than reused from PR #315's own measured harness.
 *
 * Pipeline stage order in the traced synchronous scan response path
 * (pipelineMap.json, confirmed by source evidence in each stage entry):
 *   PRODUCT_RETAILER_RETRIEVAL
 *     -> CANDIDATE_NORMALIZATION (mergeProductCandidates: ALSO where
 *        production's own exact-id/exact-URL dedup already happens - one
 *        function does both)
 *     -> SCORING_RANKING (scoreRecommendedProduct/rankRecommendedProducts -
 *        pure, deterministic, zero-network weighted rubric)
 *     -> FINAL_RESULT_PAYLOAD / CLIENT_PRESENTATION (display)
 *
 * IMPORTANT, and disclosed honestly rather than assumed: unlike the
 * Curiosity Gap's finding that "full candidate processing and downstream
 * fan-in matter" (spec section 4) in a pipeline with expensive per-candidate
 * work, THIS pipeline's per-candidate cost after retrieval is already
 * cheap (pure functions, zero network - see pipelineMap.json
 * CANDIDATE_NORMALIZATION and SCORING_RANKING entries). COMMERCE_ENRICHMENT
 * is explicitly NOT part of the synchronous scan response path (async
 * refresh only). So canonicalization's placement benefit here is real but
 * modest: fewer candidates flow through cheap O(n) normalization/scoring
 * stages, not avoidance of an expensive per-candidate enrichment call -
 * there is no such call in the traced path to avoid. Any millisecond
 * figure below is MODELED (workAvoidedCount x an assumed per-candidate
 * cost), never presented as a measured production timing.
 */

const { aggregateDedupWasteMetrics } = require('../evaluator/dedupWasteMetrics');

const PIPELINE_EVIDENCE = {
  sourcePath: 'tools/fashion-match-quality/authority/pipelineMap.json (source SHA 909df8646a690b55c5af6b7b8c80193df64a2ec8), cross-checked against supabase/functions/_shared/catalogRetrieval.ts and supabase/functions/_shared/scanHelpers.ts',
  retrievalStage: 'PRODUCT_RETAILER_RETRIEVAL (shoppingProvider.ts callSerper/callBrave, catalogRetrieval.ts fetchCatalogCandidates)',
  normalizationAndProductionDedupStage: 'CANDIDATE_NORMALIZATION (catalogRetrieval.ts mergeProductCandidates - ALSO production\'s own exact-id/exact-URL dedup; one function, both concerns)',
  rankingStage: 'SCORING_RANKING (scanHelpers.ts scoreRecommendedProduct/rankRecommendedProducts - pure, deterministic, zero-network)',
  enrichmentNote: 'COMMERCE_ENRICHMENT (commerceOutcomeCapture.ts, commerce-watch-refresh/) is explicitly NOT part of the synchronous scan response path per pipelineMap.json - async telemetry/refresh only. There is no expensive per-candidate synchronous enrichment call in this pipeline today.',
};

/** Average rawCount/canonicalCount across the same candidate-economics windows the other sections already use, so P0/P1/P2 use one consistent set of numbers. */
function averageCandidateCounts(corpus, { pairwiseResults } = {}) {
  const { perWindow } = aggregateDedupWasteMetrics(corpus, { pairwiseResults });
  const avgRaw = perWindow.reduce((s, w) => s + w.rawCount, 0) / perWindow.length;
  const avgCanonical = perWindow.reduce((s, w) => s + w.canonicalCount, 0) / perWindow.length;
  return { avgRaw, avgCanonical, windowCount: perWindow.length };
}

// Illustrative, clearly-labeled MODELED per-candidate cost assumptions - not
// measured production timings (spec section 29: PROVEN/OBSERVED/MODELED).
const MODELED_PER_CANDIDATE_MS = {
  normalization: 0.05, // pure field-aliasing, sub-millisecond per item
  scoring: 0.1, // pure weighted-sum rubric, sub-millisecond per item
};

function simulatePlacements(corpus, { pairwiseResults } = {}) {
  const { avgRaw, avgCanonical, windowCount } = averageCandidateCounts(corpus, { pairwiseResults });
  const candidatesAvoided = Math.max(0, avgRaw - avgCanonical);

  return {
    evidence: PIPELINE_EVIDENCE,
    evidenceClass: 'DERIVED_FROM_SOURCE (Addendum A.1 - PR #315 artifacts absent from this base)',
    candidateCountBasis: { averageRawCandidatesPerWindow: Number(avgRaw.toFixed(1)), averageCanonicalCandidatesPerWindow: Number(avgCanonical.toFixed(1)), windowsAveraged: windowCount },
    placements: {
      P0_POST_RETRIEVAL_PRE_ENRICHMENT: {
        description: 'Canonicalize immediately after PRODUCT_RETAILER_RETRIEVAL, before CANDIDATE_NORMALIZATION and SCORING_RANKING both run.',
        candidateCountEnteringNormalization: { withoutCanonicalization: Number(avgRaw.toFixed(1)), withCanonicalization: Number(avgCanonical.toFixed(1)) },
        candidateCountEnteringRanking: { withoutCanonicalization: Number(avgRaw.toFixed(1)), withCanonicalization: Number(avgCanonical.toFixed(1)) },
        duplicateWorkAvoided: { normalizationCallsAvoided: Number(candidatesAvoided.toFixed(1)), scoringCallsAvoided: Number(candidatesAvoided.toFixed(1)) },
        modeledMsAvoided: Number((candidatesAvoided * (MODELED_PER_CANDIDATE_MS.normalization + MODELED_PER_CANDIDATE_MS.scoring)).toFixed(2)),
        timingClass: 'MODELED',
      },
      P1_POST_ENRICHMENT_PRE_RANKING: {
        description: 'Canonicalize after CANDIDATE_NORMALIZATION (which already includes production\'s own exact-id/URL dedup) but before SCORING_RANKING.',
        candidateCountEnteringRanking: { withoutCanonicalization: Number(avgRaw.toFixed(1)), withCanonicalization: Number(avgCanonical.toFixed(1)) },
        duplicateWorkAvoided: { scoringCallsAvoided: Number(candidatesAvoided.toFixed(1)) },
        modeledMsAvoided: Number((candidatesAvoided * MODELED_PER_CANDIDATE_MS.scoring).toFixed(2)),
        timingClass: 'MODELED',
        note: 'Production\'s own exact-dedup (mergeProductCandidates) essentially never fires on this lab\'s corpus (wasteRaw ~= 0 in evaluator/dedupWasteMetrics.js) - so avgRaw here is a close proxy for what actually reaches ranking in production today, not an inflated raw count.',
      },
      P2_POST_RANKING_PRE_DISPLAY: {
        description: 'Canonicalize only at FINAL_RESULT_PAYLOAD/display-grouping time, after SCORING_RANKING has already run on the full candidate list.',
        candidateCountEnteringDisplay: { withoutCanonicalization: Number(avgRaw.toFixed(1)), withCanonicalization: Number(avgCanonical.toFixed(1)) },
        duplicateWorkAvoided: { normalizationCallsAvoided: 0, scoringCallsAvoided: 0 },
        modeledMsAvoided: 0,
        timingClass: 'MODELED (zero upstream compute avoided by construction - this placement is purely a DISPLAY-GROUPING concern, see simulate/displayPolicy.js)',
      },
    },
    resolverProcessingCostNote: 'The resolver\'s OWN processing cost at any placement is OBSERVED (not modeled) - see simulate/resolverPerformance.js P50/P95 at realistic candidate-set sizes.',
  };
}

module.exports = { simulatePlacements, PIPELINE_EVIDENCE, MODELED_PER_CANDIDATE_MS };
