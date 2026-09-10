'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeMaterial } = require('../canonicalize');

// ── leather vs faux leather vs suede (spec section 10's own example) ─────

test('leather, faux leather, and suede are three distinct canonical materials', () => {
  const leather = canonicalizeMaterial('leather');
  const faux = canonicalizeMaterial('faux leather');
  const suede = canonicalizeMaterial('suede');
  assert.equal(leather.value, 'leather');
  assert.equal(faux.value, 'faux_leather');
  assert.equal(suede.value, 'suede');
  const values = new Set([leather.value, faux.value, suede.value]);
  assert.equal(values.size, 3, 'leather/faux_leather/suede must not collapse into each other');
});

test('lambskin and genuine leather fold into leather, never into faux_leather', () => {
  assert.equal(canonicalizeMaterial('lambskin').value, 'leather');
  assert.equal(canonicalizeMaterial('genuine leather').value, 'leather');
});

test('vegan leather and pleather fold into faux_leather, never into leather', () => {
  assert.equal(canonicalizeMaterial('vegan leather').value, 'faux_leather');
  assert.equal(canonicalizeMaterial('pleather').value, 'faux_leather');
});

// ── remaining task-listed materials resolve ───────────────────────────────

test('denim, cotton, wool, silk, and polyester each resolve to their own canonical value', () => {
  const expectations = {
    denim: 'denim',
    'cotton twill': 'cotton',
    'merino wool': 'wool',
    silk: 'silk',
    polyester: 'polyester',
  };
  for (const [raw, expected] of Object.entries(expectations)) {
    assert.equal(canonicalizeMaterial(raw).value, expected, raw);
  }
});

// ── unknown material stays representable without claiming certainty ──────

test('an unrecognized material stays unknown rather than being forced into the nearest known value', () => {
  const result = canonicalizeMaterial('recycled ocean plastic blend');
  assert.equal(result.value, null);
  assert.equal(result.raw, 'recycled ocean plastic blend');
});

test('a visually-inferred but unconfirmed material can still be represented as unknown, preserving the raw observation', () => {
  const result = canonicalizeMaterial('looks like some kind of synthetic');
  assert.equal(result.value, null);
  assert.notEqual(result.raw, null);
});
