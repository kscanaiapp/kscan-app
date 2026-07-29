'use strict';

/**
 * Versioned mapping between the ACTUAL deployed V2 contract and the four
 * evaluation result states.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL PROVENANCE NOTE
 *
 * The four evaluation states
 *     likely_exact_match | closest_matches | identified_style | insufficient_evidence
 * are EVALUATION-ONLY ABSTRACTIONS. They are NOT production fields.
 *
 * Verified against supabase/functions/_shared/fashionIdentificationV2.ts
 * (blob 1e8acdd4ebf3b6de480352c23d06597ded6ee44d) at commit cf39d9ac:
 *
 *   - production exposes `status` (6 values) and `resolutionLevel` (6 values);
 *   - `likely_exact_match`, `closest_matches` and `identified_style` appear
 *     NOWHERE in supabase/ or types/;
 *   - `insufficient_evidence` exists only in the Elise/StyleChat layer
 *     (fashionContextV2.ts, eliseIdentifyForStyle.ts), NOT in the Scanner
 *     result contract.
 *
 * This module therefore DERIVES the evaluation state from real response fields.
 * It never reads an invented field.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MEASUREMENT CEILINGS discovered in the deployed contract. These bound what any
 * baseline can honestly claim and are asserted by tests so they cannot silently
 * change:
 *
 *   MC-1  normalizeToV2 calls deriveResolutionLevel with `exactProduct: null`
 *         (fashionIdentificationV2.ts:741) and sets the result's `exactProduct`
 *         to null (:798). resolutionLevel can therefore NEVER be 'exact_product'
 *         or 'model_family' on the deployed scanner path. This is deliberate —
 *         see the comment at :608 "Deliberately conservative".
 *         CONSEQUENCE: the evaluation state `likely_exact_match` is UNREACHABLE.
 *         Every exact-product-knowable case scores under-identification by
 *         construction. That is a CONTRACT CEILING, not a model-quality signal,
 *         and must never be reported as "the model failed to identify products".
 *
 *   MC-2  confidence.subtype, confidence.modelFamily and confidence.exactProduct
 *         are hardcoded null (:793,:795,:796). No threshold may be built on them.
 *
 *   MC-3  `conflicts` is always [] (:804). Cross-image conflict must come from
 *         reviewer adjudication, never from the production response.
 *
 *   MC-4  `closest_matches` has no production analogue on the identification
 *         path. Candidate lists exist only for multi-item DETECTION
 *         (status multiple_items_need_selection), which is a different question
 *         from "these are the closest matching products". Commerce is disabled
 *         for this baseline, so no closest-match surface is exercised at all.
 */

const RESULT_STATES = Object.freeze({
  LIKELY_EXACT_MATCH: 'likely_exact_match',
  CLOSEST_MATCHES: 'closest_matches',
  IDENTIFIED_STYLE: 'identified_style',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
});

const MAPPING_VERSION = '1.0.0';

/** Production vocabularies, mirrored for validation. Source of truth is the .ts contract. */
const PRODUCTION_STATUSES = Object.freeze([
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
]);

const PRODUCTION_RESOLUTION_LEVELS = Object.freeze([
  'exact_product',
  'model_family',
  'brand_and_subtype',
  'subtype',
  'category',
  'unknown',
]);

/** Resolution levels that the deployed scanner path can actually emit. */
const REACHABLE_RESOLUTION_LEVELS = Object.freeze([
  'brand_and_subtype',
  'subtype',
  'category',
  'unknown',
]);

const DISPOSITIONS = Object.freeze({
  CORRECT: 'correct',
  UNSUPPORTED_CERTAINTY: 'unsupported_certainty',
  UNDER_IDENTIFICATION: 'under_identification',
  INCORRECT: 'incorrect',
  UNSCORABLE: 'unscorable',
  /**
   * Phase 0C reclassification of MC-1. The deployed contract cannot express an
   * exact-product outcome at all, so the question is not asked rather than
   * answered badly. Distinct from UNSCORABLE, which means this particular case
   * could not be scored; NOT_MEASURED means the METRIC is out of scope for the
   * contract under test.
   */
  NOT_MEASURED: 'not_measured',
});

/** The literal string every out-of-scope metric reports. */
const NOT_MEASURED = 'not_measured';

