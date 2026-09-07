'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tier2Structured } = require('./tier2Structured');
const { normalizeOffer } = require('./normalizeOffer');

function norm(fields) {
  return normalizeOffer({ offerId: 'x', retailer: 'R', ...fields });
}

// spec section 43#10: URLs alone do not establish identity - tier2Structured
// has no URL-matching signal at all; only brand/category/title/attributes.
test('TIER 2: an identical URL with no other shared evidence is never sufficient to become styleEligible', () => {
  const a = norm({ canonicalUrl: 'https://example.com/p/1' });
  const b = norm({ canonicalUrl: 'https://example.com/p/1' });
  const result = tier2Structured(a, b);
  assert.equal(result.styleEligible, false, 'brand+category must both be present and agree before ANY structured claim is made');
});

test('TIER 2: without brand AND category both present and agreeing, no structured evidence is produced at all (conservative gate)', () => {
  const a = norm({ brand: 'Vince', category: undefined, title: 'x' });
  const b = norm({ brand: 'Vince', category: 'jacket', title: 'x' });
  const result = tier2Structured(a, b);
  assert.equal(result.styleEligible, false);
  assert.equal(result.styleScore, 0);
});

test('TIER 2: a brand conflict is negative evidence even when category and title otherwise match', () => {
  const a = norm({ brand: 'Vince', category: 'jacket', title: 'Cropped Jacket' });
  const b = norm({ brand: 'Theory', category: 'jacket', title: 'Cropped Jacket' });
  const result = tier2Structured(a, b);
  assert.ok(result.negative.includes('brand_conflict'));
  assert.equal(result.styleEligible, false);
});

test('TIER 2: matching brand+category+color+material produces positive evidence and a bounded [0,1] score', () => {
  const a = norm({ brand: 'Vince', category: 'jacket', title: 'Cropped Moto Jacket Black Lambskin', color: 'black', material: 'lambskin' });
  const b = norm({ brand: 'Vince', category: 'jacket', title: 'Cropped Moto Jacket Black Lambskin', color: 'black', material: 'lambskin' });
  const result = tier2Structured(a, b);
  assert.equal(result.styleEligible, true);
  assert.ok(result.styleScore > 0 && result.styleScore <= 1);
  assert.ok(result.positive.includes('brand_match'));
  assert.ok(result.positive.includes('color_match'));
});

test('TIER 2: price is never read as evidence anywhere in the structured comparison (section 12)', () => {
  const a = norm({ brand: 'Vince', category: 'jacket', price: 475 });
  const b = norm({ brand: 'Vince', category: 'jacket', price: 149 });
  const result = tier2Structured(a, b);
  const allEvidence = [...result.positive, ...result.negative, ...result.missing];
  assert.ok(!allEvidence.some((e) => /price/i.test(e)));
});
