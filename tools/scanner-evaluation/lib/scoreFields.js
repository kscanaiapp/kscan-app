'use strict';

/**
 * Field-level scoring. Phase 0B contract.
 *
 * WHAT CHANGED FROM PHASE 0A AND WHY:
 *
 *  1. Comparison is ontology-driven, not substring-driven. The Phase 0A
 *     `truth.includes(pred)` rule credited "boot" against "bootcut jeans" as
 *     acceptably broad — a footwear prediction earning partial credit on a
 *     bottoms label. See lib/ontology.js.
 *
 *  2. Uncertainty is scored by explicit rules per ground-truth token, rather
 *     than collapsing unknown / not_visible / not_applicable into one branch.
 *     In particular a correct abstention against a not_visible label is now
 *     CORRECT, where Phase 0A returned UNSCORABLE and silently dropped the
 *     case from the denominator — which flattered any model that abstained.
 *
 *  3. Weighting is profile-driven. Every report is emitted under BOTH the
 *     neutral and the trust-weighted profile so the weighting choice is
 *     visible. See config/trust-weights.json.
 *
 * Determinism: same inputs always produce the same output. No clocks, no
 * randomness, no iteration-order dependence.
 */

const fs = require('fs');
const path = require('path');

const { isUncertainty } = require('./datasetValidate');
const ontology = require('./ontology');
const resultState = require('./resultState');

const SCORING_CONTRACT_VERSION = '0.2.0';

const TRUST_WEIGHTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'trust-weights.json'), 'utf8')
);

const DISPOSITIONS = Object.freeze({
  CORRECT: 'correct',
  ACCEPTABLY_BROAD: 'acceptably_broad',
  INCORRECT: 'incorrect',
  UNSUPPORTED_CERTAINTY: 'unsupported_certainty',
  UNKNOWN_WHEN_EVIDENCE_EXISTS: 'unknown_when_evidence_exists',
  CORRECT_ABSTENTION: 'correct_abstention',
  INCORRECT_ABSTENTION: 'incorrect_abstention',
  UNDER_IDENTIFICATION: 'under_identification',
  UNSCORABLE: 'unscorable',
});

const PROFILES = Object.freeze({ NEUTRAL: 'neutral', TRUST_WEIGHTED: 'trust_weighted' });
const DEFAULT_PROFILE = PROFILES.TRUST_WEIGHTED;

/** Retained for Phase 0A API compatibility; the trust-weighted profile is canonical. */
const FIELD_WEIGHTS = Object.freeze(TRUST_WEIGHTS.profiles.trust_weighted.fieldWeights);
const PENALTY_MULTIPLIERS = Object.freeze(TRUST_WEIGHTS.profiles.trust_weighted.dispositionMultipliers);

/** Fields where a confident wrong answer is worse than no answer. */
const EVIDENCE_STRICT_FIELDS = new Set(['brand', 'exactProduct']);

const FIELD_COMPARATORS = Object.freeze({
  category: 'taxonomy',
  clothingType: 'taxonomy',
  subtype: 'taxonomy',
  primaryColor: 'color',
  material: 'material',
  brand: 'brand',
});

function penaltyFor(field, disposition, profileName = DEFAULT_PROFILE) {
  const profile = TRUST_WEIGHTS.profiles[profileName];
  if (!profile) throw new Error(`unknown trust-weight profile: ${profileName}`);
  const weight = profile.fieldWeights[field] != null ? profile.fieldWeights[field] : 1;
  const multiplier = profile.dispositionMultipliers[disposition] != null
    ? profile.dispositionMultipliers[disposition]
    : 1;
  const overrides = profile.fieldDispositionOverrides || {};
  const override = overrides[`${field}.${disposition}`] != null ? overrides[`${field}.${disposition}`] : 1;
  return weight * multiplier * override;
}

function isConcrete(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0 && !isUncertainty(value);
}

/** Absent means null, undefined, empty string, or empty array. */
function isAbsent(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'string' && value.trim().length === 0;
}

function abstained(value) {
  return isAbsent(value) || isUncertainty(value);
}

function result(field, disposition, notes, extra = {}, profileName = DEFAULT_PROFILE) {
  return {
    field,
    disposition,
    penalty: penaltyFor(field, disposition, profileName),
    notes,
    profile: profileName,
    ...extra,
  };
}

