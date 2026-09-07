'use strict';

const { SUBSTITUTE_LEVELS, FASHION_COMPONENTS } = require('./rubric');

/**
 * Axis B - shopping substitute quality (spec section 13).
 * "If we did not find the exact item, did we still give the shopper
 * something meaningfully useful?" - deliberately independent of Axis A.
 * An UNKNOWN identity can still be a STRONG_SUBSTITUTE, and an EXACT
 * identity match with e.g. no purchase URL / out of stock can still be a
 * WEAK_SUBSTITUTE or UNUSABLE result for the shopper.
 */

function componentScore(name, candidate, groundTruth) {
  // Each component is scored 0/0.5/1 by explicit rule, never inferred from
  // an aggregate. This keeps color accuracy from ever hiding a silhouette
  // failure (section 14).
  const c = candidate?.[name];
  const g = groundTruth?.[name];
  if (g === undefined || g === null) return null; // unscoreable - excluded from rollup, not defaulted to 0
  if (c === undefined || c === null) return 0;
  if (c === g) return 1;
  // Partial credit only for the axes where "close" is a documented concept.
  if (name === 'color_family' || name === 'material') {
    if (typeof c === 'string' && typeof g === 'string' && (c.includes(g) || g.includes(c))) return 0.5;
  }
  return 0;
}

/**
 * Returns { components: {name: score|null}, rollup: number|null, weightUsed: number }.
 * rollup is null (not 0) when no component was scoreable, so an empty
 * ground truth never masquerades as a confirmed-bad score.
 */
function scoreFashionComponents(candidate, groundTruth) {
  const components = {};
  let weightedSum = 0;
  let weightUsed = 0;

  for (const [name, weight] of Object.entries(FASHION_COMPONENTS)) {
    const score = componentScore(name, candidate, groundTruth);
    components[name] = score;
    if (score !== null) {
      weightedSum += score * weight;
      weightUsed += weight;
    }
  }

  const rollup = weightUsed > 0 ? weightedSum / weightUsed : null;
  return { components, rollup, weightUsed };
}

/**
 * Classify substitute quality. Uses the component rollup plus two hard
 * gates that no weighted average is allowed to paper over:
 *   - category mismatch caps the result at WEAK_SUBSTITUTE (wrong garment
 *     type is never "strong", no matter how good the color match is).
 *   - no purchase path (no URL / confirmed unavailable) caps at UNUSABLE,
 *     because a shopper cannot act on it regardless of similarity.
 */
function scoreSubstitute(candidate, groundTruth) {
  if (!candidate) {
    return { level: 'UNUSABLE', reason: 'no_candidate_returned', components: {}, rollup: null, insufficientEvidence: false };
  }

  const noPurchasePath = !candidate.purchaseUrl || candidate.availability === 'out_of_stock';
  if (noPurchasePath) {
    return { level: 'UNUSABLE', reason: 'no_actionable_purchase_path', components: {}, rollup: null, insufficientEvidence: false };
  }

  const { components, rollup } = scoreFashionComponents(candidate, groundTruth);
  const categoryMismatch =
    candidate.category && groundTruth?.category && candidate.category !== groundTruth.category;

  if (rollup === null) {
    // No fashion-component ground truth was scoreable at all. Per spec
    // section 15, this fixture may exercise plumbing but must never
    // contribute a headline STRONG/ACCEPTABLE/WEAK/UNUSABLE verdict - so
    // `level` is intentionally null rather than a guessed bucket, and
    // `insufficientEvidence` tells aggregators to exclude it from
    // headline substitute-quality metrics.
    return { level: null, reason: 'no_scoreable_ground_truth', components, rollup, insufficientEvidence: true };
  }

  let level;
  if (categoryMismatch) {
    level = rollup >= 0.5 ? 'WEAK_SUBSTITUTE' : 'UNUSABLE';
  } else if (rollup >= 0.75) {
    level = 'STRONG_SUBSTITUTE';
  } else if (rollup >= 0.5) {
    level = 'ACCEPTABLE_SUBSTITUTE';
  } else if (rollup >= 0.25) {
    level = 'WEAK_SUBSTITUTE';
  } else {
    level = 'UNUSABLE';
  }

  return {
    level,
    reason: categoryMismatch ? 'category_mismatch_capped' : 'component_rollup',
    components,
    rollup,
    insufficientEvidence: false,
  };
}

function isValidSubstituteLevel(level) {
  return SUBSTITUTE_LEVELS.includes(level);
}

module.exports = { scoreSubstitute, scoreFashionComponents, isValidSubstituteLevel, SUBSTITUTE_LEVELS };
