'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeColor } = require('../canonicalize');

// ── black vs navy (spec section 9 / 17) ──────────────────────────────────

test('black and navy resolve to different canonical values and different families', () => {
  const black = canonicalizeColor('black');
  const navy = canonicalizeColor('navy blue');
  assert.equal(black.value, 'black');
  assert.equal(navy.value, 'navy');
  assert.notEqual(black.value, navy.value);
  assert.notEqual(black.family, navy.family);
});

test('navy aliases (navy, navy blue, midnight blue) all resolve to the same canonical value', () => {
  for (const raw of ['navy', 'navy blue', 'midnight blue', 'Navy', ' NAVY BLUE ']) {
    assert.equal(canonicalizeColor(raw).value, 'navy', raw);
    assert.equal(canonicalizeColor(raw).family, 'blue', raw);
  }
});

// ── burgundy aliases (spec section 8's own worked example) ───────────────

test('wine, wine red, deep burgundy, burgundy, and oxblood all resolve to the same canonical burgundy value', () => {
  for (const raw of ['wine', 'wine red', 'deep burgundy', 'burgundy', 'oxblood', 'maroon']) {
    const result = canonicalizeColor(raw);
    assert.equal(result.value, 'burgundy', raw);
    assert.equal(result.family, 'red', raw);
  }
});

test('red and burgundy stay genuinely distinct — normalization is not semantic collapse', () => {
  const red = canonicalizeColor('red');
  const burgundy = canonicalizeColor('burgundy');
  assert.equal(red.value, 'red');
  assert.equal(burgundy.value, 'burgundy');
  assert.notEqual(red.value, burgundy.value);
  // Same broad family (both are reds) but distinguishable canonical values.
  assert.equal(red.family, burgundy.family);
});

// ── beige vs tan (spec section 9) ─────────────────────────────────────────

test('beige and tan resolve to different canonical values', () => {
  const beige = canonicalizeColor('beige');
  const tan = canonicalizeColor('tan');
  assert.equal(beige.value, 'beige');
  assert.equal(tan.value, 'tan');
  assert.notEqual(beige.value, tan.value);
});

test('khaki folds into tan (retail color usage), not into beige or green', () => {
  assert.equal(canonicalizeColor('khaki').value, 'tan');
});

test('camel is distinct from both tan and brown', () => {
  const camel = canonicalizeColor('camel');
  assert.equal(camel.value, 'camel');
  assert.notEqual(camel.value, canonicalizeColor('tan').value);
  assert.notEqual(camel.value, canonicalizeColor('brown').value);
});

// ── white vs cream (spec section 9) ───────────────────────────────────────

test('white and cream resolve to different canonical values in the same family', () => {
  const white = canonicalizeColor('white');
  const cream = canonicalizeColor('ivory');
  assert.equal(white.value, 'white');
  assert.equal(cream.value, 'cream');
  assert.notEqual(white.value, cream.value);
  assert.equal(white.family, cream.family);
});

test('off-white and eggshell fold into cream, not white', () => {
  assert.equal(canonicalizeColor('off-white').value, 'cream');
  assert.equal(canonicalizeColor('eggshell').value, 'cream');
});

// ── secondary color uses the same resolver ────────────────────────────────

test('color canonicalization accepts an array (Scanner colors.secondary / Closet secondaryColors)', () => {
  const result = canonicalizeColor(['not-a-color', 'oxblood']);
  assert.equal(result.value, 'burgundy');
  assert.equal(result.family, 'red');
});

test('an unrecognized color stays unknown with no invented family', () => {
  const result = canonicalizeColor('chartreuse-plaid-explosion');
  assert.equal(result.value, null);
  assert.equal(result.family, null);
});
