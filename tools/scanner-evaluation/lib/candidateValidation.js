'use strict';

/**
 * Candidate-scoped post-validation: evidence discipline.
 *
 * WHAT THIS IS
 *
 * A candidate declares a behaviour contract in its instruction overlay — name a
 * specific fashion term, keep item_type and subtype in the same family, claim a
 * material only from visible texture, claim a brand only from visible evidence,
 * never emit a placeholder. This module checks the candidate's OUTPUT against
 * the contract its OWN prompt asserted, and reports where the two disagree.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 *   1. It is NOT a second schema boundary.
 *      `normalizedResultValidation.validateNormalizedResult` remains the single
 *      place output validity is decided. This runs only on results that already
 *      passed it, and it cannot admit anything that boundary rejected.
 *      `findCandidateViolations` refuses an unvalidated object outright.
 *
 *   2. It NEVER mutates the observed result.
 *      Every function here is pure and returns findings. The stored `observed`
 *      stays exactly what the certified path produced, byte for byte.
 *
 *   3. It NEVER changes a score.
 *      No finding rewrites a value, suppresses a field, converts a claim into an
 *      abstention, or removes a case from a cohort. That restraint is the whole
 *      point: a "guard" that turned an unsupported brand claim into an
 *      abstention would convert a false positive into a correct abstention and
 *      raise the candidate's score for behaviour the candidate actually got
 *      wrong. That is benchmark gaming, and it is exactly what the frozen
 *      scoring contract exists to prevent. A candidate that violates its own
 *      instructions is scored on what it emitted, and the violation is reported
 *      alongside so the comparison can say WHY the score moved.
 *
 *   4. It is NOT applied to the control.
 *      The certified v140 path declares the `certified_only` policy and receives
 *      no candidate rule, so certified normalization is untouched.
 *
 * DECIDABILITY
 *
 * Every check below is decidable from the structured output alone. Nothing here
 * inspects an image or second-guesses the model about what was visible; a check
 * that needed the image would be a second classification pass, which Phase 2A
 * does not permit.
 */

const candidateRegistry = require('./candidateRegistry');
const ontology = require('./ontology');

const CANDIDATE_VALIDATION_VERSION = '1.0.0';

/** Every finding code, so a report can enumerate them without observing one. */
const FINDING_CODES = Object.freeze([
  'taxonomy_contradiction',
  'unmapped_taxonomy_prediction',
  'placeholder_value',
  'brand_without_recorded_evidence',
  'attribute_claim_without_classification',
  'confidence_exceeds_resolution',
]);

/**
 * Strings that assert a value while carrying none. The schema already forbids
 * the empty string, and the scorer already treats `unknown`, `not_visible` and
 * `not_applicable` as uncertainty, so these are the residue: tokens that read as
 * concrete to every downstream consumer while meaning "no answer".
 */
const PLACEHOLDER_TOKENS = Object.freeze([
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'tbd',
  'to be determined',
  '-',
  '--',
  'undefined',
  'not specified',
  'unspecified',
  'no brand',
  'unbranded',
  'generic',
  'nobrand',
]);

const PLACEHOLDER_SET = new Set(PLACEHOLDER_TOKENS);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_SET.has(value.trim().toLowerCase());
}

/** Concrete for these purposes: a non-empty string that is not an uncertainty token. */
function isConcreteValue(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && !ontology.isUncertaintyToken(value);
}

function finding(code, field, detail, extra = {}) {
  return { code, field, detail, ...extra };
}

/**
 * Are an asserted category and subtype from the same family?
 *
 * Consistent means the subtype sits somewhere UNDER the category in the governed
 * taxonomy: identical, one level below, or two levels below. Inconsistent means
 * a peer or a cross-category pair — "sneaker" under "dress", or "tank top" under
 * "blazer". A contradiction is worse than a broader answer, which is precisely
 * what the candidate overlay tells the model.
 *
 * The comparison is the governed one. `ontology.compareTaxonomy` is the single
 * taxonomy comparator, and this uses it rather than reading the hierarchy again,
 * so there is no second taxonomy and no taxonomy-hash drift.
 */
function taxonomyPairConsistency(category, subtype) {
  if (!isConcreteValue(category) || !isConcreteValue(subtype)) {
    return { decidable: false, reason: 'one side is absent or an uncertainty token' };
  }
  // Ground truth = the narrower assertion, prediction = the broader one, which is
  // the direction `compareTaxonomy` reports parent relationships in.
  const comparison = ontology.compareTaxonomy(subtype, category);

  if (comparison.unmappedGroundTruth) {
    return { decidable: false, reason: `subtype not in the ontology: ${subtype}`, unmapped: 'subtype' };
  }
  if (comparison.unmappedPrediction) {
    return { decidable: false, reason: `category not in the ontology: ${category}`, unmapped: 'category' };
  }

  const consistent =
    comparison.outcome === ontology.OUTCOMES.EXACT
    || comparison.outcome === ontology.OUTCOMES.BROADER
    || comparison.twoLevelsBroader === true;

  return { decidable: true, consistent, comparison };
}

/**
 * Find every place a candidate result contradicts the discipline its own overlay
 * asserted.
 *
 * @param {object} v2 a result that has already passed the schema boundary
 * @param {{ candidateVersion: string }} context
 * @returns {{ candidateVersion: string, validationVersion: string,
 *             applicable: boolean, findings: Array<object> }}
 */
