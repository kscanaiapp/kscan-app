/**
 * Commerce V2 "Where to Buy" (Build 35 §54-56, §80).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWhereToBuySummary, whereToBuyRowLabel } = require('../../services/commerce/whereToBuy.ts');
const { getOfferCase } = require('../fixtures/commerce/offers.js');

test('does not require grouping — builds from whatever offers are present for one item', () => {
  const rows = buildWhereToBuySummary([
    getOfferCase('retail_farfetch_declared').offer,
    getOfferCase('resale_poshmark_declared').offer,
    getOfferCase('resale_vinted_source_field').offer,
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.displayName),
    ['Farfetch', 'Poshmark', 'Vinted'],
  );
  assert.deepEqual(rows.map((r) => r.offerCount), [1, 1, 1]);
});

test('§55: order matches first appearance in the given offer stream, not alphabetical or commission', () => {
  const rows = buildWhereToBuySummary([
    { retailer: 'Vinted', commerceType: 'resale' },
    { retailer: 'Farfetch', commerceType: 'retail' },
    { retailer: 'Poshmark', commerceType: 'resale' },
  ]);
  assert.deepEqual(
    rows.map((r) => r.displayName),
    ['Vinted', 'Farfetch', 'Poshmark'],
    'must preserve input order verbatim, never alphabetize',
  );
});

test('counts multiple offers at the same retailer under one row', () => {
  const rows = buildWhereToBuySummary([
    { retailer: 'Farfetch', productUrl: 'https://www.farfetch.com/a-item-1.aspx' },
    { retailer: 'Farfetch', productUrl: 'https://www.farfetch.com/b-item-2.aspx' },
    { retailer: 'Nordstrom', productUrl: 'https://shop.nordstrom.com/s/c/1' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].displayName, 'Farfetch');
  assert.equal(rows[0].offerCount, 2);
  assert.equal(rows[1].offerCount, 1);
});

test('an offer with an unregistered but real declared retailer gets its own row, not merged with unknown', () => {
  const rows = buildWhereToBuySummary([
    { retailer: 'Not In Registry Boutique' },
    { retailer: 'Also Not Registered' },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.retailerKey), [null, null]);
  assert.deepEqual(rows.map((r) => r.displayName), ['Not In Registry Boutique', 'Also Not Registered']);
});

test('NEGATIVE CONTROL §77: an offer with only a brand field is never counted as a named retailer', () => {
  const rows = buildWhereToBuySummary([{ brand: "Levi's" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayName, 'Unknown retailer');
  assert.equal(rows[0].retailerKey, null);
});

test('§56 retailer concentration: shows the true count even when one retailer dominates', () => {
  const offers = Array.from({ length: 8 }, () => ({ retailer: 'Farfetch' })).concat(
    Array.from({ length: 2 }, () => ({ retailer: 'Poshmark', commerceType: 'resale' })),
  );
  const rows = buildWhereToBuySummary(offers);
  assert.equal(rows.find((r) => r.displayName === 'Farfetch').offerCount, 8);
  assert.equal(rows.find((r) => r.displayName === 'Poshmark').offerCount, 2);
});

test('allResale is true only when every offer under that retailer is resale', () => {
  const mixedRows = buildWhereToBuySummary([
    { retailer: 'Poshmark', commerceType: 'resale' },
    { retailer: 'Poshmark', commerceType: 'retail' },
  ]);
  assert.equal(mixedRows[0].allResale, false);

  const pureResaleRows = buildWhereToBuySummary([
    { retailer: 'Vinted', commerceType: 'resale' },
    { retailer: 'Vinted', commerceType: 'resale' },
  ]);
  assert.equal(pureResaleRows[0].allResale, true);
});

test('empty/null input produces an empty summary, not an error', () => {
  assert.deepEqual(buildWhereToBuySummary([]), []);
  assert.deepEqual(buildWhereToBuySummary(undefined), []);
});

test('NEGATIVE CONTROL §51/§81: similar-but-not-identical products at the same retailer are counted as two offers, never fuzzy-merged into one item', () => {
  const a = getOfferCase('similar_not_identical_a').offer;
  const b = getOfferCase('similar_not_identical_b').offer;
  // Both are Nordstrom, so the retailer row legitimately shows "2 offers" --
  // that count reflects two real, distinct retailer listings; nothing here
  // groups them into a single cross-retailer PRODUCT the way §51 forbids.
  const rows = buildWhereToBuySummary([a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayName, 'Nordstrom');
  assert.equal(rows[0].offerCount, 2);
});

test('same exact product at two different retailers produces two separate retailer rows (no cross-retailer grouping attempted)', () => {
  const a = getOfferCase('same_product_offer_farfetch').offer;
  const b = getOfferCase('same_product_offer_poshmark').offer;
  const rows = buildWhereToBuySummary([a, b]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.displayName), ['Farfetch', 'Poshmark']);
});

test('§53: row label states an exact count, never "Best Deal"/"Cheapest"/"Lowest Price"', () => {
  assert.equal(whereToBuyRowLabel({ offerCount: 1, allResale: false }), '1 offer');
  assert.equal(whereToBuyRowLabel({ offerCount: 3, allResale: false }), '3 offers');
  assert.equal(whereToBuyRowLabel({ offerCount: 1, allResale: true }), '1 resale offer');
  assert.equal(whereToBuyRowLabel({ offerCount: 2, allResale: true }), '2 resale offers');
});
