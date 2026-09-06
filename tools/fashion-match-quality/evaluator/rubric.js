'use strict';

/**
 * Fashion evaluation rubric (spec sections 13-14).
 *
 * RUBRIC_VERSION must bump whenever weights or components change, and is
 * persisted into every baseline/report so comparisons across rubric
 * versions can be rejected (spec section 23).
 *
 * This rubric is DELIBERATELY separate from the production ranking weights
 * in supabase/functions/_shared/scanHelpers.ts (scoreRecommendedProduct).
 * Production's weights answer "how should we rank candidates for a user
 * right now" - a single blended score. This rubric answers "how good was
 * the outcome, per fashion dimension" - many separate component scores that
 * must never be collapsed into one number, so a color win can never hide a
 * silhouette failure (section 14 is explicit about this).
 */

const RUBRIC_VERSION = 'fmql-rubric-v1';

// Axis A - product identity (section 13).
const IDENTITY_LEVELS = Object.freeze(['EXACT', 'PROBABLE_EXACT', 'UNKNOWN', 'WRONG_IDENTITY']);

// Axis B - shopping substitute quality (section 13).
const SUBSTITUTE_LEVELS = Object.freeze([
  'STRONG_SUBSTITUTE',
  'ACCEPTABLE_SUBSTITUTE',
  'WEAK_SUBSTITUTE',
  'UNUSABLE',
]);

// Fashion-specific components (section 14). Each has an explicit, versioned
// weight used only for the SUBSTITUTE axis's component rollup - never for
// identity, and never collapsed silently (each component score is reported
// individually in addition to any rollup).
const FASHION_COMPONENTS = Object.freeze({
  category: 0.20,
  silhouette: 0.16,
  cut_proportion: 0.08,
  material: 0.12,
  texture: 0.05,
  pattern: 0.07,
  color_family: 0.10,
  construction: 0.05,
  hardware_details: 0.03,
  brand: 0.05,
  price_tier: 0.04,
  availability: 0.03,
  retailer_quality: 0.02,
});

const FASHION_COMPONENT_WEIGHT_SUM = Object.values(FASHION_COMPONENTS).reduce((a, b) => a + b, 0);

function assertWeightsSumToOne(tolerance = 1e-9) {
  if (Math.abs(FASHION_COMPONENT_WEIGHT_SUM - 1) > tolerance) {
    throw new Error(
      `RUBRIC_INVARIANT_VIOLATED: FASHION_COMPONENTS weights sum to ${FASHION_COMPONENT_WEIGHT_SUM}, expected 1.0`,
    );
  }
}
assertWeightsSumToOne();

module.exports = {
  RUBRIC_VERSION,
  IDENTITY_LEVELS,
  SUBSTITUTE_LEVELS,
  FASHION_COMPONENTS,
  FASHION_COMPONENT_WEIGHT_SUM,
};
