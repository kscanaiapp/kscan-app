'use strict';

/**
 * Combine Tier 1 (exact) + Tier 2 (structured) into one pairwise resolver
 * decision (spec sections 15-17; Addendum A.4 decision states: AUTO_MERGE /
 * PROPOSED_REVIEW / ABSTAIN / SEPARATE).
 *
 * Decision logic, in priority order:
 *   1. Any hard-negative evidence (Tier 1 identifier conflict, OR Tier 2
 *      brand/category/color/material/pattern/construction conflict) ->
 *      SEPARATE. Hard negatives always win - a high structured score can
 *      never overrule a conflict (section 17).
 *   2. Tier 1 has a validated positive match and no conflict -> AUTO_MERGE
 *      (tier: TIER1).
 *   3. Tier 2 is eligible (brand+category agree) and its heuristic score
 *      meets the configured tier2AutoMergeThreshold -> AUTO_MERGE (tier:
 *      TIER2). Disabled by default (threshold = Infinity, section 26).
 *   4. Tier 2 is eligible and has ANY positive supporting evidence -> PROPOSED_REVIEW.
 *   5. Otherwise -> ABSTAIN (section 7: "when unsure, ABSTAIN is correct").
 *
 * Every result records full explainability (section 16): decision,
 * resolution tier, positive/negative/missing evidence, normalization
 * version, resolver version. Tier 3 (fuzzy/visual) is not implemented in V1
 * - spec section 15 forbids assuming reusable visual embeddings exist, and
 * tools/fashion-match-quality/authority/pipelineMap.json#vectorEmbeddingStack
 * confirms none exist in production today (see authority/sourceMap.json).
 */

const { normalizeOffer } = require('./normalizeOffer');
const { tier1Exact } = require('./tier1Exact');
const { tier2Structured } = require('./tier2Structured');
const { RESOLVER_VERSION, NORMALIZATION_VERSION, DEFAULT_OPERATING_PARAMETERS } = require('./resolverVersion');

/**
 * Core decision logic over ALREADY-NORMALIZED offers. Split out from
 * resolvePair() so batch callers (evaluator/pairwiseEvaluation.js) can
 * normalize each offer exactly once instead of once per pair - normalizing
 * is the expensive part (Unicode/tokenization), the O(n^2) comparison work
 * itself is cheap field comparisons. resolvePair() below is the normal
 * single-pair entry point and is unaffected by this split.
 */
function resolveFromNormalized(normA, normB, offerIdA, offerIdB, operatingParameters = DEFAULT_OPERATING_PARAMETERS) {
  if (offerIdA === offerIdB) {
    throw new Error(`resolvePair called with identical offerId: ${offerIdA}`);
  }
  const tier2AutoMergeThreshold = operatingParameters.tier2AutoMergeThreshold ?? Infinity;

  const t1 = tier1Exact(normA, normB);
  const t2 = tier2Structured(normA, normB);

  const positiveEvidence = [...t1.positive.map((e) => `tier1:${e}`), ...t2.positive.map((e) => `tier2:${e}`)];
  const negativeEvidence = [...t1.negative.map((e) => `tier1:${e}`), ...t2.negative.map((e) => `tier2:${e}`)];
  const missingEvidence = [...t1.missing.map((e) => `tier1:${e}`), ...t2.missing.map((e) => `tier2:${e}`)];

  const hasHardNegative = t1.eligible === 'BLOCKED' || t2.negative.length > 0;

  let decision;
  let tier;
  if (hasHardNegative) {
    decision = 'SEPARATE';
    tier = t1.eligible === 'BLOCKED' ? 'TIER1' : 'TIER2';
  } else if (t1.eligible === 'AUTO_MERGE_ELIGIBLE') {
    decision = 'AUTO_MERGE';
    tier = 'TIER1';
  } else if (t2.styleEligible && t2.styleScore >= tier2AutoMergeThreshold) {
    decision = 'AUTO_MERGE';
    tier = 'TIER2';
  } else if (t2.styleEligible && t2.positive.length > 0) {
    decision = 'PROPOSED_REVIEW';
    tier = 'TIER2';
  } else {
    decision = 'ABSTAIN';
    tier = 'NONE';
  }

  return {
    offerIdA,
    offerIdB,
    decision,
    tier,
    positiveEvidence,
    negativeEvidence,
    missingEvidence,
    heuristicScore: t2.styleEligible ? Number(t2.styleScore.toFixed(4)) : null,
    heuristicScoreLabel: t2.styleEligible ? 'HEURISTIC SCORE - NOT CALIBRATED PROBABILITY' : null,
    variantAttributeConflict: t2.negative.some((n) => n === 'color_conflict' || n === 'material_conflict' || n === 'pattern_conflict'),
    operatingParameters: { tier2AutoMergeThreshold },
    normalizationVersion: NORMALIZATION_VERSION,
    resolverVersion: RESOLVER_VERSION,
  };
}

/** Normal single-pair entry point: normalizes both offers, then delegates to resolveFromNormalized. */
function resolvePair(offerA, offerB, operatingParameters = DEFAULT_OPERATING_PARAMETERS) {
  const normA = normalizeOffer(offerA);
  const normB = normalizeOffer(offerB);
  return resolveFromNormalized(normA, normB, offerA.offerId, offerB.offerId, operatingParameters);
}

module.exports = { resolvePair, resolveFromNormalized };
