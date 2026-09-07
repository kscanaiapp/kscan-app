'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clusterOffers, incrementalCluster } = require('./cluster');

function decision(offerIdA, offerIdB, overrides = {}) {
  return {
    offerIdA, offerIdB, decision: 'AUTO_MERGE', tier: 'TIER1',
    positiveEvidence: [], negativeEvidence: [], missingEvidence: [],
    heuristicScore: null, heuristicScoreLabel: null, variantAttributeConflict: false,
    ...overrides,
  };
}

// spec section 43#17: cluster bridging cannot cause incompatible transitive collapse.
test('CLUSTER: A~B and B~C AUTO_MERGE, but A and C directly SEPARATE - A/B/C must NOT collapse into one cluster', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }, { offerId: 'C' }];
  const pairwiseResults = [
    decision('A', 'B', { decision: 'AUTO_MERGE' }),
    decision('B', 'C', { decision: 'AUTO_MERGE' }),
    decision('A', 'C', { decision: 'SEPARATE', negativeEvidence: ['tier1:validated_gtin_conflict'] }),
  ];
  const { variantClusters, variantRejectedEdges } = clusterOffers(offers, pairwiseResults);
  const clusterOf = new Map();
  for (const c of variantClusters) for (const id of c.offerIds) clusterOf.set(id, c.clusterId);
  assert.notEqual(clusterOf.get('A'), clusterOf.get('C'), 'A and C must land in different clusters despite the A-B / B-C bridge');
  assert.ok(variantRejectedEdges.length > 0, 'the bridging edge that would have caused the collapse must be recorded as rejected');
});

test('CLUSTER: one bad bridging listing does not create a mega-cluster across three otherwise-unrelated pairs', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }, { offerId: 'C' }, { offerId: 'D' }];
  const pairwiseResults = [
    decision('A', 'B', { decision: 'AUTO_MERGE' }),
    decision('B', 'C', { decision: 'AUTO_MERGE' }), // B bridges A's cluster toward C
    decision('C', 'D', { decision: 'AUTO_MERGE' }),
    decision('A', 'D', { decision: 'SEPARATE', negativeEvidence: ['tier1:validated_gtin_conflict'] }), // A and D are genuinely different
  ];
  const { variantClusters } = clusterOffers(offers, pairwiseResults);
  assert.ok(variantClusters.length > 1, 'A and D incompatibility must prevent a single 4-member mega-cluster');
});

test('CLUSTER: a fully compatible chain (no contradictions) DOES collapse into one cluster', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }, { offerId: 'C' }];
  const pairwiseResults = [
    decision('A', 'B', { decision: 'AUTO_MERGE' }),
    decision('B', 'C', { decision: 'AUTO_MERGE' }),
    decision('A', 'C', { decision: 'AUTO_MERGE' }),
  ];
  const { variantClusters } = clusterOffers(offers, pairwiseResults);
  assert.equal(variantClusters.length, 1);
  assert.equal(variantClusters[0].offerIds.length, 3);
});

test('CLUSTER: offers with no AUTO_MERGE edges at all remain singleton clusters', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }];
  const { variantClusters } = clusterOffers(offers, []);
  assert.equal(variantClusters.length, 2);
});

// spec section 6/18: a pure color/material/pattern conflict must separate at
// the VARIANT layer but still unify at the STYLE layer (siblings).
test('CLUSTER: a pure variant-attribute conflict (color) keeps two offers in different variant clusters but the same style cluster', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }];
  const pairwiseResults = [
    decision('A', 'B', { decision: 'SEPARATE', negativeEvidence: ['tier2:color_conflict'], variantAttributeConflict: true }),
  ];
  const { variantClusters, styleClusters } = clusterOffers(offers, pairwiseResults);
  assert.equal(variantClusters.length, 2, 'color-conflicting offers must never share a variant cluster');
  assert.equal(styleClusters.length, 1, 'color-conflicting siblings must still share a style cluster');
});

test('CLUSTER: a genuine style-level conflict (brand) keeps two offers apart at BOTH the variant and style layer', () => {
  const offers = [{ offerId: 'A' }, { offerId: 'B' }];
  const pairwiseResults = [
    decision('A', 'B', { decision: 'SEPARATE', negativeEvidence: ['tier2:brand_conflict'], variantAttributeConflict: false }),
  ];
  const { variantClusters, styleClusters } = clusterOffers(offers, pairwiseResults);
  assert.equal(variantClusters.length, 2);
  assert.equal(styleClusters.length, 2, 'a brand conflict is not a pure variant-attribute conflict and must not unify the style cluster');
});

test('CLUSTER (incrementalCluster primitive): cross-cluster merge is rejected when any member pair is incompatible', () => {
  const offerIds = ['A', 'B', 'C', 'D'];
  const edges = [
    { offerIdA: 'A', offerIdB: 'B' },
    { offerIdA: 'C', offerIdB: 'D' },
    { offerIdA: 'B', offerIdB: 'C' }, // would merge {A,B} with {C,D}
  ];
  const isIncompatible = (x, y) => (x === 'A' && y === 'D') || (x === 'D' && y === 'A');
  const { clusters, rejectedEdges } = incrementalCluster(offerIds, edges, isIncompatible);
  const clusterOf = new Map();
  for (const c of clusters) for (const id of c.offerIds) clusterOf.set(id, c.clusterId);
  assert.notEqual(clusterOf.get('A'), clusterOf.get('D'));
  assert.equal(rejectedEdges.length, 1);
  assert.equal(rejectedEdges[0].reason, 'cluster_merge_would_create_incompatible_transitive_collapse');
});
