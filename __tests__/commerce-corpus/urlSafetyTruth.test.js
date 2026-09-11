/**
 * URL safety / domain-truth doctrine (spec section 16), wired to the REAL
 * production functions in services/commerceDestination.ts.
 *
 * Deliberately conservative about what it asserts: `safe` and (when safe)
 * `isAggregator` are grounded in real, callable production functions and are
 * checked against them here. `retailerIdentity`/`retailerName` are labeled
 * SYNTHETIC in the fixtures themselves (no repo-internal retailer registry
 * exists) and are NOT asserted against any function, because none exists to
 * call.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createModuleLoader } = require('../../tools/commerce-corpus/lib/loadProductionModule');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const loadClient = createModuleLoader();
const { isSafeCommerceUrl, isAggregatorDestination, selectCommerceDestination } = loadClient('services/commerceDestination.ts');
const { normalizePersistedCommerceUrl } = loadClient('services/dressingRoomCommerce.ts');

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

const { scenarios } = loadCorpus();
const domainScenarios = scenarios.filter((s) => s.manifestEntry.category === 'domain-resolution');
const shopScenarios = scenarios.filter((s) => s.manifestEntry.category === 'shop-offer-identity');

for (const { manifestEntry, record } of domainScenarios) {
  test(`domain-resolution: ${manifestEntry.scenarioId}`, () => {
    const inputs = asArray(record.input).map((v) => (typeof v === 'string' ? v : v.productUrl));
    const expecteds = asArray(record.expected);
    assert.equal(inputs.length, expecteds.length);

    inputs.forEach((url, i) => {
      const exp = expecteds[i];
      const safeResult = isSafeCommerceUrl(url);
      assert.equal(Boolean(safeResult), exp.safe, `${manifestEntry.scenarioId}[${i}]: isSafeCommerceUrl(${url}) safety mismatch`);
      if (exp.safe) {
        assert.equal(safeResult, exp.resolvedUrl);
        assert.equal(isAggregatorDestination(url), exp.isAggregator);
      }
    });
  });
}

for (const { manifestEntry, record } of shopScenarios) {
  test(`shop-offer-identity: ${manifestEntry.scenarioId}`, () => {
    const offers = record.input.offers;
    const expectedDestinations = record.expected.shopDestinations;
    assert.equal(offers.length, expectedDestinations.length);

    offers.forEach((offer, i) => {
      // selectCommerceDestination operates on ONE offer's own candidate URLs -
      // proving it never reaches across to a sibling offer means calling it
      // with only THIS offer's candidates, never the full offers array.
      const opensUrl = selectCommerceDestination([offer.productUrl]);
      const expected = expectedDestinations.find((d) => d.fromOfferId === offer.offerId);
      assert.equal(opensUrl, expected.opensUrl, `offer ${offer.offerId} resolved to the wrong Shop destination`);
    });

    // Cross-offer leakage check: no offer's resolved URL may equal a
    // DIFFERENT offer's productUrl unless they were already identical inputs.
    const resolved = offers.map((o) => ({ id: o.offerId, url: selectCommerceDestination([o.productUrl]) }));
    for (const a of resolved) {
      for (const b of resolved) {
        if (a.id === b.id) continue;
        if (a.url && b.url && a.url === b.url) {
          const sameInput = offers.find((o) => o.offerId === a.id).productUrl === offers.find((o) => o.offerId === b.id).productUrl;
          assert.ok(sameInput, `cross-offer URL leakage: ${a.id} and ${b.id} resolved to the same URL from different inputs`);
        }
      }
    }
  });
}

test('cross-module finding: isSafeCommerceUrl and normalizePersistedCommerceUrl disagree on a signed/tracking query string', () => {
  const url =
    'https://images.example-retailer.test/products/12345/main.jpg?sig=fake1234567890abcdef&expires=1893456000';
  assert.ok(isSafeCommerceUrl(url), 'commerceDestination.ts does not inspect query strings at all');
  assert.equal(
    normalizePersistedCommerceUrl(url),
    null,
    'dressingRoomCommerce.ts rejects sig/expires query keys for any persisted commerce URL, image URLs included',
  );
});

test('NEGATIVE CONTROL: mut-credential-shaped-url-preserved must disagree with the real isSafeCommerceUrl', () => {
  const mutations = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');
  const mutation = mutations.records.find((r) => r.scenarioId === 'mut-credential-shaped-url-preserved');
  const original = scenarios.find((s) => s.manifestEntry.scenarioId === mutation.mutationOf);
  const url = original.record.input.productUrl || original.record.input.affiliateUrl;

  assert.equal(isSafeCommerceUrl(url), null, 'the real function must reject the credential-shaped URL, contradicting the mutation');
});

test('NEGATIVE CONTROL: mut-shop-a-opens-b must disagree with the real selectCommerceDestination', () => {
  const mutations = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');
  const mutation = mutations.records.find((r) => r.scenarioId === 'mut-shop-a-opens-b');
  const original = shopScenarios.find((s) => s.manifestEntry.scenarioId === mutation.mutationOf);
  const offerA = original.record.input.offers[0];

  const real = selectCommerceDestination([offerA.productUrl]);
  assert.equal(real, offerA.productUrl);
  assert.notEqual(real, mutation.mutatedValue, 'the real function must never substitute a sibling offer\'s URL');
});
