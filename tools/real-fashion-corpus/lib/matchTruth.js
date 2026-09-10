'use strict';

/**
 * Match-truth doctrine (Real Fashion Corpus V2, spec section 10).
 *
 * "Fashion truth" (what garment is visible - see lib/ontology.js) and
 * "identity truth" (what exact product/variant is known - see groundTruth.*
 * in recordSchema.js) are properties of the GARMENT alone. Match truth is
 * different: it grades a CANDIDATE RESULT against the garment, so it is a
 * property of a (garment, candidate) pair, evaluated at scoring time - not a
 * static label a corpus record can carry up front.
 *
 * Fashion Match Quality (`tools/fashion-match-quality/`) remains the sole
 * match-quality authority (spec section 17 - "do not create a competing
 * scorer"). This module does not re-score anything; it deterministically
 * TRANSLATES FMQ's own two-axis output (identity level + substitute level,
 * from `evaluator/rubric.js`) into the shared six-level vocabulary below, so
 * every future evaluator (FMQ today, FashionCLIP's evaluation harness later)
 * reports results in one consistent doctrine instead of inventing its own
 * interpretation of "how good was this result" (spec section 10's explicit
 * requirement).
 */

const MATCH_TRUTH_LEVELS = Object.freeze([
  'EXACT_PRODUCT',
  'EXACT_VARIANT',
  'SAME_STYLE_DIFFERENT_VARIANT',
  'USEFUL_SUBSTITUTE',
  'WEAK_SUBSTITUTE',
  'INCORRECT',
]);

/** Explicit, reviewed definitions - no evaluator may invent its own reading. */
const MATCH_TRUTH_DEFINITIONS = Object.freeze({
  EXACT_PRODUCT: 'The candidate is the identical SKU/product as the target garment (same style, same colorway).',
  EXACT_VARIANT:
    'The candidate is confidently the same product/style as the target, with residual uncertainty only at the ' +
    'exact SKU or colorway level (e.g. right style, unconfirmed exact variant).',
  SAME_STYLE_DIFFERENT_VARIANT:
    'The candidate is a strong, same-style match whose exact product identity was never established, but nothing ' +
    'contradicts it being the right style in a different variant (color/size/etc).',
  USEFUL_SUBSTITUTE:
    'Not confirmed as the same product or style, but a shopper would reasonably consider the candidate a useful ' +
    'stand-in for the target garment.',
  WEAK_SUBSTITUTE:
    'A marginal result - shares some attributes with the target but is a poor stand-in a shopper would likely ' +
    'reject.',
  INCORRECT:
    'The candidate is confidently the wrong product, or is otherwise unusable as a result for this garment.',
});

/**
 * Deterministically classifies FMQ's identity/substitute axis output into
 * the shared match-truth doctrine.
 *
 * Precedence: identity axis first (it is the stronger claim - confidently
 * knowing the exact product outranks a substitute-quality read), falling
 * through to the substitute axis only when identity is UNKNOWN. Every
 * combination of FMQ's four identity levels x four substitute levels is
 * covered - see tests/matchTruth.test.js for the exhaustive table - so no
 * (identity, substitute) pair reaches an evaluator without a reviewed
 * mapping (mirrors the "every intent has an explicit, reviewed commerce
 * decision" discipline already used in fashionIdentificationV2.ts).
 *
 * Returns `null` only when there is no evidence to classify at all (e.g. the
 * L1 pipeline was blocked and produced neither axis) - never a guess.
 *
 * This function always returns a level per the precedence table above, even
 * for an (identity, substitute) pair that is internally contradictory - it
 * never throws mid-evaluation. A caller that must reject a contradictory
 * pair up front (corpus validation, spec section 15) calls
 * `detectContradictoryMatchSignals` separately, the same "validate first,
 * classify second" split used throughout this lane.
 */
function classifyMatchTruth({ identityLevel, substituteLevel } = {}) {
  if (identityLevel === 'EXACT') return 'EXACT_PRODUCT';
  if (identityLevel === 'PROBABLE_EXACT') return 'EXACT_VARIANT';
  if (identityLevel === 'WRONG_IDENTITY') return 'INCORRECT';

  // identity is UNKNOWN or unrecognized - fall through to the substitute axis.
  if (substituteLevel === 'STRONG_SUBSTITUTE') return 'SAME_STYLE_DIFFERENT_VARIANT';
  if (substituteLevel === 'ACCEPTABLE_SUBSTITUTE') return 'USEFUL_SUBSTITUTE';
  if (substituteLevel === 'WEAK_SUBSTITUTE') return 'WEAK_SUBSTITUTE';
  if (substituteLevel === 'UNUSABLE') return 'INCORRECT';

  return null;
}

/**
 * Combinations FMQ's own axes should never produce together, because they
 * assert incompatible things about the same candidate. Corpus validation
 * (spec section 15 - "contradictory match labels") and `classifyMatchTruth`
 * both refuse these rather than silently picking a side.
 */
function detectContradictoryMatchSignals({ identityLevel, substituteLevel } = {}) {
  if (identityLevel === 'EXACT' && substituteLevel === 'UNUSABLE') {
    return 'the exact product can never simultaneously be an unusable substitute for itself';
  }
  if (identityLevel === 'WRONG_IDENTITY' && substituteLevel === 'STRONG_SUBSTITUTE') {
    return 'a confidently wrong identity cannot also be the strongest substitute grade';
  }
  return null;
}

module.exports = {
  MATCH_TRUTH_LEVELS,
  MATCH_TRUTH_DEFINITIONS,
  classifyMatchTruth,
  detectContradictoryMatchSignals,
};
