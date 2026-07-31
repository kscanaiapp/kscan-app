'use strict';

/**
 * Multi-image (same-item set) evaluation (Phase 0B section 4.10).
 *
 * PRODUCTION CONSTRAINT, VERIFIED NOT ASSUMED:
 * Deployed scan-identify v140 accepts a single V2 evidence item on the
 * identification path. This module therefore NEVER emits a consolidated
 * multi-image production call. Each image in a governed set is executed
 * independently through the existing single-image pipeline, and consolidation
 * happens here, offline, at scoring time.
 *
 * Offline reconciliation experiments may later be added under
 * experiments/scanner-accuracy-v2/reconciliation/. They are candidates and must
 * never be reported as the production baseline.
 *
 * EVIDENCE PRECEDENCE: direct evidence outranks inferred style resemblance.
 * A logo or label angle that shows a brand beats three angles that merely look
 * like that brand. This mirrors the production brand-provenance ordering
 * (visible_text / logo_shape are direct; visual is inference).
 */

const ANGLE_HINTS = Object.freeze(['front', 'back', 'side', 'detail', 'logo', 'label', 'unknown']);

/** Angles that can carry direct brand or product evidence. */
const DIRECT_EVIDENCE_ANGLES = Object.freeze(['logo', 'label', 'detail']);

/** Production brand provenances that count as direct evidence. */
const DIRECT_PROVENANCES = Object.freeze(['visible_text', 'logo_shape']);

const CONFLICT = 'conflicting_evidence';

function normalize(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return text.length ? text : null;
}

function isDirectEvidence(perImage) {
  if (!perImage) return false;
  if (DIRECT_EVIDENCE_ANGLES.includes(perImage.angleHint)) return true;
  const provenance = perImage.result && perImage.result.item && perImage.result.item.brand
    ? perImage.result.item.brand.provenance
    : null;
  return DIRECT_PROVENANCES.includes(provenance);
}

function extractField(perImage, field) {
  const item = perImage && perImage.result && perImage.result.item;
  if (!item) return null;
  switch (field) {
    case 'category':
      return normalize(item.category);
    case 'subtype':
      return normalize(item.subtype);
    case 'brand':
      return normalize(item.brand ? item.brand.value : null);
    case 'primaryColor':
      return normalize(item.colors ? item.colors.primary : null);
    case 'material':
      return normalize(Array.isArray(item.material) ? item.material[0] : item.material);
    default:
      return null;
  }
}

/**
 * Per-image agreement for one field across a set.
 *
 * @returns {{ field: string, values: Array, distinct: Array<string>, agreementRate: number|null,
 *             consensus: string|null, conflict: boolean, resolvedBy: string|null }}
 */
function analyzeField(perImages, field) {
  const observations = perImages.map((img) => ({
    evidenceId: img.evidenceId,
    angleHint: img.angleHint || 'unknown',
    value: extractField(img, field),
    direct: isDirectEvidence(img),
  }));

  const answered = observations.filter((o) => o.value != null);
  const distinct = [...new Set(answered.map((o) => o.value))];

  if (answered.length === 0) {
    return {
      field,
      observations,
      distinct: [],
      answeredCount: 0,
      agreementRate: null,
      consensus: null,
      conflict: false,
      resolvedBy: null,
      note: 'no image produced a value for this field',
    };
  }

  // Agreement rate = share of answering images holding the modal value.
  const counts = new Map();
  for (const o of answered) counts.set(o.value, (counts.get(o.value) || 0) + 1);
  let modal = null;
  let modalCount = 0;
  for (const value of distinct) {
    const count = counts.get(value);
    if (count > modalCount) {
      modal = value;
      modalCount = count;
    }
  }
  const agreementRate = modalCount / answered.length;

  if (distinct.length === 1) {
    return {
      field,
      observations,
      distinct,
      answeredCount: answered.length,
      agreementRate: 1,
      consensus: distinct[0],
      conflict: false,
      resolvedBy: 'unanimous',
    };
  }

  // Disagreement. Direct evidence wins over inference.
  const directValues = [...new Set(answered.filter((o) => o.direct).map((o) => o.value))];
  if (directValues.length === 1) {
    return {
      field,
      observations,
      distinct,
      answeredCount: answered.length,
      agreementRate,
      consensus: directValues[0],
      conflict: false,
      resolvedBy: 'direct_evidence_precedence',
      directEvidenceChangedConclusion: directValues[0] !== modal,
    };
  }
  if (directValues.length > 1) {
    return {
      field,
      observations,
      distinct,
      answeredCount: answered.length,
      agreementRate,
      consensus: CONFLICT,
      conflict: true,
      resolvedBy: null,
      note: 'two or more direct-evidence images disagree',
    };
  }

  // No direct evidence anywhere; a bare majority of inferences is not a
  // resolution. Inference does not become fact by repetition.
  return {
    field,
    observations,
    distinct,
    answeredCount: answered.length,
    agreementRate,
    consensus: CONFLICT,
    conflict: true,
    resolvedBy: null,
    note: 'inference-only disagreement across angles; not resolved by majority',
  };
}

const CONSISTENCY_FIELDS = Object.freeze(['category', 'subtype', 'brand', 'primaryColor', 'material']);

/**
 * Analyze a governed multi-image case.
 *
 * @param {object} label governed case with imageReferences[] and sameItemAcrossImages
 * @param {Array<object>} perImages [{ evidenceId, angleHint, result }]
 */
function analyzeImageSet(label, perImages) {
  const images = Array.isArray(perImages) ? perImages : [];

  if (label.sameItemAcrossImages !== true && images.length > 1) {
    return {
      caseId: label.caseId,
      imageCount: images.length,
      scorable: false,
      reason:
        'reviewers have not confirmed these images show the same item; set-level truth cannot be applied',
      fields: {},
    };
  }

  const fields = {};
  for (const field of CONSISTENCY_FIELDS) {
    fields[field] = analyzeField(images, field);
  }

  const conflicting = CONSISTENCY_FIELDS.filter((f) => fields[f].conflict);
  const rates = CONSISTENCY_FIELDS.map((f) => fields[f].agreementRate).filter((r) => r != null);

  return {
    caseId: label.caseId,
    imageCount: images.length,
    scorable: true,
    perImageConsistency: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    disagreementFieldCount: CONSISTENCY_FIELDS.filter((f) => fields[f].distinct.length > 1).length,
    conflictingFields: conflicting,
    directEvidenceChangedConclusion: CONSISTENCY_FIELDS.some(
      (f) => fields[f].directEvidenceChangedConclusion === true
    ),
    fields,
    // Fields marked conflicting are reported separately and are NOT scored as
    // model errors — the set itself does not carry a resolvable answer.
    unscorableFields: conflicting,
  };
}

/**
 * Build the consolidated set-level prediction used for scoring, with
 * conflicting fields omitted rather than guessed.
 */
function consolidateSetPrediction(analysis) {
  if (!analysis || !analysis.scorable) return { unscorable: true };
  const out = {};
  for (const field of CONSISTENCY_FIELDS) {
    const node = analysis.fields[field];
    if (!node || node.conflict || node.consensus == null) continue;
    out[field] = node.consensus;
  }
  return out;
}

module.exports = {
  ANGLE_HINTS,
  DIRECT_EVIDENCE_ANGLES,
  DIRECT_PROVENANCES,
  CONSISTENCY_FIELDS,
  CONFLICT,
  isDirectEvidence,
  analyzeField,
  analyzeImageSet,
  consolidateSetPrediction,
};
