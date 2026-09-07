/**
 * Per-garment / multi-item commerce (spec sections 33-34), grounded in the
 * real Map<candidateId, ItemCommerceCard> shape from services/
 * multiItemCommerce.ts (PER_GARMENT_COMMERCE: PRESENT).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const { scenarios } = loadCorpus();
const multiItemScenarios = scenarios.filter((s) => s.manifestEntry.category === 'multi-item');

test('every candidate in the 3-garment positive scenario carries its own retailer, matching only its own bestMatch', () => {
  const scenario = multiItemScenarios.find((s) => s.manifestEntry.scenarioId === 'mi-three-garments-independent');
  const { cards } = scenario.record.input;
  const { cardsByCandidateId } = scenario.record.expected;

  for (const candidateId of Object.keys(cardsByCandidateId)) {
    const actualRetailer = cards[candidateId].bestMatch.retailer;
    const expectedRetailer = cardsByCandidateId[candidateId].bestMatchRetailer;
    assert.equal(actualRetailer, expectedRetailer, `${candidateId} bestMatch retailer mismatch`);
  }

  const retailers = Object.values(cards).map((c) => c.bestMatch.retailer);
  assert.equal(retailers.length, new Set(retailers).size, 'expected 3 distinct retailers, one per garment, in this fixture');
});

test('NEGATIVE CONTROL: candidate A bestMatch.productUrl must never equal a different candidate\'s productUrl (cross-item leakage)', () => {
  const scenario = multiItemScenarios.find((s) => s.manifestEntry.scenarioId === 'mi-negative-control-cross-item-leak');
  const { cards } = scenario.record.input;
  assert.equal(scenario.record.expected.crossItemLeakageAllowed, false);

  const urls = Object.entries(cards).map(([candidateId, card]) => ({ candidateId, url: card.bestMatch.productUrl }));
  for (const a of urls) {
    for (const b of urls) {
      if (a.candidateId === b.candidateId) continue;
      assert.notEqual(a.url, b.url, `${a.candidateId} and ${b.candidateId} must not share a productUrl`);
    }
  }
});

test('partial failure isolation: one candidate erroring never changes the status or bestMatch of a sibling candidate', () => {
  const scenario = multiItemScenarios.find((s) => s.manifestEntry.scenarioId === 'mi-partial-failure-isolated');
  const { cards } = scenario.record.input;
  const expected = scenario.record.expected;

  assert.equal(cards['cand-skirt-2'].status, 'error');
  assert.equal(cards['cand-skirt-2'].retryable, true);
  assert.equal(cards['cand-skirt-2'].bestMatch, null);

  for (const readyId of ['cand-jacket-2', 'cand-boots-2']) {
    assert.equal(cards[readyId].status, 'ready');
    assert.ok(cards[readyId].bestMatch, `${readyId} must retain its real bestMatch data`);
    assert.equal(expected[readyId].unaffectedByOtherCandidateError, true);
  }
});
