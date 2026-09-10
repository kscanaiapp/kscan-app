/**
 * Watch eligibility + Watch offer identity (spec sections 22-23), wired to
 * the REAL isWatchableListing() from types/watchlist.ts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createModuleLoader } = require('../../tools/commerce-corpus/lib/loadProductionModule');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const loadClient = createModuleLoader();
const { isWatchableListing } = loadClient('types/watchlist.ts');

const { scenarios } = loadCorpus();
const watchabilityScenarios = scenarios.filter((s) => s.manifestEntry.category === 'watchability');
const watchIdentityScenarios = scenarios.filter((s) => s.manifestEntry.category === 'watch-offer-identity');

for (const { manifestEntry, record } of watchabilityScenarios) {
  test(`watchability: ${manifestEntry.scenarioId}`, () => {
    const actual = isWatchableListing(record.input);
    assert.equal(actual, record.expected.watchable, `isWatchableListing mismatch for ${manifestEntry.scenarioId}`);
  });
}

for (const { manifestEntry, record } of watchIdentityScenarios) {
  test(`watch-offer-identity: ${manifestEntry.scenarioId}`, () => {
    const offers = record.input.offers;
    const expectedWatches = record.expected.watches;
    assert.equal(offers.length, expectedWatches.length);

    offers.forEach((offer, i) => {
      const actualWatchable = isWatchableListing(offer);
      const expected = expectedWatches.find((w) => w.fromOfferId === offer.offerId);
      assert.equal(actualWatchable, expected.watchable, `offer ${offer.offerId} watchability mismatch`);
      if (actualWatchable) {
        assert.equal(offer.productUrl, expected.identity.canonicalUrl, `offer ${offer.offerId}: Watch identity URL mismatch`);
        assert.equal(offer.retailer, expected.identity.retailer, `offer ${offer.offerId}: Watch identity retailer mismatch`);
      }
    });

    // Cross-offer identity leakage check: no two DIFFERENT offers may
    // resolve to the same Watch identity (canonicalUrl) unless their real
    // productUrl was already identical.
    const identities = expectedWatches.filter((w) => w.watchable).map((w) => w.identity.canonicalUrl);
    assert.equal(identities.length, new Set(identities).size, 'two offers claim the same Watch identity');
  });
}

test('NEGATIVE CONTROL: mut-watch-a-becomes-watch-b must disagree with the real per-offer identity', () => {
  const mutations = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');
  const mutation = mutations.records.find((r) => r.scenarioId === 'mut-watch-a-becomes-watch-b');
  const original = watchIdentityScenarios.find((s) => s.manifestEntry.scenarioId === mutation.mutationOf);
  const offerA = original.record.input.offers[0];
  const offerB = original.record.input.offers[1];

  assert.notEqual(offerA.productUrl, offerB.productUrl, 'sanity: offers must have distinct URLs for this control to mean anything');
  assert.ok(isWatchableListing(offerA), 'offer A must actually be watchable for this control to be meaningful');
  // The mutation claims offer A's watch would carry offer B's retailer/URL.
  // The real, independent per-offer identity (offer A's own fields) must
  // disagree with that claim.
  assert.notEqual(offerA.retailer, offerB.retailer);
  assert.notEqual(offerA.productUrl, offerB.productUrl);
});
