'use strict';

/**
 * Quality no-harm check (spec section 28; Addendum A.3 decision memo
 * DM-007). PROXY MEASUREMENT using this lab's own generator-known ground
 * truth - NOT the Fashion Match Quality Lab's own identity/substitute
 * rubric output (FMQL's evaluator needs FMQL-shaped human-authored labels
 * this corpus does not have; see DM-007 for why fabricating them would be
 * dishonest measurement).
 *
 * IDENTITY QUALITY  - did canonicalization silently collapse two offers
 *                      that are truly DIFFERENT variants into the same
 *                      produced variant cluster, within a realistic
 *                      candidate window? (directly answerable: compare each
 *                      produced variant cluster's members' TRUE variantId)
 * SUBSTITUTE QUALITY - did canonicalization reduce the count of genuinely
 *                      distinct STYLE alternatives a customer could
 *                      discover in the window, versus how many true styles
 *                      are actually present?
 *
 * A strategy with zero identity harm but reduced substitute count is a
 * TRADEOFF, not a win (spec section 28's own framing) - reported as such,
 * never silently rounded up to SAFE.
 */

const { clusterOffers } = require('../resolver/cluster');
const { restrictPairwiseResults } = require('../evaluator/pairwiseEvaluation');
const { buildAllWindows, DEFAULT_K_SIZES } = require('../simulate/candidateEconomics');
const { buildGroundTruthIndex } = require('../corpus/groundTruth');

function evaluateWindowNoHarm(offers, pairwiseResults, offerToVariant) {
  const offerIds = offers.map((o) => o.offerId);
  const restricted = restrictPairwiseResults(pairwiseResults, offerIds);
  const { variantClusters } = clusterOffers(offers, restricted);

  // IDENTITY QUALITY: any produced variant cluster whose members span more
  // than one TRUE variantId is a silent identity collapse.
  let identityHarmClusters = 0;
  let identityHarmOfferCount = 0;
  for (const cluster of variantClusters) {
    const trueVariantIds = new Set(cluster.offerIds.map((id) => offerToVariant.get(id)?.variantId ?? `NO_GRAPH:${id}`));
    if (trueVariantIds.size > 1) {
      identityHarmClusters += 1;
      identityHarmOfferCount += cluster.offerIds.length;
    }
  }

  // SUBSTITUTE QUALITY: true distinct styles present in the window vs
  // distinct TRUE styles actually reachable as separately-clustered variant
  // groups. A canonicalization that (incorrectly) puts offers from two
  // different true styles into the same VARIANT cluster would also count
  // here (a variant-level collapse across styles is strictly worse than
  // within a style), so this is computed independent of, and in addition
  // to, the identity check above.
  const trueStyleIds = new Set(offers.map((o) => offerToVariant.get(o.offerId)?.styleId ?? `NO_GRAPH:${o.offerId}`));
  const producedClusterTrueStyles = variantClusters.map((cluster) => new Set(cluster.offerIds.map((id) => offerToVariant.get(id)?.styleId ?? `NO_GRAPH:${id}`)));
  // A style is "still discoverable" if at least one produced cluster is
  // PURE for that style (i.e. contains only that style's offers) - a style
  // buried only inside an impure cluster dominated by another style is not
  // reliably discoverable as its own alternative.
  const discoverableStyles = new Set();
  for (const styleSet of producedClusterTrueStyles) {
    if (styleSet.size === 1) discoverableStyles.add([...styleSet][0]);
  }
  const lostStyles = [...trueStyleIds].filter((s) => !discoverableStyles.has(s));

  return {
    windowSize: offers.length,
    identityQuality: {
      harmedClusterCount: identityHarmClusters,
      harmedOfferCount: identityHarmOfferCount,
      verdict: identityHarmClusters === 0 ? 'SAFE' : 'HARM',
    },
    substituteQuality: {
      trueStyleCount: trueStyleIds.size,
      discoverableStyleCount: discoverableStyles.size,
      lostStyleCount: lostStyles.length,
      verdict: lostStyles.length === 0 ? 'SAFE' : 'TRADEOFF',
    },
  };
}

function overallVerdict(identityVerdict, substituteVerdict) {
  if (identityVerdict === 'HARM') return 'HARM';
  if (substituteVerdict === 'TRADEOFF') return 'TRADEOFF';
  return 'SAFE';
}

function runQualityNoHarmCheck(corpus, { kSizes = DEFAULT_K_SIZES, pairwiseResults } = {}) {
  const { windows, globalPairwise } = buildAllWindows(corpus, { kSizes, pairwiseResults });
  const { offerToVariant } = buildGroundTruthIndex(corpus);

  const perWindow = windows.map((w) => ({
    category: w.category,
    ...evaluateWindowNoHarm(w.offers, globalPairwise, offerToVariant),
  }));

  const identityHarmWindows = perWindow.filter((w) => w.identityQuality.verdict === 'HARM');
  const substituteTradeoffWindows = perWindow.filter((w) => w.substituteQuality.verdict === 'TRADEOFF');

  return {
    kSizes,
    perWindow,
    summary: {
      windowsEvaluated: perWindow.length,
      identityHarmWindowCount: identityHarmWindows.length,
      substituteTradeoffWindowCount: substituteTradeoffWindows.length,
      overallVerdict: overallVerdict(identityHarmWindows.length > 0 ? 'HARM' : 'SAFE', substituteTradeoffWindows.length > 0 ? 'TRADEOFF' : 'SAFE'),
    },
    measurementBasis: 'PROXY MEASUREMENT (this lab\'s own generator-known ground truth) - NOT the Fashion Match Quality Lab\'s own identity/substitute rubric output (Addendum A.3 decision memo DM-007).',
  };
}

module.exports = { runQualityNoHarmCheck, evaluateWindowNoHarm };
