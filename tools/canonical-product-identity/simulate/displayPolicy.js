'use strict';

/**
 * Display-policy simulation + lost-option analysis (spec sections 31-32).
 * The resolver determines IDENTITY (clusters); it does not decide how a
 * customer interface should collapse results. This module only SIMULATES
 * four candidate display strategies against the resolver's own cluster
 * output, purely for reporting - nothing here is wired into any UI.
 *
 * D1 - one card / best offer            (lowest price, deterministic tie-break)
 * D2 - one card / retailer count        (same visible primary as D1, but the
 *                                         other offers are disclosed via a
 *                                         count badge - "indirectly visible")
 * D3 - one card / top two offers        (best 2 offers by price are directly visible)
 * D4 - style card / grouped variants    (groups at the STYLE cluster level;
 *                                         every VARIANT's own D1 representative
 *                                         is directly visible as a selector row)
 *
 * Lost-option analysis (section 32) is mandatory: false merges can otherwise
 * be invisible. For each policy we report which underlying offers are no
 * longer DIRECTLY reachable, since a customer who never sees an offer can
 * never choose it - independent of whether the merge itself was correct.
 */

const { clusterOffers } = require('../resolver/cluster');
const { restrictPairwiseResults } = require('../evaluator/pairwiseEvaluation');
const { buildCategoryPool, buildAllWindows, DEFAULT_K_SIZES } = require('./candidateEconomics');

function sortByPriceThenId(offers) {
  return [...offers].sort((a, b) => {
    const pa = typeof a.price === 'number' ? a.price : Infinity;
    const pb = typeof b.price === 'number' ? b.price : Infinity;
    if (pa !== pb) return pa - pb;
    return a.offerId.localeCompare(b.offerId);
  });
}

function byId(offers) {
  return new Map(offers.map((o) => [o.offerId, o]));
}

/** D1/D2 share the same visible-offer set (one primary per variant cluster); they differ only in whether the count is disclosed. */
function simulateD1D2(offers, variantClusters) {
  const idMap = byId(offers);
  const directlyVisible = new Set();
  const indirectlyVisible = new Set(); // disclosed via a count badge (D2), invisible without any affordance (D1)
  for (const cluster of variantClusters) {
    const members = cluster.offerIds.map((id) => idMap.get(id)).filter(Boolean);
    const sorted = sortByPriceThenId(members);
    directlyVisible.add(sorted[0].offerId);
    for (const m of sorted.slice(1)) indirectlyVisible.add(m.offerId);
  }
  return { directlyVisible, indirectlyVisible, cardCount: variantClusters.length };
}

function simulateD3(offers, variantClusters) {
  const idMap = byId(offers);
  const directlyVisible = new Set();
  const lost = new Set();
  for (const cluster of variantClusters) {
    const members = cluster.offerIds.map((id) => idMap.get(id)).filter(Boolean);
    const sorted = sortByPriceThenId(members);
    sorted.slice(0, 2).forEach((m) => directlyVisible.add(m.offerId));
    sorted.slice(2).forEach((m) => lost.add(m.offerId));
  }
  return { directlyVisible, lost, cardCount: variantClusters.length };
}

/** D4: group at STYLE level; every variant within a style contributes its own D1 representative as a visible selector row. */
function simulateD4(offers, variantClusters, styleClusters) {
  const idMap = byId(offers);
  const variantClusterOf = new Map();
  for (const c of variantClusters) for (const id of c.offerIds) variantClusterOf.set(id, c.clusterId);

  // Which variant clusters fall under each style cluster.
  const variantsByStyle = new Map();
  for (const styleCluster of styleClusters) {
    const variantIdsInStyle = new Set(styleCluster.offerIds.map((id) => variantClusterOf.get(id)));
    variantsByStyle.set(styleCluster.clusterId, variantIdsInStyle);
  }

  const directlyVisible = new Set();
  const lost = new Set();
  const variantClusterById = new Map(variantClusters.map((c) => [c.clusterId, c]));
  for (const [, variantIds] of variantsByStyle) {
    for (const variantClusterId of variantIds) {
      const cluster = variantClusterById.get(variantClusterId);
      if (!cluster) continue;
      const members = cluster.offerIds.map((id) => idMap.get(id)).filter(Boolean);
      const sorted = sortByPriceThenId(members);
      directlyVisible.add(sorted[0].offerId);
      sorted.slice(1).forEach((m) => lost.add(m.offerId));
    }
  }
  return { directlyVisible, lost, styleCardCount: styleClusters.length, variantSelectorCount: variantClusters.length };
}

