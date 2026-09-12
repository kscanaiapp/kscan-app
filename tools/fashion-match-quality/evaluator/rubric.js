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

/**
 * CANDIDATE FIELD RESOLUTION (the wrongColor repair).
 *
 * THE DEFECT. `componentScore` originally read `candidate[name]` for every
 * rubric component - the same key on both sides. That holds for 12 of the 13
 * components, but not for `color_family`: FMQ ground truth records colour as
 * `color_family`, while candidate products (which mirror the retailer-facing
 * product shape) record it as `color_normalized` / `color` and never carry a
 * `color_family` key at all. So `candidate.color_family` was ALWAYS
 * `undefined`, which `componentScore` scores 0 ("candidate has no value for a
 * component ground truth does have").
 *
 * The consequence was a colour score of 0 for every candidate ever scored,
 * including exact-SKU matches whose colour is identical to ground truth. That
 * is visible in this repository's own committed baseline
 * (baseline/committed/synthetic-v1.baseline.json), where
 * `fashionComponentAverages` reads 1 for all twelve other components and 0 for
 * `color_family` - on a corpus whose top-1 result is an exact SKU match every
 * time. A constant 0 carries no information: before this repair `wrongColor`
 * was 1.0 for ANY ranking, so it could not distinguish a good ranking from a
 * bad one, and was unusable as a quality signal in either direction.
 *
 * THE REPAIR is a field-resolution alias, not a scoring change. The candidate
 * genuinely carries the colour; the evaluator was looking under a key that
 * schema never used. Resolution order is most-canonical first. No comparison
 * rule, weight, threshold or partial-credit rule is touched, and no alias is
 * added for any component that was not broken - the audit that produced this
 * list confirmed `color_family` is the only component with no candidate-side
 * key.
 *
 * WHY THIS IS NOT EVALUATOR TUNING. The repair is blind to which arm produced
 * the candidate: it is applied inside the shared scorer to whatever candidate
 * is being scored, so control and challenger are affected identically. It
 * raises the colour score only where the candidate's colour genuinely equals
 * ground truth's and leaves a wrong-coloured candidate at 0 - which is what
 * makes `wrongColor` discriminative for the first time rather than uniformly
 * 1.0. Verified against known cases in the repair's own test.
 *
 * VERSIONED because it changes every colour score this evaluator has ever
 * produced. Artifacts record it alongside RUBRIC_VERSION so a pre-repair
 * baseline is never silently compared against a post-repair run. RUBRIC_VERSION
 * itself is deliberately NOT bumped: no component and no weight changed, and
 * overloading it would misreport the nature of the change.
 */
const COMPONENT_FIELD_RESOLUTION_VERSION = 'fmql-component-field-resolution-v2-color-family-repair';

const CANDIDATE_FIELD_ALIASES = Object.freeze({
  color_family: Object.freeze(['color_family', 'color_normalized', 'color']),
});

/**
 * Resolve a rubric component's value from a candidate, honouring the alias
 * list. Returns `undefined` only when the candidate truly carries no value
 * under any known key - which `componentScore` still scores 0, unchanged.
 */
function resolveCandidateField(candidate, componentName) {
  if (!candidate) return undefined;
  const keys = CANDIDATE_FIELD_ALIASES[componentName] || [componentName];
  for (const key of keys) {
    const value = candidate[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

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
  COMPONENT_FIELD_RESOLUTION_VERSION,
  CANDIDATE_FIELD_ALIASES,
  resolveCandidateField,
  RUBRIC_VERSION,
  IDENTITY_LEVELS,
  SUBSTITUTE_LEVELS,
  FASHION_COMPONENTS,
  FASHION_COMPONENT_WEIGHT_SUM,
};
