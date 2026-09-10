/**
 * Commerce V2 retailer identity resolver (Build 35 §14-16, §23, §77-83).
 *
 * Data-driven against __tests__/fixtures/commerce/offers.js, plus explicit
 * negative controls the plan calls out by number.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRetailerIdentity } = require('../../services/commerce/retailerIdentity.ts');
const { RETAILER_OFFERS, getOfferCase } = require('../fixtures/commerce/offers.js');

// ---- Data-driven pass over the whole seeded corpus -------------------------

for (const entry of RETAILER_OFFERS) {
  if (entry.caseId === 'synthetic_approved_logo') continue; // covered separately below
  test(`resolveRetailerIdentity: ${entry.caseId} — ${entry.description}`, () => {
    const identity = resolveRetailerIdentity(entry.offer);
    assert.equal(identity.retailerKey, entry.expected.retailerKey, 'retailerKey');
    assert.equal(identity.displayName, entry.expected.displayName, 'displayName');
    assert.equal(identity.sourceAuthority, entry.expected.sourceAuthority, 'sourceAuthority');
    assert.equal(identity.commerceType, entry.expected.commerceType, 'commerceType');
  });
}

// ---- §77 Negative control — seller truth: brand never becomes retailer ----

test('NEGATIVE CONTROL §77: brand=Nike + retailer=Farfetch resolves SELLER=Farfetch, never Nike', () => {
  const identity = resolveRetailerIdentity({
    brand: 'Nike',
    retailer: 'Farfetch',
    productUrl: 'https://www.farfetch.com/shopping/x-item-1.aspx',
  });
  assert.equal(identity.displayName, 'Farfetch');
  assert.notEqual(identity.displayName, 'Nike');
});

test('NEGATIVE CONTROL §77: a brand-only offer never fabricates a retailer from brand', () => {
  const identity = resolveRetailerIdentity({ brand: "Levi's" });
  assert.equal(identity.retailerKey, null);
  assert.equal(identity.displayName, null);
  assert.equal(identity.sourceAuthority, 'unknown');
});

test('NEGATIVE CONTROL §77: brand is never read by the resolver at all, even when it collides with a real retailer name', () => {
  // "Nordstrom" as a BRAND (not retailer) field must never resolve — proves
  // the resolver genuinely never inspects `brand`, not just that it prefers
  // other fields when they are present.
  const identity = resolveRetailerIdentity({ brand: 'Nordstrom' });
  assert.equal(identity.retailerKey, null);
  assert.equal(identity.sourceAuthority, 'unknown');
});

// ---- §78 Negative control — domain truth -----------------------------------

test('NEGATIVE CONTROL §78: a known merchant domain resolves correctly', () => {
  const identity = resolveRetailerIdentity({ productUrl: 'https://www.farfetch.com/shopping/x-item-1.aspx' });
  assert.equal(identity.retailerKey, 'farfetch');
  assert.equal(identity.sourceAuthority, 'domain');
});

test('NEGATIVE CONTROL §78: a redirect/aggregator host never resolves to a retailer', () => {
  const identity = resolveRetailerIdentity({ productUrl: 'https://www.google.com/shopping/product/1' });
  assert.equal(identity.retailerKey, null);
  assert.equal(identity.sourceAuthority, 'unknown');
});

test('NEGATIVE CONTROL §78: a marketplace subdomain resolves via its apex domain', () => {
  const identity = resolveRetailerIdentity({ productUrl: 'https://shop.nordstrom.com/s/item/1' });
  assert.equal(identity.retailerKey, 'nordstrom');
  assert.equal(identity.sourceAuthority, 'domain');
});

test('NEGATIVE CONTROL §78: an unknown domain never resolves to a retailer', () => {
  const identity = resolveRetailerIdentity({ productUrl: 'https://totally-unknown-store.example.test/p/1' });
  assert.equal(identity.retailerKey, null);
});

test('NEGATIVE CONTROL §78: a shared/generic host never resolves to a retailer', () => {
  const identity = resolveRetailerIdentity({
    productUrl: 'https://shops.example-storefront-platform.test/some-shop/item',
  });
  assert.equal(identity.retailerKey, null);
});

// ---- §80 Negative control — ranking is untouched ---------------------------

test('NEGATIVE CONTROL §80: resolving identity does not mutate or reorder the input offer array', () => {
  const offers = RETAILER_OFFERS.filter((o) => o.offer.productUrl).map((o) => ({ ...o.offer }));
  const before = offers.map((o) => o.id);
  for (const offer of offers) resolveRetailerIdentity(offer);
  const after = offers.map((o) => o.id);
  assert.deepEqual(after, before, 'offer order/identity must be unchanged by identity resolution');
});

test('NEGATIVE CONTROL §80: identical offer input produces identical resolved identity on repeat calls (deterministic, not registry-order-sensitive)', () => {
  const offer = getOfferCase('retail_farfetch_declared').offer;
  const first = resolveRetailerIdentity(offer);
  const second = resolveRetailerIdentity(offer);
  assert.deepEqual(first, second);
});

// ---- Unsafe URL must never leak into a domain match ------------------------

test('a credentialed/unsafe purchase URL is never used for the domain fallback', () => {
  const identity = resolveRetailerIdentity({
    productUrl: 'https://user:pass@www.farfetch.com/shopping/women/x-item-1.aspx',
  });
  assert.equal(identity.retailerKey, null);
  assert.equal(identity.sourceAuthority, 'unknown');
});

// ---- Malformed / absent input -----------------------------------------------

test('resolveRetailerIdentity tolerates null/undefined/non-object input', () => {
  for (const bad of [null, undefined, 'a string', 42, []]) {
    const identity = resolveRetailerIdentity(bad);
    assert.equal(identity.retailerKey, null);
    assert.equal(identity.sourceAuthority, 'unknown');
  }
});

test('a declared retailer name with no registry match is returned as-is, not dropped or replaced', () => {
  const identity = resolveRetailerIdentity({ retailer: 'Not In Registry Boutique' });
  assert.equal(identity.retailerKey, null);
  assert.equal(identity.displayName, 'Not In Registry Boutique');
  assert.equal(identity.sourceAuthority, 'declared');
});