function hasExactProductClaim(result) {
  const ep = result && result.exactProduct;
  if (!ep || typeof ep !== 'object') return false;
  return Boolean(ep.sku || ep.model);
}

/**
 * Derive the evaluation result state from a real V2 response.
 *
 * @param {object} result a FashionIdentificationResultV2
 * @returns {{ state: string, basis: object, unreachableStateObserved?: boolean }}
 */
function deriveObservedResultState(result) {
  if (!result || typeof result !== 'object') {
    return { state: RESULT_STATES.INSUFFICIENT_EVIDENCE, basis: { reason: 'no result object' } };
  }

  const status = result.status;
  const resolutionLevel = result.resolutionLevel;
  const exactProductClaimed = hasExactProductClaim(result);
  const basis = { status, resolutionLevel, exactProductClaimed };

  // Non-identifying statuses map straight through.
  if (status === 'non_fashion' || status === 'insufficient_visual_evidence') {
    return { state: RESULT_STATES.INSUFFICIENT_EVIDENCE, basis };
  }
  if (status === 'technical_failure') {
    return { state: RESULT_STATES.INSUFFICIENT_EVIDENCE, basis: { ...basis, technicalFailure: true } };
  }

  // An exact-product claim, if it ever appears, is the strongest state.
  if (exactProductClaimed || resolutionLevel === 'exact_product' || resolutionLevel === 'model_family') {
    return {
      state: RESULT_STATES.LIKELY_EXACT_MATCH,
      basis,
      // Flag loudly: per MC-1 this cannot happen on the deployed path. If it
      // does, the deployed bundle is NOT the source we certified against.
      unreachableStateObserved: true,
    };
  }

  if (status === 'multiple_items_need_selection') {
    // A detection candidate list is not a product match list. It is an
    // identified-style-level outcome pending user selection.
    return { state: RESULT_STATES.IDENTIFIED_STYLE, basis: { ...basis, detectionOnly: true } };
  }

  if (status === 'completed' || status === 'partial') {
    if (resolutionLevel === 'brand_and_subtype' || resolutionLevel === 'subtype' || resolutionLevel === 'category') {
      return { state: RESULT_STATES.IDENTIFIED_STYLE, basis };
    }
    if (resolutionLevel === 'unknown') {
      return { state: RESULT_STATES.INSUFFICIENT_EVIDENCE, basis };
    }
  }

  return { state: RESULT_STATES.INSUFFICIENT_EVIDENCE, basis: { ...basis, reason: 'unmapped status' } };
}

/** Rank used only to decide over- vs under-identification. */
const STATE_STRENGTH = Object.freeze({
  [RESULT_STATES.INSUFFICIENT_EVIDENCE]: 0,
  [RESULT_STATES.IDENTIFIED_STYLE]: 1,
  [RESULT_STATES.CLOSEST_MATCHES]: 2,
  [RESULT_STATES.LIKELY_EXACT_MATCH]: 3,
});

/**
 * Score an expected result state against an observed V2 response.
 *
 * Required dispositions from the Phase 0B contract, each covered by a test:
 *   expected insufficient_evidence, actual exact claim   -> unsupported_certainty
 *   expected identified_style, actual broad style        -> correct
 *   expected closest_matches, actual incorrect exact     -> unsupported_certainty
 *   expected likely_exact_match, actual style identity   -> under_identification
 *   expected non-fashion, actual fashion identity        -> unsupported_certainty
 *
 * @param {object} label governed case label
 * @param {object} result FashionIdentificationResultV2
 */
