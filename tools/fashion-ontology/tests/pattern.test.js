'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizePattern } = require('../canonicalize');

test('plaid/check terminology all resolves to one canonical value', () => {
  for (const raw of ['plaid', 'check', 'checked', 'checkered', 'tartan', 'gingham', 'houndstooth']) {
    assert.equal(canonicalizePattern(raw).value, 'plaid_check', raw);
  }
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
    plaid: 'plaid_check',
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
