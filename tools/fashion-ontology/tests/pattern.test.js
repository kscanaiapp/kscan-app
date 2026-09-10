'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizePattern } = require('../canonicalize');

// ── semantic hardening pass — plaid/check family split ─────────────────────
//
// The original V1 pass folded plaid/check/tartan/gingham/houndstooth into
// one `plaid_check` value. That was an unsafe collapse: houndstooth's
// broken-check silhouette, gingham's small even two-tone check, and a
// woven multi-color tartan/plaid are visually and commercially distinct
// patterns. See patterns.js's header for the full doctrine.

test('SEMANTIC HARDENING: plaid and tartan merge (justified: near-universal US retail synonym pairing)', () => {
  assert.equal(canonicalizePattern('plaid').value, 'plaid');
  assert.equal(canonicalizePattern('tartan').value, 'plaid');
});

test('SEMANTIC HARDENING: check/checked/checkered merge with each other but stay distinct from plaid', () => {
  for (const raw of ['check', 'checked', 'checkered']) {
    assert.equal(canonicalizePattern(raw).value, 'check', raw);
  }
  assert.notEqual(canonicalizePattern('check').value, canonicalizePattern('plaid').value);
});

test('SEMANTIC HARDENING: gingham is its own canonical pattern, distinct from plaid and generic check', () => {
  const gingham = canonicalizePattern('gingham');
  assert.equal(gingham.value, 'gingham');
  assert.notEqual(gingham.value, canonicalizePattern('plaid').value);
  assert.notEqual(gingham.value, canonicalizePattern('check').value);
});

test('SEMANTIC HARDENING: houndstooth is its own canonical pattern, not plaid/check', () => {
  const houndstooth = canonicalizePattern('houndstooth');
  assert.equal(houndstooth.value, 'houndstooth');
  assert.notEqual(houndstooth.value, canonicalizePattern('plaid').value);
  assert.notEqual(houndstooth.value, canonicalizePattern('check').value);
  assert.notEqual(houndstooth.value, canonicalizePattern('gingham').value);
});

test('SEMANTIC HARDENING: plaid, check, gingham, and houndstooth are four distinct canonical values', () => {
  const values = new Set([
    canonicalizePattern('plaid').value,
    canonicalizePattern('check').value,
    canonicalizePattern('gingham').value,
    canonicalizePattern('houndstooth').value,
  ]);
  assert.equal(values.size, 4);
});

test('SEMANTIC HARDENING: pinstripe is distinct from a generic stripe', () => {
  const pinstripe = canonicalizePattern('pinstripe');
  assert.equal(pinstripe.value, 'pinstripe');
  assert.notEqual(pinstripe.value, canonicalizePattern('stripe').value);
});

test('solid vs unknown pattern: solid resolves, an unrecognized pattern stays unknown', () => {
  assert.equal(canonicalizePattern('solid').value, 'solid');
  assert.equal(canonicalizePattern('plain').value, 'solid');
  assert.equal(canonicalizePattern('some novel print nobody has seen before').value, null);
});

test('the task-listed pattern set each resolve to a distinct canonical value', () => {
  const expectations = {
    solid: 'solid',
    stripe: 'stripe',
    plaid: 'plaid',
    floral: 'floral',
    'polka dot': 'polka_dot',
    'animal print': 'animal_print',
    graphic: 'graphic',
    geometric: 'geometric',
  };
  const seen = new Set();
  for (const [raw, expected] of Object.entries(expectations)) {
    const result = canonicalizePattern(raw);
    assert.equal(result.value, expected, raw);
    seen.add(result.value);
  }
  assert.equal(seen.size, Object.keys(expectations).length, 'each task-listed pattern must be distinct');
});

test('leopard/zebra/snake print all fold into animal_print without losing pattern from category', () => {
  for (const raw of ['leopard', 'leopard print', 'zebra print', 'snake print']) {
    assert.equal(canonicalizePattern(raw).value, 'animal_print', raw);
  }
});

test('an empty/whitespace-only pattern string is unknown, not solid', () => {
  assert.equal(canonicalizePattern('   ').value, null);
  assert.equal(canonicalizePattern('').value, null);
});
