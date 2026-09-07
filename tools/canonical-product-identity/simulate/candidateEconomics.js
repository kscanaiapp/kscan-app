'use strict';

/**
 * Candidate-set "slot economics" (Addendum A.3 decision memo DM-004). One
 * shared building block reused by:
 *   - evaluator dedup-waste metrics (spec section 24: WASTE@K, UNIQUE
 *     CANONICAL PRODUCTS@K, RETAILER-DIVERSITY DELTA)
 *   - the quality no-harm check (spec section 28)
 *   - the performance-placement simulation (spec section 29 candidate counts)
 *   - the display-policy + lost-option simulation (spec sections 31/32)
 *
 * Pools are derived DETERMINISTICALLY from the already-committed synthetic
 * corpus by grouping existing offers by category and sorting by offerId -
 * no new RNG, no second corpus framework (A.6 forbids that). This
 * deliberately mixes many unrelated case instances together, approximating
 * "everything a single category search could plausibly return" rather than
 * a modeled per-query distribution - disclosed wherever these numbers are
 * reported.
 */

const { clusterOffers } = require('../resolver/cluster');
const { evaluateAllPairs, restrictPairwiseResults } = require('../evaluator/pairwiseEvaluation');
const { buildGroundTruthIndex } = require('../corpus/groundTruth');
const { distinctRetailerCount, concentrationIndex } = require('../lib/retailerDiversity');

const DEFAULT_K_SIZES = [10, 20, 40];

function categoriesInCorpus(corpus) {
  const cats = new Set();
  for (const o of corpus.offers) cats.add(o.category || 'uncategorized');
  return [...cats].sort();
}

function buildCategoryPool(corpus, category) {
  return corpus.offers
    .filter((o) => (o.category || 'uncategorized') === category)
    .slice()
    .sort((a, b) => a.offerId.localeCompare(b.offerId));
}

/**
 * Production-equivalent exact dedup count (spec section 9/authority
 * sourceMap.json: production dedupes only by exact id, then exact
 * normalized-lowercased URL - no fuzzy brand/title/category matching).
 * Mirrored here with the offer fields this lab's fixtures actually carry:
 * an offer has no synthesized "id" the way a live provider response does,
 * so the key is exact-lowercased url (falling back to canonicalUrl), and
 * only the offerId itself (always unique per fixture) when neither exists.
 */
