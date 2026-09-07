/**
 * Mutation / negative-control suite (spec section 39).
 *
 * Five of the eleven mandatory mutations are proven against REAL production
 * functions in their own domain test files (see the cross-reference table
 * below) - this file does not repeat those checks. The remaining six have
 * no single real function to call against (no retailer-resolution
 * authority, no retailer registry, no affiliate mechanism, no ordering
 * function beyond "preserve the array as given") - for those, this file
 * proves the mutation is a REAL structural corruption of the original
 * scenario's own expected outcome, which is the strongest check available
 * without inventing an authority that does not exist in source.
 *
 * Every mutation record must satisfy the baseline contract: it points at a
 * real scenarioId, and its mutatedValue genuinely differs from the
 * original's corresponding expectation (a mutation that doesn't actually
 * change anything proves nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');
const mutationsFile = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');

const { scenarios } = loadCorpus();
const byId = new Map(scenarios.map((s) => [s.manifestEntry.scenarioId, s]));

const PROVEN_AGAINST_REAL_FUNCTION = new Set([
  'mut-currency-fabricated', // priceCurrencyTruth.test.js
  'mut-credential-shaped-url-preserved', // urlSafetyTruth.test.js
  'mut-shop-a-opens-b', // urlSafetyTruth.test.js
  'mut-watch-a-becomes-watch-b', // watchIdentityTruth.test.js
  'mut-fuzzy-grouping-introduced', // groupingDoctrine.test.js
]);

test('every mutation record points at a real scenarioId and is a genuine corruption', () => {
  for (const mutation of mutationsFile.records) {
    assert.ok(byId.has(mutation.mutationOf), `mutation '${mutation.scenarioId}' references unknown scenarioId '${mutation.mutationOf}'`);
    assert.notDeepEqual(
      mutation.originalValue,
      mutation.mutatedValue,
      `mutation '${mutation.scenarioId}' does not actually change anything`,
    );
    assert.equal(mutation.expected.harnessMustFlagAsViolation, true);
  }
});

test('all 11 mandatory mutation types from spec section 39 are present', () => {
  const required = [
    'brand-as-retailer',
    'logo-identity-mismatch',
    'unknown-domain-falsely-resolved',
    'order-not-preserved',
    'fuzzy-identity-grouped',
    'cross-offer-watch-identity-leakage',
    'cross-offer-shop-destination-leakage',
    'currency-fabricated',
    'attribution-fabricated',
    'legitimate-parameter-stripped',
    'credential-shaped-url-not-rejected',
  ];
  const present = mutationsFile.records.map((r) => r.violationType);
  for (const type of required) {
    assert.ok(present.includes(type), `missing required mutation type: ${type}`);
  }
});

test('every mutation is either proven against a real function elsewhere, or proven structurally here', () => {
  for (const mutation of mutationsFile.records) {
    const provenElsewhere = PROVEN_AGAINST_REAL_FUNCTION.has(mutation.scenarioId);
    const provenHere = STRUCTURAL_CHECKS.has(mutation.scenarioId);
    assert.ok(provenElsewhere || provenHere, `mutation '${mutation.scenarioId}' is not proven anywhere`);
  }
});

const STRUCTURAL_CHECKS = new Set([
  'mut-brand-substituted-as-retailer',
  'mut-wrong-logo-identity',
  'mut-unknown-domain-mapped-to-known-retailer',
  'mut-offer-order-changed',
  'mut-affiliate-attribution-fabricated',
  'mut-legitimate-parameter-stripped',
]);

test('mut-brand-substituted-as-retailer: the original doctrine scenario expects retailer to stay null; the mutation asserts a brand name instead', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-brand-substituted-as-retailer');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.expected.resolvedRetailer, null);
  assert.equal(original.input.brand, mutation.mutatedValue, 'sanity: the mutated value must be the record\'s own brand field');
  // Finding F1 cross-check: real source call sites DO make exactly this
  // substitution today (see ri-fallback-divergence-finding), which is why
  // this mutation encodes a real risk, not a hypothetical one.
  const findingScenario = byId.get('ri-fallback-divergence-finding').record;
  const brandSubstitutingCallSite = findingScenario.expected.callSites.find((c) => c.violation.includes('substitutes brand'));
  assert.ok(brandSubstitutingCallSite, 'expected Finding F1 evidence of a real brand-substituting call site');
});

test('mut-wrong-logo-identity: the retailerKey fixture convention scenario does not license swapping in a different retailer\'s key', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-wrong-logo-identity');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.input.retailerKey, mutation.originalValue);
  assert.notEqual(original.input.retailerKey, mutation.mutatedValue);
});

test('mut-unknown-domain-mapped-to-known-retailer: the original scenario expects unresolved retailer identity from an unrecognizable domain', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-unknown-domain-mapped-to-known-retailer');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.expected.retailerIdentity, 'unknown');
  assert.notEqual(original.expected.retailerIdentity, 'known');
  assert.equal(typeof mutation.mutatedValue, 'string');
});

test('mut-offer-order-changed: the original Where-to-Buy scenario expects strict source-order preservation', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-offer-order-changed');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.expected.orderPreserved, true);
  assert.ok(Array.isArray(original.expected.expectedOrder));
});

test('mut-affiliate-attribution-fabricated: AFFILIATE_AUTHORITY is ABSENT, so asserting attributionPresent:true is fabrication by definition', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-affiliate-attribution-fabricated');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.expected.attributionPresent, false);
  assert.equal(mutation.mutatedValue, true);
  const { buildReport } = require('../../tools/commerce-corpus/buildCoverageReport');
  assert.equal(buildReport().attributionCoverage.affiliateAuthority, 'ABSENT');
});

test('mut-legitimate-parameter-stripped: the original scenario expects the full URL (with its query parameter) preserved untouched', () => {
  const mutation = mutationsFile.records.find((r) => r.scenarioId === 'mut-legitimate-parameter-stripped');
  const original = byId.get(mutation.mutationOf).record;
  assert.equal(original.expected.destinationUrl, mutation.originalValue);
  assert.ok(original.expected.destinationUrl.includes('?'), 'sanity: original URL must actually carry a query parameter to strip');
  assert.ok(!mutation.mutatedValue.includes('?'), 'sanity: the mutated value must actually be missing the query parameter');
});
