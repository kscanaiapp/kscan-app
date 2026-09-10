'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeCategory, canonicalizeSubtype, impliedCategoryFromSubtype } = require('../canonicalize');

// ── bomber aliases (spec section 8's own worked example) ─────────────────

test('bomber, bomber jacket, and flight jacket all resolve to the same canonical subtype', () => {
  for (const raw of ['bomber', 'bomber jacket', 'flight jacket', 'Bomber Jacket', ' FLIGHT JACKET ']) {
    assert.equal(canonicalizeSubtype(raw).value, 'bomber_jacket', raw);
  }
});

test('a resolved bomber_jacket subtype implies the outerwear category', () => {
  const subtype = canonicalizeSubtype('flight jacket');
  assert.equal(impliedCategoryFromSubtype(subtype.value), 'outerwear');
});

test('bomber jacket stays distinct from an unrelated jacket subtype', () => {
  assert.equal(canonicalizeSubtype('chore jacket').value, 'chore_jacket');
  assert.notEqual(canonicalizeSubtype('chore jacket').value, canonicalizeSubtype('bomber').value);
});

// ── unsupported category (spec section 17) ────────────────────────────────

test('an unsupported category resolves to unknown, not an invented nearest category', () => {
  const result = canonicalizeCategory('spacesuit');
  assert.equal(result.value, null);
  assert.equal(result.raw, 'spacesuit');
});

test('every canonical category has at least one alias that resolves to it', () => {
  const { CANONICAL_CATEGORIES, CATEGORY_ALIASES } = require('../categories');
  const resolvedValues = new Set(Object.values(CATEGORY_ALIASES));
  for (const category of CANONICAL_CATEGORIES) {
    assert.ok(resolvedValues.has(category), `no alias resolves to ${category}`);
  }
});

test('every subtype in the taxonomy has a valid, existing parent category', () => {
  const { CANONICAL_CATEGORIES, SUBTYPES } = require('../categories');
  const validCategories = new Set(CANONICAL_CATEGORIES);
  for (const subtype of SUBTYPES) {
    assert.ok(validCategories.has(subtype.category), `${subtype.value} has unknown parent category ${subtype.category}`);
  }
});

test('no alias is shared between two different canonical subtypes', () => {
  const { SUBTYPES } = require('../categories');
  const seen = new Map();
  for (const subtype of SUBTYPES) {
    for (const alias of subtype.aliases) {
      assert.ok(!seen.has(alias), `alias ${JSON.stringify(alias)} claimed by both ${seen.get(alias)} and ${subtype.value}`);
      seen.set(alias, subtype.value);
    }
  }
});

// ── semantic hardening pass — garment subtype doctrine ──────────────────────

test('SEMANTIC HARDENING: hoodie no longer folds into sweatshirt — distinct subtypes', () => {
  const hoodie = canonicalizeSubtype('hoodie');
  const sweatshirt = canonicalizeSubtype('sweatshirt');
  assert.equal(hoodie.value, 'hoodie');
  assert.equal(sweatshirt.value, 'sweatshirt');
  assert.notEqual(hoodie.value, sweatshirt.value);
  assert.equal(impliedCategoryFromSubtype(hoodie.value), 'top');
});

test('SEMANTIC HARDENING: camisole no longer folds into tank_top — distinct subtypes', () => {
  const camisole = canonicalizeSubtype('camisole');
  const tankTop = canonicalizeSubtype('tank top');
  assert.equal(camisole.value, 'camisole');
  assert.equal(tankTop.value, 'tank_top');
  assert.notEqual(camisole.value, tankTop.value);
});

test('SEMANTIC HARDENING: sport coat no longer folds into blazer — distinct subtypes', () => {
  const sportCoat = canonicalizeSubtype('sport coat');
  const blazer = canonicalizeSubtype('blazer');
  assert.equal(sportCoat.value, 'sport_coat');
  assert.equal(blazer.value, 'blazer');
  assert.notEqual(sportCoat.value, blazer.value);
  assert.equal(impliedCategoryFromSubtype(sportCoat.value), 'outerwear');
});

test('SEMANTIC HARDENING: pump is RETAINED as a heel alias (justified: a pump is structurally a heel, not a different shoe)', () => {
  assert.equal(canonicalizeSubtype('pump').value, 'heel');
  assert.equal(canonicalizeSubtype('pumps').value, 'heel');
});

test('SEMANTIC HARDENING: button-down/button-up is RETAINED as a shirt alias (justified: a collar-level detail, not a different base garment)', () => {
  assert.equal(canonicalizeSubtype('button-down').value, 'shirt');
  assert.equal(canonicalizeSubtype('button-up').value, 'shirt');
});

// ── sneaker collar-height: documented information-loss boundary ────────────

test('high-top and low-top sneaker still collapse to one canonical subtype in V1 (documented, not silent)', () => {
  assert.equal(canonicalizeSubtype('low-top sneaker').value, 'sneaker');
  assert.equal(canonicalizeSubtype('high-top sneaker').value, 'sneaker');
});

test('the low-top/high-top distinction survives as raw evidence even though the canonical value collapses', () => {
  const lowTop = canonicalizeSubtype('low-top sneaker');
  const highTop = canonicalizeSubtype('high-top sneaker');
  // Canonical values are identical (the documented V1 collapse)...
  assert.equal(lowTop.value, highTop.value);
  // ...but the raw evidence a consumer would need to recover the
  // distinction is NOT discarded, and is itself distinct.
  assert.equal(lowTop.raw, 'low-top sneaker');
  assert.equal(highTop.raw, 'high-top sneaker');
  assert.notEqual(lowTop.raw, highTop.raw);
});
