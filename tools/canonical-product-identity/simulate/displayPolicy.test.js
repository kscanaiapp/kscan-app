'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulateWindowDisplayPolicies, simulateDisplayPolicies } = require('./displayPolicy');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');
const { evaluateAllPairs } = require('../evaluator/pairwiseEvaluation');

// spec section 43#20: display-policy simulation produces lost-option analysis.
test('DISPLAY POLICY: all four policies (D1-D4) are simulated and each reports a lostOptionsCount', () => {
  const offers = [
    { offerId: 'a1', retailer: 'X', price: 100 },
    { offerId: 'a2', retailer: 'Y', price: 90 },
    { offerId: 'a3', retailer: 'Z', price: 110 },
  ];
  const pairwiseResults = [
    { offerIdA: 'a1', offerIdB: 'a2', decision: 'AUTO_MERGE' },
    { offerIdA: 'a1', offerIdB: 'a3', decision: 'AUTO_MERGE' },
    { offerIdA: 'a2', offerIdB: 'a3', decision: 'AUTO_MERGE' },
  ];
  const result = simulateWindowDisplayPolicies(offers, pairwiseResults);
  for (const policy of ['D1_ONE_CARD_BEST_OFFER', 'D2_ONE_CARD_RETAILER_COUNT', 'D3_ONE_CARD_TOP_TWO_OFFERS', 'D4_STYLE_CARD_GROUPED_VARIANTS']) {
    assert.ok(policy in result, `missing display policy: ${policy}`);
    assert.ok('lostOptionsCount' in result[policy]);
  }
});

test('DISPLAY POLICY: D1 (best offer only) shows exactly 1 card for a fully-merged 3-offer cluster and loses the other 2', () => {
  const offers = [{ offerId: 'a', price: 100 }, { offerId: 'b', price: 90 }, { offerId: 'c', price: 110 }];
  const pairwiseResults = [
    { offerIdA: 'a', offerIdB: 'b', decision: 'AUTO_MERGE' },
    { offerIdA: 'a', offerIdB: 'c', decision: 'AUTO_MERGE' },
    { offerIdA: 'b', offerIdB: 'c', decision: 'AUTO_MERGE' },
  ];
  const result = simulateWindowDisplayPolicies(offers, pairwiseResults);
  assert.equal(result.D1_ONE_CARD_BEST_OFFER.uniqueProductsVisible, 1);
  assert.equal(result.D1_ONE_CARD_BEST_OFFER.lostOptionsCount, 2);
});

test('DISPLAY POLICY: D2 discloses the same offers D1 hides via a count, so D2 lostOptionsCount is always 0', () => {
  const offers = [{ offerId: 'a', price: 100 }, { offerId: 'b', price: 90 }];
  const pairwiseResults = [{ offerIdA: 'a', offerIdB: 'b', decision: 'AUTO_MERGE' }];
  const result = simulateWindowDisplayPolicies(offers, pairwiseResults);
  assert.equal(result.D2_ONE_CARD_RETAILER_COUNT.lostOptionsCount, 0);
  assert.equal(result.D2_ONE_CARD_RETAILER_COUNT.indirectlyVisibleCount, 1);
});

test('DISPLAY POLICY: D3 (top two offers) never loses anything for a cluster of size <= 2', () => {
  const offers = [{ offerId: 'a', price: 100 }, { offerId: 'b', price: 90 }];
  const pairwiseResults = [{ offerIdA: 'a', offerIdB: 'b', decision: 'AUTO_MERGE' }];
  const result = simulateWindowDisplayPolicies(offers, pairwiseResults);
  assert.equal(result.D3_ONE_CARD_TOP_TWO_OFFERS.lostOptionsCount, 0);
});

test('DISPLAY POLICY: D4 keeps every variant selector reachable within a style, unlike D1/D3 which fully hide non-primary offers', () => {
  const offers = [{ offerId: 'a', price: 100 }, { offerId: 'b', price: 90 }];
  // No AUTO_MERGE edge, but a pure color-conflict SEPARATE (sibling variant).
  const pairwiseResults = [{ offerIdA: 'a', offerIdB: 'b', decision: 'SEPARATE', negativeEvidence: ['tier2:color_conflict'], variantAttributeConflict: true }];
  const result = simulateWindowDisplayPolicies(offers, pairwiseResults);
  assert.equal(result.D4_STYLE_CARD_GROUPED_VARIANTS.variantSelectorsVisible, 2, 'both sibling variants must remain reachable as selectors under D4');
});

// spec section 43#20 (integration): runs end-to-end on the real corpus.
test('DISPLAY POLICY (integration): simulateDisplayPolicies runs on the real corpus and produces at least one window per category', () => {
  const corpus = loadSyntheticCorpus();
  const pairwiseResults = evaluateAllPairs(corpus);
  const result = simulateDisplayPolicies(corpus, { pairwiseResults, kSizes: [10] });
  assert.ok(result.perWindow.length > 0);
  for (const w of result.perWindow) {
    assert.ok(w.D1_ONE_CARD_BEST_OFFER.uniqueProductsVisible <= w.windowSize);
  }
});