function findCandidateViolations(v2, { candidateVersion } = {}) {
  const entry = candidateRegistry.resolveCandidate(candidateVersion);

  // The control receives no candidate rule. Returning an explicit, empty,
  // non-applicable result rather than throwing means a caller can run both paths
  // through the same code without branching, and a test can prove the control
  // produced no findings rather than merely skipping the call.
  if (entry.postValidationPolicy === 'certified_only') {
    return {
      candidateVersion: entry.candidateVersion,
      validationVersion: CANDIDATE_VALIDATION_VERSION,
      policy: entry.postValidationPolicy,
      applicable: false,
      findings: [],
    };
  }

  if (!isObject(v2) || v2.contractVersion !== 'fashion-identification-v2') {
    throw new Error('candidate post-validation requires a schema-validated V2 result');
  }

  const findings = [];
  const item = isObject(v2.item) ? v2.item : {};
  const colors = isObject(item.colors) ? item.colors : {};
  const brand = isObject(item.brand) ? item.brand : {};
  const material = Array.isArray(item.material) ? item.material : [];
  const pattern = Array.isArray(item.pattern) ? item.pattern : [];

  // ── Category / subtype agreement ──────────────────────────────────────────
  const pair = taxonomyPairConsistency(item.category, item.subtype);
  if (pair.decidable && !pair.consistent) {
    findings.push(finding(
      'taxonomy_contradiction',
      'item.subtype',
      `subtype ${JSON.stringify(item.subtype)} does not sit under category ${JSON.stringify(item.category)}: ${pair.comparison.reason}`,
      { category: item.category, subtype: item.subtype, comparison: pair.comparison.reason }
    ));
  } else if (pair.unmapped) {
    findings.push(finding(
      'unmapped_taxonomy_prediction',
      `item.${pair.unmapped}`,
      pair.reason,
      { value: pair.unmapped === 'subtype' ? item.subtype : item.category }
    ));
  }

  // ── Placeholders ──────────────────────────────────────────────────────────
  const scalarFields = [
    ['item.category', item.category],
    ['item.subtype', item.subtype],
    ['item.colors.primary', colors.primary],
    ['item.brand.value', brand.value],
  ];
  for (const [field, value] of scalarFields) {
    if (isPlaceholder(value)) {
      findings.push(finding('placeholder_value', field, `${JSON.stringify(value)} asserts a value while carrying none`, { value }));
    }
  }
  for (const [field, list] of [['item.material', material], ['item.pattern', pattern], ['item.colors.secondary', Array.isArray(colors.secondary) ? colors.secondary : []]]) {
    list.forEach((value, index) => {
      if (isPlaceholder(value)) {
        findings.push(finding('placeholder_value', `${field}[${index}]`, `${JSON.stringify(value)} asserts a value while carrying none`, { value }));
      }
    });
  }

  // ── Brand discipline ──────────────────────────────────────────────────────
  //
  // The certified normalizer derives provenance from the provider's own
  // `visible_brand_text` / `logo_detected` / `brand_guess`, and builds an
  // evidence entry for each. A concrete brand with provenance `unknown` and an
  // empty evidence list therefore means the brand appeared without any of the
  // three signals that could support it.
  if (isConcreteValue(brand.value)) {
    const evidenceCount = Array.isArray(brand.evidence) ? brand.evidence.length : 0;
    if (brand.provenance === 'unknown' || evidenceCount === 0) {
      findings.push(finding(
        'brand_without_recorded_evidence',
        'item.brand.value',
        `brand ${JSON.stringify(brand.value)} is asserted with provenance ${JSON.stringify(brand.provenance)} and ${evidenceCount} evidence entries`,
        { provenance: brand.provenance ?? null, evidenceCount }
      ));
    }
  }

  // ── Attributes claimed without a classification ───────────────────────────
  //
  // Material, pattern and colour are properties OF an item. Asserting them while
  // the item itself could not be classified is certainty running ahead of
  // evidence.
  if (!isConcreteValue(item.category)) {
    for (const [field, value] of [
      ['item.material', material[0]],
      ['item.pattern', pattern[0]],
      ['item.brand.value', brand.value],
    ]) {
      if (isConcreteValue(value)) {
        findings.push(finding(
          'attribute_claim_without_classification',
          field,
          `${field} asserts ${JSON.stringify(value)} while item.category is ${JSON.stringify(item.category ?? null)}`,
          { value }
        ));
      }
    }
  }

  // ── Conservative certainty ────────────────────────────────────────────────
  const globalConfidence = isObject(v2.compatibility) ? v2.compatibility.globalConfidence : null;
  if (typeof globalConfidence === 'number' && globalConfidence >= 0.8 && v2.resolutionLevel === 'unknown') {
    findings.push(finding(
      'confidence_exceeds_resolution',
      'compatibility.globalConfidence',
      `confidence ${globalConfidence} accompanies resolutionLevel "unknown"`,
      { globalConfidence }
    ));
  }

  return {
    candidateVersion: entry.candidateVersion,
    validationVersion: CANDIDATE_VALIDATION_VERSION,
    policy: entry.postValidationPolicy,
    applicable: true,
    findings,
  };
}

module.exports = {
  CANDIDATE_VALIDATION_VERSION,
  FINDING_CODES,
  PLACEHOLDER_TOKENS,
  isPlaceholder,
  isConcreteValue,
  taxonomyPairConsistency,
  findCandidateViolations,
};
