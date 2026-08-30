'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideOutcome } = require('../../security/scripts/run-project-checks-regression');

function result(identifiers, crashed = false, crashDetail = null) {
  return { identifiers, crashed, crashDetail };
}

test('no failures at base or head -> PASS', () => {
  const outcome = decideOutcome({ baseResult: result([]), headResult: result([]) });
  assert.equal(outcome.outcome, 'PASS');
  assert.deepEqual(outcome.newFailures, []);
});

test('same failures at base and head -> PASS_PRE_EXISTING_BASE_FAILURE, never NEW_REGRESSION', () => {
  const outcome = decideOutcome({
    baseResult: result(['test:privacy :: a', 'test:security :: b']),
    headResult: result(['test:privacy :: a', 'test:security :: b']),
  });
  assert.equal(outcome.outcome, 'PASS_PRE_EXISTING_BASE_FAILURE');
  assert.deepEqual(outcome.newFailures, []);
  assert.deepEqual(outcome.unchangedFailures, ['test:privacy :: a', 'test:security :: b']);
});

test('a genuinely new failure at head -> NEW_REGRESSION, naming only the new one', () => {
  const outcome = decideOutcome({
    baseResult: result(['test:privacy :: a']),
    headResult: result(['test:privacy :: a', 'test:security :: c']),
  });
  assert.equal(outcome.outcome, 'NEW_REGRESSION');
  assert.deepEqual(outcome.newFailures, ['test:security :: c']);
});

test('a pre-existing failure disappearing at head alongside an unrelated new one still blocks on the new one', () => {
  const outcome = decideOutcome({
    baseResult: result(['test:privacy :: a', 'test:security :: b']),
    headResult: result(['test:privacy :: a', 'test:security :: c']),
  });
  assert.equal(outcome.outcome, 'NEW_REGRESSION');
  assert.deepEqual(outcome.newFailures, ['test:security :: c']);
  assert.deepEqual(outcome.resolvedFailures, ['test:security :: b']);
});

test('base run crashing (fail-closed) -> CI_OPERATIONAL_FAILURE, never a silent pass', () => {
  const outcome = decideOutcome({
    baseResult: result([], true, 'npm ci failed'),
    headResult: result([]),
  });
  assert.equal(outcome.outcome, 'CI_OPERATIONAL_FAILURE');
  assert.match(outcome.detail, /npm ci failed/);
});

test('head run crashing (fail-closed) -> CI_OPERATIONAL_FAILURE even if base was clean', () => {
  const outcome = decideOutcome({
    baseResult: result([]),
    headResult: result([], true, 'unparseable output for test:security (exit 1, reported fail=2)'),
  });
  assert.equal(outcome.outcome, 'CI_OPERATIONAL_FAILURE');
});

test('a fully resolved pre-existing failure with nothing new -> PASS', () => {
  const outcome = decideOutcome({
    baseResult: result(['test:privacy :: a']),
    headResult: result([]),
  });
  assert.equal(outcome.outcome, 'PASS');
  assert.deepEqual(outcome.resolvedFailures, ['test:privacy :: a']);
});
