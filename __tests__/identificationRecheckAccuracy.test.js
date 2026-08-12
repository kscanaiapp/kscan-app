/**
 * Phase 7.1 — accuracy-movement evaluator arithmetic (Node).
 *
 * The evaluator is the instrument that will decide whether the recheck ships.
 * An instrument that miscounts is worse than no instrument, so its arithmetic is
 * tested against hand-computed fixtures — including the cases where a naive
 * accuracy number would give the wrong answer.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluate,
  grade,
  canon,
  movementKey,
} = require('../scripts/identification-recheck-accuracy.js');

const T = (category, clothingType, subtype) => ({ category, clothingType, subtype });

test('canon: separator- and case-insensitive, folds declines to null', () => {
  assert.equal(canon('Wide Leg Jeans'), 'wide leg jeans');
  assert.equal(canon('wide_leg_jeans'), 'wide leg jeans');
  assert.equal(canon('wide-leg-jeans'), 'wide leg jeans');
  assert.equal(canon('unknown'), null);
  assert.equal(canon('  '), null);
  assert.equal(canon(null), null);
});

test('grade: abstention is a third state, never a wrong answer', () => {
  assert.equal(grade('jeans', 'jeans'), 'correct');
  assert.equal(grade('chino', 'jeans'), 'incorrect');
  assert.equal(grade(null, 'jeans'), 'unknown');
  assert.equal(grade('unknown', 'jeans'), 'unknown');
});

test('movementKey: identity transitions collapse to unchanged buckets', () => {
  assert.equal(movementKey('correct', 'correct'), 'unchanged correct');
  assert.equal(movementKey('incorrect', 'correct'), 'incorrect->correct');
  assert.equal(movementKey('correct', 'unknown'), 'correct->unknown');
});

test('net promotion metric is corrections minus reversals, per tier', () => {
  const result = evaluate([
    // A real correction on subtype.
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'skinny_jeans'),
      candidate: T('pants', 'jeans', 'wide_leg_jeans'),
    },
    // A harmful reversal on subtype.
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'skinny_jeans'),
    },
    // A second real correction.
    {
      truth: T('top', 'blouse', 'silk_blouse'),
      control: T('top', 'blouse', 'cotton_blouse'),
      candidate: T('top', 'blouse', 'silk_blouse'),
    },
  ]);

  const subtype = result.perTier.subtype;
  assert.equal(subtype.movements['incorrect->correct'], 2);
  assert.equal(subtype.movements['correct->incorrect'], 1);
  assert.equal(subtype.net, 1);

  // Untouched tiers must contribute nothing to the net.
  assert.equal(result.perTier.category.net, 0);
  assert.equal(result.perTier.clothingType.net, 0);

  assert.equal(result.totals.net, 1);
  assert.equal(result.verdict, 'NET_POSITIVE');
  assert.equal(result.promotionRecommended, true);
});

test('more reversals than corrections blocks promotion', () => {
  const result = evaluate([
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'skinny_jeans'),
    },
    {
      truth: T('top', 'blouse', 'silk_blouse'),
      control: T('top', 'blouse', 'silk_blouse'),
      candidate: T('top', 'blouse', 'cotton_blouse'),
    },
    {
      truth: T('pants', 'chino', 'slim_chino'),
      control: T('pants', 'chino', 'wide_chino'),
      candidate: T('pants', 'chino', 'slim_chino'),
    },
  ]);
  assert.equal(result.perTier.subtype.net, -1);
  assert.equal(result.verdict, 'NET_NEGATIVE');
  assert.equal(result.promotionRecommended, false);
});

test('abstention does not inflate accuracy-among-answered unnoticed', () => {
  // The candidate abstains on every wrong answer. Accuracy AMONG ANSWERED
  // becomes a perfect 100% while the answer rate collapses — the exact way a
  // "more accurate" claim can be manufactured by answering less.
  const result = evaluate([
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'skinny_jeans'),
      candidate: T('pants', 'jeans', null),
    },
    {
      truth: T('top', 'blouse', 'silk_blouse'),
      control: T('top', 'blouse', 'cotton_blouse'),
      candidate: T('top', 'blouse', null),
    },
    {
      truth: T('pants', 'chino', 'slim_chino'),
      control: T('pants', 'chino', 'slim_chino'),
      candidate: T('pants', 'chino', 'slim_chino'),
    },
  ]);
  const s = result.perTier.subtype;

  assert.equal(s.candidateAccuracyAnswered, 1);           // flattering
  assert.equal(s.controlAccuracyAnswered, 1 / 3);
  assert.equal(s.candidateAnswerRate, 1 / 3);             // the correction
  assert.equal(s.controlAnswerRate, 1);
  // And accuracy over ALL scorable cases is unchanged, which is the honest read.
  assert.equal(s.controlAccuracyAll, 1 / 3);
  assert.equal(s.candidateAccuracyAll, 1 / 3);
  // Discarding two wrong answers is recorded as a gain, not a loss.
  assert.equal(s.abstentionsFromIncorrect, 2);
  assert.equal(s.abstentionsFromCorrect, 0);
  // Net stays 0: abstention is neither a correction nor a reversal.
  assert.equal(s.net, 0);
  assert.equal(result.verdict, 'NET_NEUTRAL');
  assert.equal(result.promotionRecommended, false);
});

test('cases without ground truth are excluded and reported, not silently dropped', () => {
  const result = evaluate([
    {
      truth: T('pants', 'jeans', null),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'skinny_jeans'),
    },
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'wide_leg_jeans'),
    },
  ]);
  const s = result.perTier.subtype;
  assert.equal(s.scorable, 1);
  assert.equal(s.unscorable, 1);
  // The unscorable case contributes to no movement bucket at all.
  const total = Object.values(s.movements).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
});

test('unknown→correct and unknown→incorrect are tracked separately', () => {
  const result = evaluate([
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', null),
      candidate: T('pants', 'jeans', 'wide_leg_jeans'),
    },
    {
      truth: T('top', 'blouse', 'silk_blouse'),
      control: T('top', 'blouse', null),
      candidate: T('top', 'blouse', 'cotton_blouse'),
    },
  ]);
  const s = result.perTier.subtype;
  assert.equal(s.movements['unknown->correct'], 1);
  assert.equal(s.movements['unknown->incorrect'], 1);
  // Filling blanks is neither a correction nor a reversal, so net stays 0 —
  // new specificity has to be judged on its own two counters.
  assert.equal(s.net, 0);
});

test('cost accounting sums tokens, calls and MAX_TOKENS finishes', () => {
  const result = evaluate([
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'wide_leg_jeans'),
      recheckTriggered: true,
      controlCost: {
        latencyMs: 1000, inputTokens: 900, responseTokens: 400,
        thinkingTokens: 300, providerCalls: 1, finishReason: 'STOP',
      },
      candidateCost: {
        latencyMs: 1800, inputTokens: 1800, responseTokens: 440,
        thinkingTokens: 420, providerCalls: 2, finishReason: 'MAX_TOKENS',
      },
    },
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'wide_leg_jeans'),
      candidate: T('pants', 'jeans', 'wide_leg_jeans'),
      recheckTriggered: false,
      controlCost: {
        latencyMs: 1200, inputTokens: 800, responseTokens: 380,
        thinkingTokens: 260, providerCalls: 1, finishReason: 'STOP',
      },
      candidateCost: {
        latencyMs: 1250, inputTokens: 800, responseTokens: 380,
        thinkingTokens: 260, providerCalls: 1, finishReason: 'STOP',
      },
    },
  ]);

  assert.equal(result.cost.control.providerCallsTotal, 2);
  assert.equal(result.cost.candidate.providerCallsTotal, 3);
  assert.equal(result.cost.control.thinkingTokensTotal, 560);
  assert.equal(result.cost.candidate.thinkingTokensTotal, 680);
  assert.equal(result.cost.candidateMaxTokensCount, 1);
  assert.equal(result.cost.controlMaxTokensCount, 0);
  // Trigger rate is the denominator that tells a targeted escalation apart
  // from a blanket cost increase.
  assert.equal(result.recheckTriggeredCount, 1);
  assert.equal(result.recheckTriggerRate, 0.5);
});

// ── Phase 7.2: brand precision ──────────────────────────────────────────────

const TB = (category, clothingType, subtype, brand) => ({
  category,
  clothingType,
  subtype,
  brand,
});

test('brand precision is correct/asserted, not correct/total', () => {
  const result = evaluate([
    // Candidate asserts a correct brand the control missed.
    {
      truth: TB('pants', 'jeans', 'wide_leg_jeans', "Levi's"),
      control: TB('pants', 'jeans', 'wide_leg_jeans', null),
      candidate: TB('pants', 'jeans', 'wide_leg_jeans', "Levi's"),
    },
    // Candidate drops a brand the control got WRONG — a precision gain.
    {
      truth: TB('top', 'hoodie', null, 'Nike'),
      control: TB('top', 'hoodie', null, 'Adidas'),
      candidate: TB('top', 'hoodie', null, null),
    },
  ]);
  const b = result.brand;
  assert.equal(b.scorable, 2);
  assert.equal(b.candidateCorrectAssertions, 1);
  assert.equal(b.candidateIncorrectAssertions, 0);
  assert.equal(b.candidatePrecision, 1);
  assert.equal(b.controlPrecision, 0);
  assert.equal(b.incorrectToUnknown, 1);
  assert.equal(b.unknownToCorrect, 1);
  assert.equal(b.falseAssertionDelta, -1);
  assert.equal(result.brandVerdict, 'BRAND_PRECISION_IMPROVED');
});

test('filling MORE brand fields is not scored as better when they are wrong', () => {
  // The exact claim §22 forbids: the candidate answers brand far more often,
  // and is wrong most of the time.
  const result = evaluate([
    {
      truth: TB('pants', 'jeans', 'wide_leg_jeans', "Levi's"),
      control: TB('pants', 'jeans', 'wide_leg_jeans', null),
      candidate: TB('pants', 'jeans', 'wide_leg_jeans', 'Wrangler'),
    },
    {
      truth: TB('top', 'hoodie', null, 'Nike'),
      control: TB('top', 'hoodie', null, null),
      candidate: TB('top', 'hoodie', null, 'Adidas'),
    },
    {
      truth: TB('footwear', 'sneaker', null, 'Nike'),
      control: TB('footwear', 'sneaker', null, null),
      candidate: TB('footwear', 'sneaker', null, 'Nike'),
    },
  ]);
  const b = result.brand;
  // Answer rate went UP...
  assert.equal(b.controlAnswerRate, 0);
  assert.equal(b.candidateAnswerRate, 1);
  // ...and precision is poor, with two false brands introduced.
  assert.equal(b.candidatePrecision, 1 / 3);
  assert.equal(b.unknownToIncorrect, 2);
  assert.equal(b.falseAssertionDelta, 2);
  assert.equal(result.brandVerdict, 'BRAND_PRECISION_REGRESSED');
  assert.equal(result.promotionRecommended, false);
});

test('a brand-precision regression blocks promotion even when fashion improves', () => {
  const result = evaluate([
    // Fashion genuinely improves...
    {
      truth: TB('pants', 'jeans', 'wide_leg_jeans', 'Nike'),
      control: TB('pants', 'jeans', 'skinny_jeans', 'Nike'),
      candidate: TB('pants', 'jeans', 'wide_leg_jeans', 'Adidas'),
    },
  ]);
  assert.equal(result.perTier.subtype.net, 1);
  assert.equal(result.verdict, 'NET_POSITIVE');
  // ...but a correct brand was replaced with a wrong one.
  assert.equal(result.brand.correctToIncorrect, 1);
  assert.equal(result.brand.falseAssertionDelta, 1);
  assert.equal(result.promotionRecommended, false);
});

test('cases with no ground-truth brand are excluded, not scored as "should be unknown"', () => {
  const result = evaluate([
    {
      truth: TB('pants', 'jeans', 'wide_leg_jeans', null),
      control: TB('pants', 'jeans', 'wide_leg_jeans', null),
      candidate: TB('pants', 'jeans', 'wide_leg_jeans', null),
    },
    {
      truth: TB('top', 'hoodie', null, 'Nike'),
      control: TB('top', 'hoodie', null, 'Nike'),
      candidate: TB('top', 'hoodie', null, 'Nike'),
    },
  ]);
  assert.equal(result.brand.scorable, 1);
  assert.equal(result.brand.unscorable, 1);
  const total = Object.values(result.brand.movements).reduce((a, x) => a + x, 0);
  assert.equal(total, 1);
});

test('brand comparison is case- and punctuation-insensitive', () => {
  const result = evaluate([
    {
      truth: TB('pants', 'jeans', null, "Levi's"),
      control: TB('pants', 'jeans', null, "LEVI'S"),
      candidate: TB('pants', 'jeans', null, "levi's"),
    },
  ]);
  assert.equal(result.brand.movements['unchanged correct'], 1);
  assert.equal(result.brand.falseAssertionDelta, 0);
});

test('a tier-blind blended score cannot hide cross-tier damage', () => {
  // Subtype improves twice; category is corrupted twice. A single blended
  // accuracy number would read as "unchanged" — per-tier nets do not.
  const result = evaluate([
    {
      truth: T('pants', 'jeans', 'wide_leg_jeans'),
      control: T('pants', 'jeans', 'skinny_jeans'),
      candidate: T('footwear', 'jeans', 'wide_leg_jeans'),
    },
    {
      truth: T('top', 'blouse', 'silk_blouse'),
      control: T('top', 'blouse', 'cotton_blouse'),
      candidate: T('footwear', 'blouse', 'silk_blouse'),
    },
  ]);
  assert.equal(result.perTier.subtype.net, 2);
  assert.equal(result.perTier.category.net, -2);
  assert.equal(result.totals.net, 0);
  assert.equal(result.verdict, 'NET_NEUTRAL');
  assert.equal(result.promotionRecommended, false);
});