/**
 * Simulate all four display policies for one window (a category pool
 * capped to a raw K, per candidateEconomics.js). Returns per-policy
 * unique-products-visible / retailer-choice / lost-options / duplicate-card-reduction.
 */
function simulateWindowDisplayPolicies(offers, pairwiseResults) {
  const offerIds = offers.map((o) => o.offerId);
  const restricted = restrictPairwiseResults(pairwiseResults, offerIds);
  const { variantClusters, styleClusters } = clusterOffers(offers, restricted);
  const K = offers.length;

  const d1d2 = simulateD1D2(offers, variantClusters);
  const d3 = simulateD3(offers, variantClusters);
  const d4 = simulateD4(offers, variantClusters, styleClusters);

  function retailersOf(idSet) {
    return new Set([...idSet].map((id) => (byId(offers).get(id)?.retailer || 'unknown').toLowerCase())).size;
  }

  return {
    windowSize: K,
    D1_ONE_CARD_BEST_OFFER: {
      uniqueProductsVisible: d1d2.cardCount,
      retailerChoice: retailersOf(d1d2.directlyVisible),
      lostOptionsCount: d1d2.indirectlyVisible.size, // fully invisible - no count affordance at all
      duplicateCardReductionRate: K > 0 ? (K - d1d2.cardCount) / K : null,
    },
    D2_ONE_CARD_RETAILER_COUNT: {
      uniqueProductsVisible: d1d2.cardCount,
      retailerChoice: retailersOf(d1d2.directlyVisible),
      // Same underlying set as D1, but disclosed via a count badge rather
      // than hidden outright - reported as "indirectly visible", not "lost",
      // since the customer at least knows the alternates exist.
      indirectlyVisibleCount: d1d2.indirectlyVisible.size,
      lostOptionsCount: 0,
      duplicateCardReductionRate: K > 0 ? (K - d1d2.cardCount) / K : null,
    },
    D3_ONE_CARD_TOP_TWO_OFFERS: {
      uniqueProductsVisible: d3.cardCount,
      retailerChoice: retailersOf(d3.directlyVisible),
      lostOptionsCount: d3.lost.size,
      duplicateCardReductionRate: K > 0 ? (K - d3.cardCount) / K : null,
    },
    D4_STYLE_CARD_GROUPED_VARIANTS: {
      uniqueProductsVisible: d4.styleCardCount,
      variantSelectorsVisible: d4.variantSelectorCount,
      retailerChoice: retailersOf(d4.directlyVisible),
      // Only the non-primary OFFER within an already-visible variant selector
      // is "lost" here - every variant itself remains reachable, which is
      // D4's whole point. The real D4 risk is a false STYLE merge burying a
      // genuinely distinct product inside another product's variant
      // selector - reported separately below as a purity-derived risk, not
      // as a lost OFFER.
      lostOptionsCount: d4.lost.size,
      duplicateCardReductionRate: K > 0 ? (K - d4.styleCardCount) / K : null,
    },
  };
}

/**
 * Aggregate display-policy simulation across all category-pool windows
 * (reusing candidateEconomics.js's deterministic pools), plus a corpus-wide
 * D4-specific false-style-merge risk check (spec section 32: false merges
 * can otherwise be invisible - this is the one risk lost-option counts
 * alone would not surface, since a false style merge doesn't "lose" an
 * offer, it mislabels which product a variant selector belongs to).
 */
function simulateDisplayPolicies(corpus, { kSizes = DEFAULT_K_SIZES, pairwiseResults, clusterEvaluation } = {}) {
  const { windows, globalPairwise } = buildAllWindows(corpus, { kSizes, pairwiseResults });
  const perWindow = windows.map((w) => ({
    category: w.category,
    ...simulateWindowDisplayPolicies(w.offers, globalPairwise),
  }));

  return {
    kSizes,
    perWindow,
    d4FalseStyleMergeRisk: clusterEvaluation
      ? {
        styleClusterPurity: clusterEvaluation.styleClusterPurity,
        note: 'D4 groups by STYLE cluster; styleClusterPurity < 1.0 means at least one produced style card contains offers from more than one true style (Addendum A.3 decision memo DM-006 - largely a corpus-vocabulary artifact here, but the mechanism is real: a false style merge would surface exactly like this, hiding a genuinely distinct product inside another product\'s color/material selector rather than as its own card).',
      }
      : null,
  };
}

module.exports = { simulateWindowDisplayPolicies, simulateDisplayPolicies };
