'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeSilhouette } = require('../canonicalize');

test('CPI-evidenced jacket silhouettes each resolve to a distinct canonical value', () => {
  const expectations = { cropped: 'cropped', oversized: 'oversized', fitted: 'fitted', boxy: 'boxy' };
  const seen = new Set();
  for (const [raw, expected] of Object.entries(expectations)) {
    const result = canonicalizeSilhouette(raw);
    assert.equal(result.value, expected, raw);
    seen.add(result.value);
  }
  assert.equal(seen.size, 4);
});

test('a-line and bodycon (dress silhouettes) resolve and stay distinct', () => {
  assert.equal(canonicalizeSilhouette('a-line').value, 'a_line');
  assert.equal(canonicalizeSilhouette('bodycon').value, 'bodycon');
  assert.notEqual(canonicalizeSilhouette('a-line').value, canonicalizeSilhouette('bodycon').value);
});

// ── semantic hardening pass — silhouette doctrine ───────────────────────────
//
// wide leg / flare / straight / skinny must not collapse unless truly the
// same cut. A flared leg widens progressively from the knee; a wide-leg is
// uniformly wide from hip to hem — different cuts.

test('SEMANTIC HARDENING: wide leg and flare no longer fold together — distinct cuts', () => {
  const wideLeg = canonicalizeSilhouette('wide leg');
  const flare = canonicalizeSilhouette('flared');
  assert.equal(wideLeg.value, 'wide_leg');
  assert.equal(flare.value, 'flare');
  assert.notEqual(wideLeg.value, flare.value);
});

test('SEMANTIC HARDENING: flare and flared are the same canonical value', () => {
  assert.equal(canonicalizeSilhouette('flare').value, 'flare');
  assert.equal(canonicalizeSilhouette('flared').value, 'flare');
});

test('SEMANTIC HARDENING: wide_leg, flare, straight, and skinny are four distinct silhouettes', () => {
  const values = new Set([
    canonicalizeSilhouette('wide leg').value,
    canonicalizeSilhouette('flare').value,
    canonicalizeSilhouette('straight').value,
    canonicalizeSilhouette('skinny').value,
  ]);
  assert.equal(values.size, 4);
});

test('SEMANTIC HARDENING: tailored no longer folds into fitted — distinct concepts', () => {
  const tailored = canonicalizeSilhouette('tailored');
  const fitted = canonicalizeSilhouette('fitted');
  assert.equal(tailored.value, 'tailored');
  assert.equal(fitted.value, 'fitted');
  assert.notEqual(tailored.value, fitted.value);
});

test('SEMANTIC HARDENING: slim fit still merges with fitted (justified: same body-closeness concept)', () => {
  assert.equal(canonicalizeSilhouette('slim fit').value, 'fitted');
});

test('an unrecognized silhouette stays unknown', () => {
  assert.equal(canonicalizeSilhouette('avant-garde deconstructed asymmetry').value, null);
});