function compareByField(field, groundTruth, prediction) {
  switch (FIELD_COMPARATORS[field]) {
    case 'taxonomy':
      return ontology.compareTaxonomy(groundTruth, prediction);
    case 'color':
      return ontology.compareColor(groundTruth, prediction);
    case 'material':
      return ontology.compareMaterial(groundTruth, prediction);
    case 'brand':
      return ontology.compareBrand(groundTruth, prediction);
    default: {
      const a = String(groundTruth).trim().toLowerCase();
      const b = String(prediction).trim().toLowerCase();
      return a === b
        ? { outcome: ontology.OUTCOMES.EXACT, reason: 'exact literal match' }
        : { outcome: ontology.OUTCOMES.UNRELATED, reason: 'literal mismatch' };
    }
  }
}

/**
 * Score one field. Phase 0B section 4.6 uncertainty rules are applied first and
 * exhaustively, before any ontology comparison.
 *
 * @param {string} field
 * @param {*} groundTruth
 * @param {*} prediction
 * @param {{ profile?: string, evidenceStrength?: 'strong'|'weak'|'unknown' }} [options]
 */
function scoreField(field, groundTruth, prediction, options = {}) {
  const profileName = options.profile || DEFAULT_PROFILE;
  const gtToken = typeof groundTruth === 'string' ? groundTruth.trim() : groundTruth;

  // ── Ground truth: not_applicable ───────────────────────────────────────────
  if (gtToken === 'not_applicable') {
    if (isAbsent(prediction) || isUncertainty(prediction)) {
      return result(field, DISPOSITIONS.CORRECT, 'field not applicable and not populated', {}, profileName);
    }
    return result(
      field,
      DISPOSITIONS.INCORRECT,
      'populated a field that is not applicable to this item',
      {},
      profileName
    );
  }

  // ── Ground truth: not_visible ──────────────────────────────────────────────
  if (gtToken === 'not_visible') {
    if (abstained(prediction)) {
      return result(field, DISPOSITIONS.CORRECT, 'correctly declined an attribute that is not visible', {}, profileName);
    }
    return result(
      field,
      DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      'asserted a specific value for an attribute that is not visible',
      EVIDENCE_STRICT_FIELDS.has(field) ? { evidenceStrictViolation: true } : {},
      profileName
    );
  }

  // ── Ground truth: unknown ──────────────────────────────────────────────────
  if (gtToken === 'unknown' || gtToken == null) {
    if (abstained(prediction)) {
      return result(field, DISPOSITIONS.CORRECT_ABSTENTION, 'abstained where ground truth is unknown', {}, profileName);
    }
    return result(
      field,
      DISPOSITIONS.UNSUPPORTED_CERTAINTY,
      'asserted a specific value where ground truth is unknown',
      EVIDENCE_STRICT_FIELDS.has(field) ? { evidenceStrictViolation: true } : {},
      profileName
    );
  }

  // ── Ground truth is known ──────────────────────────────────────────────────
  if (abstained(prediction)) {
    const strong = options.evidenceStrength !== 'weak';
    if (strong) {
      return result(
        field,
        DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS,
        'returned unknown while the label records supportable evidence',
        {},
        profileName
      );
    }
    return result(field, DISPOSITIONS.UNSCORABLE, 'label evidence marked weak; abstention not penalised', {}, profileName);
  }

  const comparison = compareByField(field, gtToken, prediction);

  switch (comparison.outcome) {
    case ontology.OUTCOMES.EXACT:
      return result(field, DISPOSITIONS.CORRECT, comparison.reason, { comparison }, profileName);
    case ontology.OUTCOMES.BROADER:
      return result(field, DISPOSITIONS.ACCEPTABLY_BROAD, comparison.reason, { comparison }, profileName);
    case ontology.OUTCOMES.INVALID:
      return result(field, DISPOSITIONS.UNSCORABLE, comparison.reason, { comparison }, profileName);
    default: {
      // A narrower or peer assertion on an evidence-strict field is an
      // unsupported claim, not a plain miss.
      if (EVIDENCE_STRICT_FIELDS.has(field)) {
        return result(
          field,
          DISPOSITIONS.UNSUPPORTED_CERTAINTY,
          comparison.reason,
          { comparison, evidenceStrictViolation: true },
          profileName
        );
      }
      if (comparison.narrower) {
        return result(
          field,
          DISPOSITIONS.UNSUPPORTED_CERTAINTY,
          comparison.reason,
          { comparison },
          profileName
        );
      }
      return result(field, DISPOSITIONS.INCORRECT, comparison.reason, { comparison }, profileName);
    }
  }
}

