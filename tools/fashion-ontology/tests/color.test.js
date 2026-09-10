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
  for (const raw of ['wine', 'wine red', 'deep burgundy', 'burgundy', 'oxblood', 'bordeaux']) {
    const result = canonicalizeColor(raw);
    assert.equal(result.value, 'burgundy', raw);
    assert.equal(result.family, 'red', raw);
  }
});

// ── semantic hardening pass — hostile-reviewed collapses ──────────────────

test('SEMANTIC HARDENING: maroon is no longer collapsed into burgundy', () => {
  const maroon = canonicalizeColor('maroon');
  assert.equal(maroon.value, 'maroon');
  assert.notEqual(maroon.value, 'burgundy');
  // Still the same broad family — related, not identical.
  assert.equal(maroon.family, 'red');
});

test('SEMANTIC HARDENING: oxblood is RETAINED as a burgundy alias (justified: leather-goods naming variant of the same hue, not a distinct shade)', () => {
  assert.equal(canonicalizeColor('oxblood').value, 'burgundy');
});

test('SEMANTIC HARDENING: gold is a distinct metallic canonical color, not a yellow alias', () => {
  const gold = canonicalizeColor('gold');
  assert.equal(gold.value, 'gold');
  assert.notEqual(gold.value, 'yellow');
  assert.equal(canonicalizeColor('yellow').value, 'yellow');
});

test('SEMANTIC HARDENING: "print" is not a color alias at all', () => {
  const result = canonicalizeColor('print');
  assert.equal(result.value, null);
  assert.equal(result.family, null);
  assert.notEqual(result.value, 'multicolor');
});

test('SEMANTIC HARDENING: lavender/lilac split from purple, but merge with each other', () => {
  const lavender = canonicalizeColor('lavender');
  const lilac = canonicalizeColor('lilac');
  const purple = canonicalizeColor('purple');
  assert.equal(lavender.value, 'lavender');
  assert.equal(lilac.value, 'lavender');
  assert.notEqual(lavender.value, purple.value);
  assert.equal(lavender.family, purple.family);
});

test('SEMANTIC HARDENING: charcoal is a distinct dark-grey value, not folded into grey', () => {
  const charcoal = canonicalizeColor('charcoal');
  assert.equal(charcoal.value, 'charcoal');
  assert.notEqual(charcoal.value, 'grey');
  assert.equal(charcoal.family, 'grey');
});

test('SEMANTIC HARDENING: rust/terracotta split from orange, but merge with each other', () => {
  const rust = canonicalizeColor('rust');
  const terracotta = canonicalizeColor('terracotta');
  const orange = canonicalizeColor('orange');
  assert.equal(rust.value, 'rust');
  assert.equal(terracotta.value, 'rust');
  assert.notEqual(rust.value, orange.value);
  assert.equal(rust.family, orange.family);
});

test('SEMANTIC HARDENING: emerald and forest green split from green and from each other', () => {
  const green = canonicalizeColor('green');
  const emerald = canonicalizeColor('emerald');
  const forest = canonicalizeColor('forest green');
  const values = new Set([green.value, emerald.value, forest.value]);
  assert.equal(values.size, 3, 'green/emerald/forest_green must not collapse into each other');
  assert.equal(green.family, emerald.family);
  assert.equal(green.family, forest.family);
});

test('SEMANTIC HARDENING: royal blue/cobalt split from blue, but merge with each other', () => {
  const royal = canonicalizeColor('royal blue');
  const cobalt = canonicalizeColor('cobalt');
  const blue = canonicalizeColor('blue');
  assert.equal(royal.value, 'royal_blue');
  assert.equal(cobalt.value, 'royal_blue');
  assert.notEqual(royal.value, blue.value);
  assert.equal(royal.family, blue.family);
});

test('SEMANTIC HARDENING: blush/rose split from pink, but merge with each other', () => {
  const blush = canonicalizeColor('blush');
  const rose = canonicalizeColor('rose');
  const pink = canonicalizeColor('pink');
  assert.equal(blush.value, 'blush');
  assert.equal(rose.value, 'blush');
  assert.notEqual(blush.value, pink.value);
  assert.equal(blush.family, pink.family);
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
