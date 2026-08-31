'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRegression } = require('../../security/scripts/lib/regression-diff');

// Staging Gate V2 spec, Section 4/12 — CASE 1-5 worked examples verbatim.

test('CASE 1: BASE {A,B} HEAD {A,B} -> PASS, no new/resolved', () => {
  const result = computeRegression(['A', 'B'], ['A', 'B']);
  assert.deepEqual(result.newFailures, []);
  assert.deepEqual(result.resolvedFailures, []);
  assert.deepEqual(result.unchangedFailures, ['A', 'B']);
  assert.equal(result.outcome, 'PASS_PRE_EXISTING_BASE_FAILURE');
});

test('CASE 2: BASE {A,B} HEAD {A,B,C} -> BLOCK on C', () => {
  const result = computeRegression(['A', 'B'], ['A', 'B', 'C']);
  assert.deepEqual(result.newFailures, ['C']);
  assert.deepEqual(result.resolvedFailures, []);
  assert.equal(result.outcome, 'BLOCK_NEW_REGRESSION');
});

test('CASE 3: BASE {A,B} HEAD {A,C} -> BLOCK on C, RESOLVED B', () => {
  const result = computeRegression(['A', 'B'], ['A', 'C']);
  assert.deepEqual(result.newFailures, ['C']);
  assert.deepEqual(result.resolvedFailures, ['B']);
  assert.equal(result.outcome, 'BLOCK_NEW_REGRESSION');
});

test('CASE 4: BASE {A} HEAD {} -> PASS + RESOLVED', () => {
  const result = computeRegression(['A'], []);
  assert.deepEqual(result.newFailures, []);
  assert.deepEqual(result.resolvedFailures, ['A']);
  assert.deepEqual(result.unchangedFailures, []);
  assert.equal(result.outcome, 'PASS');
});

test('CASE (implicit): BASE {} HEAD {} -> clean PASS, not the pre-existing-debt variant', () => {
  const result = computeRegression([], []);
  assert.equal(result.outcome, 'PASS');
});

test('policy compares failure identity, not just counts', () => {
  // BASE {A,B} (2 failures) HEAD {C,D} (2 failures) — same count, all new.
  const result = computeRegression(['A', 'B'], ['C', 'D']);
  assert.deepEqual(result.newFailures, ['C', 'D']);
  assert.deepEqual(result.resolvedFailures, ['A', 'B']);
  assert.equal(result.outcome, 'BLOCK_NEW_REGRESSION');
});

test('order of input arrays does not affect the computed sets', () => {
  const a = computeRegression(['B', 'A'], ['A', 'C', 'B']);
  const b = computeRegression(['A', 'B'], ['C', 'B', 'A']);
  assert.deepEqual(a, b);
});

test('duplicate identifiers in input do not produce duplicate output entries', () => {
  const result = computeRegression(['A', 'A'], ['A', 'C', 'C']);
  assert.deepEqual(result.newFailures, ['C']);
  assert.deepEqual(result.unchangedFailures, ['A']);
});
