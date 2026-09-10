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

test('wide leg and flare fold into the same bottom silhouette', () => {
  assert.equal(canonicalizeSilhouette('wide leg').value, 'wide_leg');
  assert.equal(canonicalizeSilhouette('flared').value, 'wide_leg');
});

test('an unrecognized silhouette stays unknown', () => {
  assert.equal(canonicalizeSilhouette('avant-garde deconstructed asymmetry').value, null);
});
