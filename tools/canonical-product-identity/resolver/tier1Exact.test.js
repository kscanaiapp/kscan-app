'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tier1Exact } = require('./tier1Exact');
const { normalizeOffer } = require('./normalizeOffer');
const { generateValidGtin13 } = require('../lib/identifierNormalize');

const GTIN_A = generateValidGtin13({ int: (min, max) => Math.floor((min + max) / 2) });
const GTIN_B = generateValidGtin13({ int: () => 7 });

// spec section 43#13: conflicting strong IDs block merge.
test('TIER 1: conflicting validated GTINs are BLOCKED, never AUTO_MERGE_ELIGIBLE', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X', gtin: GTIN_A });
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y', gtin: GTIN_B });
  const result = tier1Exact(a, b);
  assert.equal(result.eligible, 'BLOCKED');
  assert.ok(result.negative.includes('validated_gtin_conflict'));
});

test('TIER 1: matching manufacturer style codes are AUTO_MERGE_ELIGIBLE', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X', manufacturerStyleCode: 'AB-1234' });
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y', manufacturerStyleCode: 'ab1234' });
  const result = tier1Exact(a, b);
  assert.equal(result.eligible, 'AUTO_MERGE_ELIGIBLE');
  assert.ok(result.positive.includes('manufacturer_style_code_match'));
});

test('TIER 1: conflicting manufacturer style codes block eligibility', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X', manufacturerStyleCode: 'V1-1' });
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y', manufacturerStyleCode: 'V2-1' });
  const result = tier1Exact(a, b);
  assert.equal(result.eligible, 'BLOCKED');
});

// spec section 43#14: missing IDs safely fall through.
test('TIER 1: no identifiers on either side falls through to NO_TIER1_EVIDENCE, not a false positive or a crash', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X' });
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y' });
  const result = tier1Exact(a, b);
  assert.equal(result.eligible, 'NO_TIER1_EVIDENCE');
  assert.deepEqual(result.positive, []);
  assert.deepEqual(result.negative, []);
});

test('TIER 1: an identifier present on only one side is recorded as missing evidence, not treated as a conflict', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X', gtin: GTIN_A });
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y' });
  const result = tier1Exact(a, b);
  assert.equal(result.eligible, 'NO_TIER1_EVIDENCE');
  assert.ok(result.missing.includes('gtin_present_one_side_only'));
  assert.deepEqual(result.negative, []);
});

test('TIER 1: a GTIN present on both sides but failing checksum validation on at least one side never counts as a match', () => {
  const a = normalizeOffer({ offerId: 'a', retailer: 'X', gtin: '123456789013' }); // invalid checksum
  const b = normalizeOffer({ offerId: 'b', retailer: 'Y', gtin: GTIN_A });
  const result = tier1Exact(a, b);
  assert.notEqual(result.eligible, 'AUTO_MERGE_ELIGIBLE');
  assert.ok(result.missing.includes('gtin_present_but_not_both_validated'));
});
