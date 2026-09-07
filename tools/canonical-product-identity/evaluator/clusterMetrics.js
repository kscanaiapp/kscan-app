'use strict';

/**
 * Cluster-level metrics (spec section 24: CLUSTER PURITY, CLUSTER
 * COMPLETENESS; Addendum A.4: VARIANT-SEPARATION ACCURACY). These require
 * the produced clusters (resolver/cluster.js), not just pairwise decisions -
 * a pairwise metric cannot tell you whether A and C ended up correctly
 * separated when only A-B and B-C were directly evaluated as AUTO_MERGE.
 */

const { clusterOffers } = require('../resolver/cluster');
const { buildGroundTruthIndex } = require('../corpus/groundTruth');

/**
 * Standard purity/completeness over a partition-vs-partition comparison.
 * `trueLabelOf(offerId)` and `producedClusterOf(offerId)` must both be
 * total functions over `offerIds` (every offer belongs to exactly one true
 * label and exactly one produced cluster - singletons count as clusters).
 */
function purityAndCompleteness(offerIds, trueLabelOf, producedClusterOf) {
  const n = offerIds.length;
  if (n === 0) return { purity: null, completeness: null };

  const byProducedCluster = new Map();
  const byTrueLabel = new Map();
  for (const id of offerIds) {
    const cluster = producedClusterOf(id);
    const trueLabel = trueLabelOf(id);
    if (!byProducedCluster.has(cluster)) byProducedCluster.set(cluster, []);
    byProducedCluster.get(cluster).push(trueLabel);
    if (!byTrueLabel.has(trueLabel)) byTrueLabel.set(trueLabel, []);
    byTrueLabel.get(trueLabel).push(cluster);
  }

  function majorityShareSum(groups) {
    let sum = 0;
    for (const labels of groups.values()) {
      const counts = new Map();
      for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
      sum += Math.max(...counts.values());
    }
    return sum;
  }

  const purity = majorityShareSum(byProducedCluster) / n;
  const completeness = majorityShareSum(byTrueLabel) / n;
  return { purity, completeness };
}

/**
 * Full cluster evaluation: builds variant + style clusters from the
 * already-computed pairwiseResults, then scores them against the
 * generator-known graph.
 */
function evaluateClusters(corpus, pairwiseResults) {
  const { offerToVariant } = buildGroundTruthIndex(corpus);
  const offerIds = corpus.offers.map((o) => o.offerId);

  const { variantClusters, variantRejectedEdges, styleClusters, styleRejectedEdges } = clusterOffers(corpus.offers, pairwiseResults);

  const variantClusterOf = new Map();
  for (const c of variantClusters) for (const id of c.offerIds) variantClusterOf.set(id, c.clusterId);
  const styleClusterOf = new Map();
  for (const c of styleClusters) for (const id of c.offerIds) styleClusterOf.set(id, c.clusterId);

  const trueVariantOf = (id) => offerToVariant.get(id)?.variantId ?? `NO_GRAPH_MEMBERSHIP:${id}`;
  const trueStyleOf = (id) => offerToVariant.get(id)?.styleId ?? `NO_GRAPH_MEMBERSHIP:${id}`;

  const variantScore = purityAndCompleteness(offerIds, trueVariantOf, (id) => variantClusterOf.get(id));
  const styleScore = purityAndCompleteness(offerIds, trueStyleOf, (id) => styleClusterOf.get(id));

  // Addendum A.4 VARIANT-SEPARATION ACCURACY: SIBLING_VARIANT pairs must
  // land in different variant clusters AND the same style cluster.
  let siblingTotal = 0;
  let siblingCorrect = 0;
  const siblingFailures = [];
  for (const [idA, membershipA] of offerToVariant) {
    for (const [idB, membershipB] of offerToVariant) {
      if (idA >= idB) continue; // unordered pairs once
      if (membershipA.styleId !== membershipB.styleId) continue;
      if (membershipA.variantId === membershipB.variantId) continue;
      siblingTotal += 1;
      const sameVariantCluster = variantClusterOf.get(idA) === variantClusterOf.get(idB);
      const sameStyleCluster = styleClusterOf.get(idA) === styleClusterOf.get(idB);
      const correct = !sameVariantCluster && sameStyleCluster;
      if (correct) {
        siblingCorrect += 1;
      } else {
        siblingFailures.push({
          offerIdA: idA,
          offerIdB: idB,
          failureMode: sameVariantCluster ? 'MERGED_INTO_SAME_VARIANT' : 'SCATTERED_ACROSS_DIFFERENT_STYLES',
        });
      }
    }
  }

  return {
    variantClusterCount: variantClusters.length,
    styleClusterCount: styleClusters.length,
    variantRejectedEdgeCount: variantRejectedEdges.length,
    styleRejectedEdgeCount: styleRejectedEdges.length,
    variantClusterPurity: variantScore.purity,
    variantClusterCompleteness: variantScore.completeness,
    styleClusterPurity: styleScore.purity,
    styleClusterCompleteness: styleScore.completeness,
    variantSeparationAccuracy: siblingTotal > 0 ? siblingCorrect / siblingTotal : null,
    variantSeparationPairCount: siblingTotal,
    variantSeparationFailureCount: siblingFailures.length,
    variantSeparationFailures: siblingFailures.slice(0, 25), // cap - explainability sample, not a full dump
  };
}

module.exports = { evaluateClusters, purityAndCompleteness };
