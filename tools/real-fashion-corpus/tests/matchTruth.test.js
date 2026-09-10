'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MATCH_TRUTH_LEVELS,
  MATCH_TRUTH_DEFINITIONS,
  classifyMatchTruth,
  detectContradictoryMatchSignals,
} = require('../lib/matchTruth');
const { IDENTITY_LEVELS, SUBSTITUTE_LEVELS } = require('../../fashion-match-quality/evaluator/rubric');

test('MATCH TRUTH: the six-level doctrine matches the spec exactly, each with an explicit definition', () => {
  assert.deepEqual([...MATCH_TRUTH_LEVELS], [
    'EXACT_PRODUCT',
    'EXACT_VARIANT',
    'SAME_STYLE_DIFFERENT_VARIANT',
    'USEFUL_SUBSTITUTE',
    'WEAK_SUBSTITUTE',
    'INCORRECT',
  ]);
  for (const level of MATCH_TRUTH_LEVELS) {
    assert.ok(typeof MATCH_TRUTH_DEFINITIONS[level] === 'string' && MATCH_TRUTH_DEFINITIONS[level].length > 0, level);
  }
});

test('MATCH TRUTH: identity EXACT always classifies as EXACT_PRODUCT regardless of substitute level', () => {
  for (const substituteLevel of [...SUBSTITUTE_LEVELS, undefined]) {
    assert.equal(classifyMatchTruth({ identityLevel: 'EXACT', substituteLevel }), 'EXACT_PRODUCT', String(substituteLevel));
  }
});

test('MATCH TRUTH: identity PROBABLE_EXACT always classifies as EXACT_VARIANT', () => {
  for (const substituteLevel of [...SUBSTITUTE_LEVELS, undefined]) {
    assert.equal(classifyMatchTruth({ identityLevel: 'PROBABLE_EXACT', substituteLevel }), 'EXACT_VARIANT', String(substituteLevel));
  }
});

test('MATCH TRUTH: identity WRONG_IDENTITY always classifies as INCORRECT', () => {
  for (const substituteLevel of [...SUBSTITUTE_LEVELS, undefined]) {
    assert.equal(classifyMatchTruth({ identityLevel: 'WRONG_IDENTITY', substituteLevel }), 'INCORRECT', String(substituteLevel));
  }
});

test('MATCH TRUTH: identity UNKNOWN falls through to the substitute axis', () => {
  const expectations = {
    STRONG_SUBSTITUTE: 'SAME_STYLE_DIFFERENT_VARIANT',
    ACCEPTABLE_SUBSTITUTE: 'USEFUL_SUBSTITUTE',
    WEAK_SUBSTITUTE: 'WEAK_SUBSTITUTE',
    UNUSABLE: 'INCORRECT',
  };
  for (const [substituteLevel, expected] of Object.entries(expectations)) {
    assert.equal(classifyMatchTruth({ identityLevel: 'UNKNOWN', substituteLevel }), expected, substituteLevel);
  }
});

test('MATCH TRUTH: no evidence on either axis classifies as null, never a guess', () => {
  assert.equal(classifyMatchTruth({}), null);
  assert.equal(classifyMatchTruth({ identityLevel: 'UNKNOWN', substituteLevel: undefined }), null);
  assert.equal(classifyMatchTruth({ identityLevel: undefined, substituteLevel: null }), null);
});

test('MATCH TRUTH: the full identity x substitute truth table is exhaustively covered', () => {
  for (const identityLevel of IDENTITY_LEVELS) {
    for (const substituteLevel of SUBSTITUTE_LEVELS) {
      const result = classifyMatchTruth({ identityLevel, substituteLevel });
      assert.ok(
        MATCH_TRUTH_LEVELS.includes(result),
        `(${identityLevel}, ${substituteLevel}) produced ${result}, not a valid match-truth level`,
      );
    }
  }
});

test('MATCH TRUTH: contradictory identity/substitute pairs are detected explicitly', () => {
  assert.ok(detectContradictoryMatchSignals({ identityLevel: 'EXACT', substituteLevel: 'UNUSABLE' }));
  assert.ok(detectContradictoryMatchSignals({ identityLevel: 'WRONG_IDENTITY', substituteLevel: 'STRONG_SUBSTITUTE' }));
  assert.equal(detectContradictoryMatchSignals({ identityLevel: 'EXACT', substituteLevel: 'STRONG_SUBSTITUTE' }), null);
  assert.equal(detectContradictoryMatchSignals({ identityLevel: 'UNKNOWN', substituteLevel: 'WEAK_SUBSTITUTE' }), null);
});

test('MATCH TRUTH: classifyMatchTruth never throws, even for a contradictory pair', () => {
  assert.doesNotThrow(() => classifyMatchTruth({ identityLevel: 'EXACT', substituteLevel: 'UNUSABLE' }));
});
