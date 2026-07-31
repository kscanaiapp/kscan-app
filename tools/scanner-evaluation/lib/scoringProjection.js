'use strict';

/**
 * The V2 result -> scorer input projection.
 *
 * WHY THIS MODULE EXISTS
 *
 * `scoreFields.scoreCase(label, prediction)` reads a prediction that is BOTH
 * flat and V2-shaped. It reads `prediction.category`, `.subtype`,
 * `.primaryColor`, `.secondaryColors`, `.material`, `.pattern`, `.brand` and
 * `.exactProduct` directly, while `resultState.scoreResultState` and
 * `scoreNonFashion` — which `scoreCase` also calls — read `prediction.status`,
 * `.resolutionLevel` and `.exactProduct` off the same object. The scorer was
 * therefore always designed to receive a PROJECTION of a
 * FashionIdentificationResultV2, not the raw result.
 *
 * That projection was never written. `build4Funnel` handed `scoreCaseAllProfiles`
 * the raw V2 object, whose identification lives under `item.*`, so every flat
 * field read as `undefined`, every one of them scored as an abstention, and the
 * funnel's aggregate described the missing projection rather than the scanner.
 * The failure was invisible because the raw object DID satisfy the V2-shaped
 * half of the contract, so `status`, `resolutionLevel` and `exactProduct` all
 * scored correctly and the result looked plausible.
 *
 * This module is that projection. It is SHARED: the certified control and every
 * candidate are projected by the same code, because a comparison in which the
 * two sides were shaped differently would measure the projection, not the
 * scanner.
 *
 * WHAT THIS IS NOT
 *
 * It performs no inference, no repair and no normalization of values. Nothing is
 * renamed, defaulted, coerced or cleaned up. It only moves values from where the
 * certified contract puts them to where the frozen scorer reads them. In
 * particular:
 *
 *   - no field is invented for a level the V2 contract does not carry;
 *   - no uncertainty token is rewritten;
 *   - no placeholder is converted into an abstention;
 *   - the scoring contract, its dispositions and all of its denominators are
 *     untouched — `scoreCase` still scores exactly the same field list.
 */

const SCORING_PROJECTION_VERSION = '1.0.0';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The first entry of a V2 string list, or null.
 *
 * The V2 contract carries `item.material` and `item.pattern` as LISTS while the
 * governed label carries one value, so a scalar has to be chosen. The certified
 * normalizer builds those lists with `list(id.material_estimate,
 * attrs.materialEstimate)` — the provider's own `identification` value first,
 * the legacy `attributes` echo second, de-duplicated, order preserved. The first
 * entry is therefore the model's primary assertion, and it is the one under
 * test. The remaining entries are carried through for reporting under a separate
 * key that the scorer does not read, so nothing is silently discarded and no
 * denominator changes.
 */
function firstOf(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const head = list[0];
  return typeof head === 'string' && head.trim() !== '' ? head : null;
}

/**
 * Project a validated FashionIdentificationResultV2 into the shape
 * `scoreFields.scoreCase` consumes.
 *
 * @param {object} v2 a result that has ALREADY passed
 *   `normalizedResultValidation.validateNormalizedResult`. Projecting an
 *   unvalidated object is refused: the schema boundary is the single place
 *   output validity is decided, and projecting first would let an invalid result
 *   reach scoring through the back door.
 * @param {{ schemaParseFailure?: boolean, fallbackInvoked?: boolean }} [runFacts]
 *   Facts the RUN knows and the result cannot: whether the provider output
 *   failed to parse, and whether the certified fallback model was reached.
 *   `scoreCase` reads both as flags. They are supplied rather than inferred.
 */
function projectV2ForScoring(v2, runFacts = {}) {
  if (!isObject(v2)) {
    throw new Error('scoring projection requires a validated V2 result object');
  }
  if (v2.contractVersion !== 'fashion-identification-v2') {
    throw new Error(
      `scoring projection requires contract fashion-identification-v2, received ${JSON.stringify(v2.contractVersion)}`
    );
  }

  const item = isObject(v2.item) ? v2.item : {};
  const colors = isObject(item.colors) ? item.colors : {};
  const brand = isObject(item.brand) ? item.brand : {};

  return {
    // ── Identification fields the scorer compares against governed labels ────
    category: item.category ?? null,
    // `clothingType` is DELIBERATELY ABSENT.
    //
    // The governed labels carry three taxonomy levels (category, clothingType,
    // subtype); the certified V2 contract carries two (item.category from the
    // provider's item_type, item.subtype). There is no third value to project,
    // and supplying `item.category` a second time would score one assertion
    // twice, in two denominators, from one prediction.
    //
    // An absent field is scored by the frozen contract exactly as it always has
    // been — as an abstention — so this changes no denominator and introduces no
    // new disposition. It is a CONTRACT CEILING on what can be measured, in the
    // same family as MC-1 and MC-2, not a scanner result.
    subtype: item.subtype ?? null,
    primaryColor: colors.primary ?? null,
    secondaryColors: Array.isArray(colors.secondary) ? colors.secondary : [],
    material: firstOf(item.material),
    pattern: firstOf(item.pattern),
    brand: brand.value ?? null,
    exactProduct: v2.exactProduct ?? null,

    // ── V2 fields the result-state and non-fashion scorers read directly ─────
    status: v2.status,
    resolutionLevel: v2.resolutionLevel,

    // ── Run facts the scorer reads as flags ─────────────────────────────────
    schemaParseFailure: runFacts.schemaParseFailure === true,
    fallbackInvoked: runFacts.fallbackInvoked === true,

    // ── Reporting only. `scoreCase` reads none of these. ────────────────────
    projectionVersion: SCORING_PROJECTION_VERSION,
    materialAll: Array.isArray(item.material) ? item.material : [],
    patternAll: Array.isArray(item.pattern) ? item.pattern : [],
    silhouetteAll: Array.isArray(item.silhouette) ? item.silhouette : [],
    brandProvenance: brand.provenance ?? null,
    brandEvidenceCount: Array.isArray(brand.evidence) ? brand.evidence.length : 0,
    globalConfidence: isObject(v2.compatibility) ? v2.compatibility.globalConfidence ?? null : null,
  };
}

/** The keys `scoreFields.scoreCase` actually reads. Asserted by test, not assumed. */
const SCORER_INPUT_KEYS = Object.freeze([
  'category',
  'subtype',
  'primaryColor',
  'secondaryColors',
  'material',
  'pattern',
  'brand',
  'exactProduct',
  'status',
  'resolutionLevel',
  'schemaParseFailure',
  'fallbackInvoked',
]);

module.exports = {
  SCORING_PROJECTION_VERSION,
  SCORER_INPUT_KEYS,
  firstOf,
  projectV2ForScoring,
};