function productionExactDedupCount(offers) {
  const seen = new Set();
  let count = 0;
  for (const o of offers) {
    const key = (o.url || o.canonicalUrl || '').trim().toLowerCase() || `offerid:${o.offerId}`;
    if (!seen.has(key)) {
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

/** Distinct TRUE variant count among `offers`, per the generator's own graph (oracle upper bound). */
function oracleCanonicalCount(offers, offerToVariant) {
  const variantIds = new Set();
  for (const o of offers) {
    const membership = offerToVariant.get(o.offerId);
    variantIds.add(membership ? membership.variantId : `NO_GRAPH_MEMBERSHIP:${o.offerId}`);
  }
  return variantIds.size;
}

/**
 * Resolver-based variant clusters among `offers`, using ONLY AUTO_MERGE
 * edges restricted to this window (spec section 18 - clusters, not naive
 * pairwise counting).
 */
function resolverVariantClusters(offers, pairwiseResults) {
  const offerIds = offers.map((o) => o.offerId);
  const restricted = restrictPairwiseResults(pairwiseResults, offerIds);
  return clusterOffers(offers, restricted).variantClusters;
}

function resolverCanonicalCount(offers, pairwiseResults) {
  return resolverVariantClusters(offers, pairwiseResults).length;
}

/**
 * One representative offer per canonical cluster (lowest offerId - a
 * deterministic, retailer-blind tie-break; spec section 19 forbids picking
 * a canonical representative BECAUSE of which retailer it came from).
 */
function representativeOffersPerCluster(offers, clusters) {
  const byId = new Map(offers.map((o) => [o.offerId, o]));
  return clusters.map((c) => {
    const sortedIds = [...c.offerIds].sort();
    return byId.get(sortedIds[0]);
  });
}

/**
 * Evaluate one K-sized window (the first K offers of a category pool, in
 * deterministic order) for waste/unique-canonicals/retailer-diversity.
 */
function evaluateWindow(corpus, offers, pairwiseResults, offerToVariant) {
  const K = offers.length;
  const rawCount = productionExactDedupCount(offers);
  const clusters = resolverVariantClusters(offers, pairwiseResults);
  const canonicalCount = clusters.length;
  const oracleCount = oracleCanonicalCount(offers, offerToVariant);
  const representatives = representativeOffersPerCluster(offers, clusters);

  const concentrationRaw = concentrationIndex(offers);
  const concentrationCanonical = concentrationIndex(representatives);

  return {
    windowSize: K,
    rawCount,
    canonicalCount,
    oracleCount,
    wasteRaw: K > 0 ? (K - rawCount) / K : null,
    wasteCanonical: K > 0 ? (K - canonicalCount) / K : null,
    wasteOracle: K > 0 ? (K - oracleCount) / K : null,
    wasteDelta: K > 0 ? (K - rawCount) / K - (K - canonicalCount) / K : null,
    uniqueCanonicalProductsAtK: canonicalCount,
    retailerDiversity: {
      distinctRetailersInWindow: distinctRetailerCount(offers),
      distinctRetailersAmongCanonicalRepresentatives: distinctRetailerCount(representatives),
      concentrationIndexRaw: concentrationRaw,
      // Measured over ONE representative offer per canonical cluster. This
      // is NOT expected to show lower concentration than the raw list - by
      // construction, collapsing a multi-retailer duplicate cluster down to
      // a single representative can only reduce or hold steady the count of
      // distinct retailers actually shown, which mechanically raises (or
      // holds) the Herfindahl index versus measuring every raw listing. The
      // honest finding this surfaces: a naive "one card, one retailer link"
      // display policy trades away retailer visibility for de-duplication;
      // recovering that visibility (badge counts, multi-offer cards) is a
      // DISPLAY POLICY question, evaluated separately in simulate/displayPolicy.js
      // (spec section 31), not something the resolver/clustering layer can
      // fix on its own.
      concentrationIndexCanonical: concentrationCanonical,
      concentrationDelta: concentrationRaw !== null && concentrationCanonical !== null ? concentrationRaw - concentrationCanonical : null,
    },
  };
}

/**
 * Build all category-pool windows at every K in `kSizes` (capped to pool
 * size) and evaluate each. Reuses one global pairwise evaluation pass
 * across all categories/windows (computed once, restricted per-window).
 */
function buildAllWindows(corpus, { kSizes = DEFAULT_K_SIZES, pairwiseResults } = {}) {
  const globalPairwise = pairwiseResults || evaluateAllPairs(corpus);
  const { offerToVariant } = buildGroundTruthIndex(corpus);
  const categories = categoriesInCorpus(corpus);

  const windows = [];
  for (const category of categories) {
    const pool = buildCategoryPool(corpus, category);
    for (const K of kSizes) {
      if (K > pool.length) continue; // don't fabricate a window larger than the real pool
      const windowOffers = pool.slice(0, K);
      const evalResult = evaluateWindow(corpus, windowOffers, globalPairwise, offerToVariant);
      windows.push({ category, poolSize: pool.length, offers: windowOffers, ...evalResult });
    }
  }
  return { windows, globalPairwise };
}

module.exports = {
  DEFAULT_K_SIZES,
  categoriesInCorpus,
  buildCategoryPool,
  productionExactDedupCount,
  oracleCanonicalCount,
  resolverCanonicalCount,
  resolverVariantClusters,
  representativeOffersPerCluster,
  evaluateWindow,
  buildAllWindows,
};
