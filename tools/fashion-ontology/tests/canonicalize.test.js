'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRawString,
  canonicalizeCategory,
  canonicalizeSubtype,
  canonicalizeColor,
  canonicalizeSilhouette,
  canonicalizeMaterial,
  canonicalizePattern,
  canonicalizeFashionAttributes,
  impliedCategoryFromSubtype,
} = require('../canonicalize');
const { listAllAliases } = require('../aliases');

// ── Determinism ──────────────────────────────────────────────────────────

test('aliases resolve identically across repeated calls', () => {
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(canonicalizeColor('wine'), { value: 'burgundy', family: 'red', raw: 'wine' });
    assert.deepEqual(canonicalizeSubtype('flight jacket'), { value: 'bomber_jacket', raw: 'flight jacket' });
  }
});

test('every registered alias resolves to a stable canonical value across two independent runs', () => {
  const first = listAllAliases();
  const second = listAllAliases();
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});

test('canonical values are stable: canonicalizing a resolved canonical value returns itself', () => {
  assert.equal(canonicalizeMaterial('leather').value, 'leather');
  assert.equal(canonicalizeMaterial(canonicalizeMaterial('lambskin').value).value, 'leather');
  assert.equal(canonicalizePattern(canonicalizePattern('plaid').value).value, 'plaid');
});

// ── Case / whitespace normalization ─────────────────────────────────────

test('case and whitespace normalization does not alter semantic output', () => {
  const variants = ['Wine', ' wine ', 'WINE', 'wine\t', 'Wine   Red', '  WINE RED  '];
  for (const variant of variants) {
    const result = canonicalizeColor(variant);
    assert.equal(result.value, 'burgundy', `variant ${JSON.stringify(variant)} did not resolve`);
  }
  assert.equal(normalizeRawString('  Bomber   Jacket  '), 'bomber jacket');
});

// ── Unknown handling ─────────────────────────────────────────────────────

test('unknown values remain unknown rather than guessed', () => {
  assert.equal(canonicalizeCategory('spacesuit').value, null);
  assert.equal(canonicalizeMaterial('unobtainium').value, null);
  assert.equal(canonicalizeColor('flumberry').value, null);
  assert.equal(canonicalizeColor('flumberry').family, null);
});

test('Scanner-style unknown sentinels are treated as absent, not as a canonical value', () => {
  for (const token of ['unknown', 'UNKNOWN', 'n/a', 'none', 'null', 'not specified', '']) {
    assert.equal(canonicalizeMaterial(token).value, null, token);
    assert.equal(canonicalizeMaterial(token).raw, null, token);
  }
});

test('an absent field in canonicalizeFashionAttributes stays unknown, not guessed', () => {
  const record = canonicalizeFashionAttributes({ category: 'top' });
  assert.equal(record.subtype.value, null);
  assert.equal(record.primaryColor.value, null);
  assert.equal(record.material.value, null);
});

// ── Malformed input never becomes valid ──────────────────────────────────

test('malformed values do not silently become valid taxonomy values', () => {
  for (const bad of [42, true, {}, Symbol('x'), () => {}]) {
    assert.equal(canonicalizeCategory(bad).value, null);
  }
  assert.equal(canonicalizeCategory(null).value, null);
  assert.equal(canonicalizeCategory(undefined).value, null);
});

test('canonicalizeFashionAttributes never throws on a hostile input shape', () => {
  for (const bad of [null, undefined, 'nope', 42, [], true, { category: { nested: true } }]) {
    assert.doesNotThrow(() => canonicalizeFashionAttributes(bad));
  }
});

// ── Array resolution (Scanner/Closet secondary-color and multi-value fields) ─

test('an array resolves to the first alias-recognized entry, in order', () => {
  const result = canonicalizeMaterial(['unobtainium', 'faux leather', 'leather']);
  assert.equal(result.value, 'faux_leather');
  assert.equal(result.raw, 'faux leather');
});

test('an array with no recognized entries stays unknown but preserves the first raw candidate', () => {
  const result = canonicalizeSilhouette(['unobtainium', 'also-unknown']);
  assert.equal(result.value, null);
  assert.equal(result.raw, 'unobtainium');
});

test('an empty array is unknown, not an error', () => {
  assert.equal(canonicalizeMaterial([]).value, null);
});

// ── Subtype implies category ─────────────────────────────────────────────

test('a resolved subtype exposes its parent category', () => {
  const subtype = canonicalizeSubtype('bomber');
  assert.equal(subtype.value, 'bomber_jacket');
  assert.equal(impliedCategoryFromSubtype(subtype.value), 'outerwear');
});

test('an unresolved subtype implies no category', () => {
  assert.equal(impliedCategoryFromSubtype(null), null);
  assert.equal(impliedCategoryFromSubtype('not_a_real_subtype'), null);
});