function scoreResultState(label, result) {
  const expected = label && label.expectedResultType;
  const observed = deriveObservedResultState(result);
  const actual = observed.state;

  if (!expected) {
    return {
      field: 'expectedResultType',
      expected: null,
      actual,
      disposition: DISPOSITIONS.UNSCORABLE,
      notes: 'label carries no expected result state',
      basis: observed.basis,
    };
  }

  const isNonFashionCase = label.category === 'not_applicable' || label.nonFashion === true;
  const claimedFashionIdentity =
    actual === RESULT_STATES.IDENTIFIED_STYLE ||
    actual === RESULT_STATES.CLOSEST_MATCHES ||
    actual === RESULT_STATES.LIKELY_EXACT_MATCH;

  // Non-fashion input answered with a fashion identity is the most dangerous
  // trust failure the scanner can produce.
  if (isNonFashionCase && claimedFashionIdentity) {
    return {
      field: 'expectedResultType',
      expected,
      actual,
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      notes: 'non-fashion input produced a fashion identity claim',
      nonFashionFalsePositive: true,
      basis: observed.basis,
    };
  }

  if (expected === actual) {
    return {
      field: 'expectedResultType',
      expected,
      actual,
      disposition: DISPOSITIONS.CORRECT,
      notes: 'result state matches',
      basis: observed.basis,
    };
  }

  const expectedStrength = STATE_STRENGTH[expected];
  const actualStrength = STATE_STRENGTH[actual];

  if (actualStrength > expectedStrength) {
    return {
      field: 'expectedResultType',
      expected,
      actual,
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      notes: `claimed ${actual} where evidence supports only ${expected}`,
      overclaim: true,
      basis: observed.basis,
    };
  }

  // MC-1, as reclassified in Phase 0C. When the label expected an exact-product
  // outcome, the deployed contract cannot produce one under ANY model behaviour.
  // Scoring that as under-identification would attribute a contract limitation
  // to the model, so the case is NOT scored on this axis at all. It is retained
  // and tagged for a future contract that can express exact-product results.
  if (expected === RESULT_STATES.LIKELY_EXACT_MATCH) {
    return {
      field: 'expectedResultType',
      expected,
      actual,
      disposition: DISPOSITIONS.NOT_MEASURED,
      notes:
        'exact-product outcome is not expressible by the deployed contract (MC-1); not scored, retained for future evaluation',
      futureExactProductEvaluation: true,
      basis: observed.basis,
    };
  }

  return {
    field: 'expectedResultType',
    expected,
    actual,
    disposition: DISPOSITIONS.UNDER_IDENTIFICATION,
    notes: `produced ${actual} where ${expected} was supportable`,
    underIdentification: true,
    basis: observed.basis,
  };
}

/**
 * Non-fashion false-positive metric (Phase 0B section 4.8).
 *
 * non-fashion -> non_fashion        : correct
 * non-fashion -> fashion identity   : unsupported certainty
 * fashion     -> non_fashion        : incorrect abstention
 */
function scoreNonFashion(label, result) {
  const labelIsNonFashion = label.category === 'not_applicable' || label.nonFashion === true;
  const status = result && result.status;
  const observed = deriveObservedResultState(result);
  const predictedNonFashion = status === 'non_fashion';
  const predictedFashionIdentity =
    observed.state === RESULT_STATES.IDENTIFIED_STYLE ||
    observed.state === RESULT_STATES.CLOSEST_MATCHES ||
    observed.state === RESULT_STATES.LIKELY_EXACT_MATCH;

  if (labelIsNonFashion && predictedNonFashion) {
    return { field: 'nonFashion', disposition: DISPOSITIONS.CORRECT, notes: 'non-fashion correctly rejected' };
  }
  if (labelIsNonFashion && predictedFashionIdentity) {
    return {
      field: 'nonFashion',
      disposition: DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      notes: 'non-fashion input identified as fashion',
      nonFashionFalsePositive: true,
    };
  }
  if (labelIsNonFashion) {
    // Abstained without asserting non_fashion (e.g. insufficient_visual_evidence).
    return {
      field: 'nonFashion',
      disposition: DISPOSITIONS.CORRECT,
      notes: 'non-fashion input abstained without a fashion claim',
      abstainedNotClassified: true,
    };
  }
  if (predictedNonFashion) {
    return {
      field: 'nonFashion',
      disposition: DISPOSITIONS.INCORRECT,
      notes: 'fashion item rejected as non-fashion',
      incorrectAbstention: true,
    };
  }
  return { field: 'nonFashion', disposition: DISPOSITIONS.UNSCORABLE, notes: 'not a non-fashion comparison' };
}

module.exports = {
  MAPPING_VERSION,
  RESULT_STATES,
  DISPOSITIONS,
  NOT_MEASURED,
  PRODUCTION_STATUSES,
  PRODUCTION_RESOLUTION_LEVELS,
  REACHABLE_RESOLUTION_LEVELS,
  STATE_STRENGTH,
  deriveObservedResultState,
  scoreResultState,
  scoreNonFashion,
  hasExactProductClaim,
};
