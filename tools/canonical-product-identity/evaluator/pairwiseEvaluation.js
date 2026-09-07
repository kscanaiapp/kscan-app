'use strict';

/**
 * Run the resolver over every pair of offers in a corpus and attach the
 * generator-known ground truth to each result (Addendum A.4). This is the
 * single source of pairwise evidence every other evaluator/simulate module
 * builds on - nothing here re-derives ground truth or re-runs the resolver
 * with different logic.
 *
 * The resolver itself never sees `groundTruthForPair` output - it is only
 * ever consulted here, after resolvePair has already produced a decision
 * from `corpus.offers` alone, exactly like a production caller would.
 */

const { resolveFromNormalized } = require('../resolver/resolvePair');
const { normalizeOffer } = require('../resolver/normalizeOffer');
const { buildGroundTruthIndex } = require('../corpus/groundTruth');
const { DEFAULT_OPERATING_PARAMETERS } = require('../resolver/resolverVersion');

/**
 * Evaluate all C(n,2) pairs among `offers` (default: the full corpus).
 * Returns an array of { ...resolvePair result, groundTruthLabel, groundTruthReason, groundTruthSource }.
 *
 * Normalizes each offer exactly once (not once per pair) via
 * resolveFromNormalized - identical decisions to calling resolvePair() on
 * every pair, just without O(n) redundant re-normalization of the same
 * offer for every comparison it participates in.
 */
function evaluateAllPairs(corpus, { offers = corpus.offers, operatingParameters = DEFAULT_OPERATING_PARAMETERS } = {}) {
  const { groundTruthForPair } = buildGroundTruthIndex(corpus);
  const normalized = offers.map((o) => normalizeOffer(o));
  const results = [];
  for (let i = 0; i < offers.length; i += 1) {
    for (let j = i + 1; j < offers.length; j += 1) {
      const a = offers[i];
      const b = offers[j];
      const decision = resolveFromNormalized(normalized[i], normalized[j], a.offerId, b.offerId, operatingParameters);
      const gt = groundTruthForPair(a.offerId, b.offerId);
      results.push({
        ...decision,
        groundTruthLabel: gt.label,
        groundTruthReason: gt.reason,
        groundTruthSource: gt.source,
      });
    }
  }
  return results;
}

/** Restrict an already-computed global pairwise result set to pairs where both offers are in `offerIds`. */
function restrictPairwiseResults(pairwiseResults, offerIds) {
  const idSet = offerIds instanceof Set ? offerIds : new Set(offerIds);
  return pairwiseResults.filter((r) => idSet.has(r.offerIdA) && idSet.has(r.offerIdB));
}

module.exports = { evaluateAllPairs, restrictPairwiseResults };
