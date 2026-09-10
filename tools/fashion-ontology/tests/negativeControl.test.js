'use strict';

/**
 * Negative-control anchor (spec section 15).
 *
 * These specific assertions are the ones exercised during the negative
 * control recorded in the PR evidence: `colors.js`'s `burgundy` alias entry
 * for `'wine'` was temporarily mutated to point at `'red'` instead, this
 * suite was rerun and shown to fail on exactly the assertion below, and the
 * mutation was then reverted and the suite rerun green again. See the PR
 * description's NEGATIVE CONTROL section for the exact commands and output.
 *
 * This file is not the mutation itself — no mutation ships in the
 * committed code. It exists so the specific case used as the negative
 * control has a permanent, named regression test, not just an ephemeral
 * manual check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeColor, canonicalizeSubtype } = require('../canonicalize');

test('NEGATIVE CONTROL ANCHOR: "wine" must resolve to burgundy, not red', () => {
  const result = canonicalizeColor('wine');
  assert.equal(result.value, 'burgundy');
  assert.notEqual(result.value, 'red');
});

test('NEGATIVE CONTROL ANCHOR: "flight jacket" must resolve to bomber_jacket, not chore_jacket', () => {
  const result = canonicalizeSubtype('flight jacket');
  assert.equal(result.value, 'bomber_jacket');
  assert.notEqual(result.value, 'chore_jacket');
});
