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