/** Phase 0A compatibility shim: is `prediction` exactly one level broader than `groundTruth`? */
function isBroadMatch(prediction, groundTruth) {
  return ontology.compareTaxonomy(groundTruth, prediction).outcome === ontology.OUTCOMES.BROADER;
}

function scoreSecondaryColors(groundTruth, prediction, options = {}) {
  const profileName = options.profile || DEFAULT_PROFILE;
  const field = 'secondaryColors';

  if (groundTruth === 'not_applicable') {
    return isAbsent(prediction)
      ? result(field, DISPOSITIONS.CORRECT, 'not applicable and empty', {}, profileName)
      : result(field, DISPOSITIONS.INCORRECT, 'populated where not applicable', {}, profileName);
  }
  if (isUncertainty(groundTruth)) {
    if (isAbsent(prediction)) {
      return result(field, DISPOSITIONS.CORRECT_ABSTENTION, 'abstained on uncertain secondary colors', {}, profileName);
    }
    return result(field, DISPOSITIONS.UNSUPPORTED_CERTAINTY, 'asserted secondary colors against uncertain ground truth', {}, profileName);
  }

  const truth = (Array.isArray(groundTruth) ? groundTruth : []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const pred = (Array.isArray(prediction) ? prediction : []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);

  if (truth.length === 0) {
    return result(field, DISPOSITIONS.UNSCORABLE, 'empty ground-truth set', {}, profileName);
  }
  if (pred.length === 0) {
    return result(field, DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS, 'no secondary colors predicted', {}, profileName);
  }

  const truthSet = new Set(truth);
  const hits = pred.filter((p) => truthSet.has(p)).length;
  if (hits === truthSet.size && pred.length === truthSet.size) {
    return result(field, DISPOSITIONS.CORRECT, 'exact secondary color set', {}, profileName);
  }
  if (hits > 0) {
    return result(field, DISPOSITIONS.ACCEPTABLY_BROAD, 'partial secondary color overlap', {}, profileName);
  }
  return result(field, DISPOSITIONS.INCORRECT, 'no secondary color overlap', {}, profileName);
}

function scoreBrand(groundTruth, prediction, options = {}) {
  const base = scoreField('brand', groundTruth, prediction, options);
  const falsePositive =
    base.disposition === DISPOSITIONS.UNSUPPORTED_CERTAINTY && isConcrete(prediction);
  return { ...base, brandFalsePositive: falsePositive };
}

/**
 * Exact product. Note measurement ceiling MC-1: the deployed V2 path always
 * returns exactProduct: null, so a concrete prediction here can only originate
 * from a non-production runner or a changed bundle.
 */
function scoreExactProduct(groundTruth, prediction, expectedResultType, options = {}) {
  const base = scoreField('exactProduct', groundTruth, prediction, options);
  const claimedUnderInsufficientEvidence =
    expectedResultType === 'insufficient_evidence' && isConcrete(prediction);

  if (claimedUnderInsufficientEvidence && base.disposition !== DISPOSITIONS.UNSUPPORTED_CERTAINTY) {
    return {
      ...result(
        'exactProduct',
        DISPOSITIONS.UNSUPPORTED_CERTAINTY,
        'exact product claimed under insufficient evidence',
        {},
        options.profile || DEFAULT_PROFILE
      ),
      incorrectExactMatch: true,
    };
  }
  return {
    ...base,
    incorrectExactMatch:
      base.disposition === DISPOSITIONS.UNSUPPORTED_CERTAINTY && isConcrete(prediction),
  };
}

function scoreAbstention(label, prediction, options = {}) {
  const profileName = options.profile || DEFAULT_PROFILE;
  const expected = Boolean(label.expectedAbstention);
  const pred = prediction || {};
  const predictedAbstain =
    pred.abstained === true ||
    pred.expectedResultType === 'insufficient_evidence' ||
    pred.status === 'insufficient_visual_evidence' ||
    pred.status === 'non_fashion' ||
    pred.status === 'technical_failure';

  if (expected === predictedAbstain) {
    return result(
      'abstention',
      DISPOSITIONS.CORRECT_ABSTENTION,
      expected ? 'correct abstention' : 'no abstention expected or taken',
      {},
      profileName
    );
  }
  return result(
    'abstention',
    DISPOSITIONS.INCORRECT_ABSTENTION,
    expected ? 'failed to abstain when abstention expected' : 'abstained when identification was expected',
    {},
    profileName
  );
}

/** Result-state scoring delegates to the versioned production mapping. */
function scoreResultType(label, prediction, options = {}) {
  const profileName = options.profile || DEFAULT_PROFILE;
  const scored = resultState.scoreResultState(label, prediction);
  const disposition =
    scored.disposition === 'under_identification'
      ? DISPOSITIONS.UNDER_IDENTIFICATION
      : scored.disposition;
  return {
    ...scored,
    disposition,
    penalty: penaltyFor('expectedResultType', disposition, profileName),
    profile: profileName,
  };
}

/**
 * Score one case under a single weighting profile.
 */
function scoreCase(label, prediction, options = {}) {
  const profileName = options.profile || DEFAULT_PROFILE;
  const pred = prediction || {};
  const opts = { profile: profileName, evidenceStrength: label.labelEvidenceStrength };

  const nonFashion = resultState.scoreNonFashion(label, pred);
  const nonFashionScored = {
    ...nonFashion,
    penalty: penaltyFor('nonFashion', nonFashion.disposition, profileName),
    profile: profileName,
  };

  const fields = [
    scoreField('category', label.category, pred.category, opts),
    scoreField('clothingType', label.clothingType, pred.clothingType, opts),
    scoreField('subtype', label.subtype, pred.subtype, opts),
    scoreField('primaryColor', label.primaryColor, pred.primaryColor, opts),
    scoreSecondaryColors(label.secondaryColors, pred.secondaryColors, opts),
    scoreField('material', label.material, pred.material, opts),
    scoreField('pattern', label.pattern, pred.pattern, opts),
    scoreBrand(label.brand, pred.brand, opts),
    scoreExactProduct(label.exactProduct, pred.exactProduct, label.expectedResultType, opts),
    scoreResultType(label, pred, opts),
    scoreAbstention(label, pred, opts),
    nonFashionScored,
  ];

  const totalPenalty = fields.reduce((sum, f) => sum + (f.penalty || 0), 0);
  const dispositionCounts = {};
  for (const f of fields) {
    dispositionCounts[f.disposition] = (dispositionCounts[f.disposition] || 0) + 1;
  }

  return {
    caseId: label.caseId,
    datasetVersion: label.datasetVersion,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    ontologyVersions: ontology.ONTOLOGY_VERSIONS,
    resultStateMappingVersion: resultState.MAPPING_VERSION,
    profile: profileName,
    fields,
    totalPenalty,
    dispositionCounts,
    flags: {
      brandFalsePositive: fields.some((f) => f.brandFalsePositive),
      incorrectExactMatch: fields.some((f) => f.incorrectExactMatch),
      nonFashionFalsePositive: fields.some((f) => f.nonFashionFalsePositive),
      underIdentification: fields.some((f) => f.disposition === DISPOSITIONS.UNDER_IDENTIFICATION),
      contractCeilingAttributable: fields.some((f) => f.contractCeilingAttributable),
      schemaParseFailure: Boolean(pred.schemaParseFailure),
      fallbackInvoked: Boolean(pred.fallbackInvoked),
    },
  };
}

/** Score a case under every profile. Reports must present both. */
function scoreCaseAllProfiles(label, prediction) {
  const out = {};
  for (const profileName of Object.keys(TRUST_WEIGHTS.profiles)) {
    out[profileName] = scoreCase(label, prediction, { profile: profileName });
  }
  return out;
}

function rate(counter) {
  if (!counter.n) return null;
  return counter.hit / counter.n;
}

/**
 * Aggregate case scores into dataset-level metrics.
 *
 * Commerce metrics are present but fixed at not_measured — the first baseline
 * is an identification baseline and commerce is disabled.
 */
function aggregateScores(caseScores) {
  const metrics = {
    caseCount: caseScores.length,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    profile: caseScores.length ? caseScores[0].profile : null,
    meanPenalty: 0,
    categoryCorrectRate: null,
    clothingTypeCorrectRate: null,
    subtypeCorrectRate: null,
    primaryColorCorrectRate: null,
    materialCorrectRate: null,
    brandPrecisionSignals: { concretePredictions: 0, correct: 0, falsePositives: 0 },
    exactProductSignals: { concretePredictions: 0, incorrectExactMatchClaims: 0 },
    abstention: { correct: 0, incorrect: 0 },
    nonFashion: { cases: 0, correct: 0, falsePositives: 0, incorrectAbstentions: 0 },
    nonFashionFalsePositiveRate: null,
    underIdentification: { count: 0, contractCeilingAttributable: 0 },
    schemaParseFailureRate: 0,
    fallbackInvocationRate: 0,
    dispositionTotals: {},
    commerce: {
      commerceLinkValidity: 'not_measured',
      retailerRelevance: 'not_measured',
      duplicateSellerListings: 'not_measured',
      commerceCostUsd: 0,
      note: 'Commerce disabled for the identification baseline. No commerce claim may be made from this run.',
    },
  };

  if (caseScores.length === 0) return metrics;

  let penaltySum = 0;
  let schemaFailures = 0;
  let fallbacks = 0;

  const fieldCorrect = {
    category: { hit: 0, n: 0 },
    clothingType: { hit: 0, n: 0 },
    subtype: { hit: 0, n: 0 },
    primaryColor: { hit: 0, n: 0 },
    material: { hit: 0, n: 0 },
  };

  for (const score of caseScores) {
    penaltySum += score.totalPenalty;
    if (score.flags.schemaParseFailure) schemaFailures += 1;
    if (score.flags.fallbackInvoked) fallbacks += 1;
    if (score.flags.brandFalsePositive) metrics.brandPrecisionSignals.falsePositives += 1;
    if (score.flags.incorrectExactMatch) metrics.exactProductSignals.incorrectExactMatchClaims += 1;
    if (score.flags.underIdentification) {
      metrics.underIdentification.count += 1;
      if (score.flags.contractCeilingAttributable) {
        metrics.underIdentification.contractCeilingAttributable += 1;
      }
    }

    for (const field of score.fields) {
      metrics.dispositionTotals[field.disposition] =
        (metrics.dispositionTotals[field.disposition] || 0) + 1;

      if (field.field === 'brand') {
        if (field.disposition === DISPOSITIONS.CORRECT) {
          metrics.brandPrecisionSignals.correct += 1;
          metrics.brandPrecisionSignals.concretePredictions += 1;
        } else if (field.brandFalsePositive) {
          metrics.brandPrecisionSignals.concretePredictions += 1;
        }
      }
      if (field.field === 'exactProduct' && field.incorrectExactMatch) {
        metrics.exactProductSignals.concretePredictions += 1;
      }
      if (field.field === 'abstention') {
        if (field.disposition === DISPOSITIONS.CORRECT_ABSTENTION) metrics.abstention.correct += 1;
        if (field.disposition === DISPOSITIONS.INCORRECT_ABSTENTION) metrics.abstention.incorrect += 1;
      }
      if (field.field === 'nonFashion' && field.disposition !== DISPOSITIONS.UNSCORABLE) {
        metrics.nonFashion.cases += 1;
        if (field.disposition === DISPOSITIONS.CORRECT) metrics.nonFashion.correct += 1;
        if (field.nonFashionFalsePositive) metrics.nonFashion.falsePositives += 1;
        if (field.incorrectAbstention) metrics.nonFashion.incorrectAbstentions += 1;
      }
      if (fieldCorrect[field.field] && field.disposition !== DISPOSITIONS.UNSCORABLE) {
        fieldCorrect[field.field].n += 1;
        if (
          field.disposition === DISPOSITIONS.CORRECT ||
          field.disposition === DISPOSITIONS.ACCEPTABLY_BROAD ||
          field.disposition === DISPOSITIONS.CORRECT_ABSTENTION
        ) {
          fieldCorrect[field.field].hit += 1;
        }
      }
    }
  }

  metrics.meanPenalty = penaltySum / caseScores.length;
  metrics.schemaParseFailureRate = schemaFailures / caseScores.length;
  metrics.fallbackInvocationRate = fallbacks / caseScores.length;
  metrics.categoryCorrectRate = rate(fieldCorrect.category);
  metrics.clothingTypeCorrectRate = rate(fieldCorrect.clothingType);
  metrics.subtypeCorrectRate = rate(fieldCorrect.subtype);
  metrics.primaryColorCorrectRate = rate(fieldCorrect.primaryColor);
  metrics.materialCorrectRate = rate(fieldCorrect.material);
  metrics.nonFashionFalsePositiveRate = metrics.nonFashion.cases
    ? metrics.nonFashion.falsePositives / metrics.nonFashion.cases
    : null;
  return metrics;
}

module.exports = {
  SCORING_CONTRACT_VERSION,
  DISPOSITIONS,
  PROFILES,
  DEFAULT_PROFILE,
  TRUST_WEIGHTS,
  FIELD_WEIGHTS,
  PENALTY_MULTIPLIERS,
  penaltyFor,
  scoreField,
  scoreSecondaryColors,
  scoreBrand,
  scoreExactProduct,
  scoreAbstention,
  scoreResultType,
  scoreCase,
  scoreCaseAllProfiles,
  aggregateScores,
  isBroadMatch,
  normalizeToken: (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' ')),
};
