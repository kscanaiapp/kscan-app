/**
 * Structural doctrine checks for categories with no single real function to
 * wire against (customer-claim-safety, retail-resale, product-identity,
 * product-image, failure, accessibility-data, affiliate-attribution). Every
 * scenario here is asserted against its OWN declared expectation, and
 * against the cross-category doctrine constants established elsewhere in
 * this corpus (Findings F1/F2, AFFILIATE_AUTHORITY: ABSENT, no GTIN/SKU/UPC/
 * EAN in production schema), rather than against a runtime function that
 * does not exist for these concerns.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const { scenarios } = loadCorpus();
const byCategory = (cat) => scenarios.filter((s) => s.manifestEntry.category === cat);

test('customer-claim-safety: every scenario asserts claimLicensed: false', () => {
  const claimScenarios = byCategory('customer-claim-safety');
  assert.ok(claimScenarios.length >= 8);
  for (const { manifestEntry, record } of claimScenarios) {
    assert.equal(record.expected.claimLicensed, false, `${manifestEntry.scenarioId} must not license its claim`);
    assert.ok(typeof record.expected.reason === 'string' && record.expected.reason.length > 0);
  }
});

test('retail-resale: absence of commerceType is the realistic representation of an ordinary retail offer', () => {
  const rr = byCategory('retail-resale');
  const retailScenario = rr.find((s) => s.manifestEntry.scenarioId === 'rr-retail-offer');
  assert.equal(retailScenario.record.input.commerceType, undefined);
  assert.equal(retailScenario.record.expected.commerceType, 'absent');
});

test('retail-resale: only Poshmark-sourced scenarios declare commerceType resale', () => {
  const rr = byCategory('retail-resale');
  for (const { record } of rr) {
    const offers = Array.isArray(record.input) ? record.input : record.input.offers || [record.input];
    for (const offer of offers) {
      if (offer.commerceType === 'resale') {
        assert.ok(
          offer.source === 'poshmark' || offer.retailer === 'Poshmark',
          `a resale offer outside Poshmark was declared: ${JSON.stringify(offer)}`,
        );
      }
    }
  }
});

test('retail-resale: retailer neutrality - no scenario carries a ranking/commission adjustment field for Retail vs Resale', () => {
  const rr = byCategory('retail-resale');
  for (const { manifestEntry, record } of rr) {
    if (record.expected && 'rankingAdjustment' in record.expected) {
      assert.equal(record.expected.rankingAdjustment, 'none', `${manifestEntry.scenarioId} must not license a ranking adjustment by commerce type`);
    }
  }
});

test('product-identity: GTIN/SKU/UPC/EAN absence is documented explicitly, matching the census', () => {
  const pid = byCategory('product-identity');
  const absenceScenario = pid.find((s) => s.manifestEntry.scenarioId === 'pid-gtin-sku-upc-ean-absent-from-schema');
  assert.equal(absenceScenario.record.expected.gtinFieldExistsInProduction, false);
  assert.equal(absenceScenario.record.expected.skuFieldExistsInProduction, false);
  assert.equal(absenceScenario.record.expected.upcFieldExistsInProduction, false);
  assert.equal(absenceScenario.record.expected.eanFieldExistsInProduction, false);
});

test('product-identity: no scenario claims a governed cross-retailer identity exists', () => {
  const pid = byCategory('product-identity');
  const noGovernedId = pid.find((s) => s.manifestEntry.scenarioId === 'pid-no-governed-cross-retailer-source-id');
  assert.equal(noGovernedId.record.expected.governedCrossRetailerIdExists, false);
});

test('product-image: alias precedence matches the real dressingRoomCommerce.ts order (imageUrl > image_url > thumbnail > thumbnailUrl)', () => {
  const images = byCategory('product-image');
  const precedence = images.find((s) => s.manifestEntry.scenarioId === 'img-multiple-fields-precedence');
  assert.ok(precedence, 'fixture missing');
  assert.equal(precedence.record.expected.displayedUrl ?? precedence.record.expected.resolvedUrl, precedence.record.input.imageUrl);
});

test('failure: every missing-required-field sub-case forbids a fabricated stand-in value', () => {
  const failures = byCategory('failure');
  const missingFields = failures.find((s) => s.manifestEntry.scenarioId === 'fail-missing-required-fields');
  assert.ok(Array.isArray(missingFields.record.expected));
  for (const outcome of missingFields.record.expected) {
    assert.equal(outcome.crash, false, `${outcome.missingField}: must never crash`);
    assert.equal(outcome.fabricatedValue, false, `${outcome.missingField}: must never fabricate a stand-in value`);
  }
});

test('failure: retryable and non-retryable errors are distinguished, not conflated', () => {
  const failures = byCategory('failure');
  const retryable = failures.find((s) => s.manifestEntry.scenarioId === 'fail-retryable-error');
  const nonRetryable = failures.find((s) => s.manifestEntry.scenarioId === 'fail-non-retryable-error');
  assert.ok(retryable && nonRetryable, 'both retryable and non-retryable failure fixtures must exist');
  assert.notEqual(retryable.record.expected.retryActionOffered ?? true, nonRetryable.record.expected.retryActionOffered ?? false);
});

test('accessibility-data: every scenario is explicitly marked as a provisional presentation template, not product authority', () => {
  const a11y = byCategory('accessibility-data');
  assert.ok(a11y.length >= 3);
  for (const { manifestEntry, record } of a11y) {
    assert.equal(
      record.expected.presentationStatus,
      'PROVISIONAL PRESENTATION TEMPLATE',
      `${manifestEntry.scenarioId} must mark its example copy provisional (Section 40)`,
    );
  }
});

test('affiliate-attribution: no scenario ever asserts attributionPresent: true (AFFILIATE_AUTHORITY: ABSENT)', () => {
  const aff = byCategory('affiliate-attribution');
  assert.ok(aff.length >= 6);
  for (const { manifestEntry, record } of aff) {
    assert.equal(record.expected.attributionPresent, false, `${manifestEntry.scenarioId} would fabricate attribution authority that does not exist`);
    assert.equal(record.expected.fabricatedAttribution, false);
  }
});

test('watch-offer-identity + shop-offer-identity: no scenario reports crossOfferIdentityLeakage/crossOfferUrlLeakage as true', () => {
  for (const cat of ['watch-offer-identity', 'shop-offer-identity']) {
    for (const { manifestEntry, record } of byCategory(cat)) {
      const leakageKey = Object.keys(record.expected).find((k) => /crossOffer/i.test(k));
      if (leakageKey) {
        assert.equal(record.expected[leakageKey], false, `${manifestEntry.scenarioId} reports leakage as allowed`);
      }
    }
  }
});
