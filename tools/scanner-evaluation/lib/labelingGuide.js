'use strict';

/**
 * Executable rules for the Phase 1 labeling guide.
 *
 * These helpers do not add production fields or production enum values. They
 * make the evaluation-only decisions in docs/scanner-accuracy/labeling-guide.md
 * deterministic so guide drift cannot silently alter frozen ground truth.
 */

const GUIDE_VERSION = '1.0.0';

const UNAVAILABLE = Object.freeze({
  NOT_APPLICABLE: 'not_applicable',
  NOT_VISIBLE: 'not_visible',
  UNKNOWN: 'unknown',
});

const BRAND_EVIDENCE_STATES = Object.freeze({
  PRODUCT_LEVEL: 'product_level_evidence',
  CONTEXTUAL_ONLY: 'contextual_cue_only',
  NONE: 'no_reliable_evidence',
});

const SUBJECT_DESIGNATIONS = Object.freeze({
  MANIFEST_SPECIFIED: 'manifest_specified',
  UNAMBIGUOUSLY_DOMINANT: 'unambiguously_dominant',
  AMBIGUOUS_NO_DOMINANT: 'ambiguous_no_dominant',
});

const SAME_ITEM_SIGNALS = Object.freeze([
  'identical_wear',
  'matching_damage',
  'matching_handmade_variation',
  'matching_unique_markings',
  'matching_inscription_detail',
  'matching_hardware_placement',
  'matching_manufacturing_irregularities',
]);

const NON_FASHION_FIELDS = Object.freeze([
  'category',
  'clothingType',
  'subtype',
  'primaryColor',
  'secondaryColors',
  'material',
  'pattern',
  'brand',
  'exactProduct',
]);

function designateSubject({ manifestSubject = null, dominantSubject = null } = {}) {
  if (manifestSubject) {
    return {
      designation: SUBJECT_DESIGNATIONS.MANIFEST_SPECIFIED,
      subject: manifestSubject,
      expectedResultType: null,
      itemFieldValue: null,
    };
  }
  if (dominantSubject) {
    return {
      designation: SUBJECT_DESIGNATIONS.UNAMBIGUOUSLY_DOMINANT,
      subject: dominantSubject,
      expectedResultType: null,
      itemFieldValue: null,
    };
  }
  return {
    designation: SUBJECT_DESIGNATIONS.AMBIGUOUS_NO_DOMINANT,
    subject: null,
    expectedResultType: 'insufficient_evidence',
    itemFieldValue: UNAVAILABLE.UNKNOWN,
  };
}

function canonicalNonFashionLabels() {
  const labels = Object.fromEntries(
    NON_FASHION_FIELDS.map((field) => [field, UNAVAILABLE.NOT_APPLICABLE])
  );
  return {
    ...labels,
    nonFashion: true,
    expectedResultType: 'insufficient_evidence',
    expectedAbstention: true,
    brandEvidenceState: BRAND_EVIDENCE_STATES.NONE,
  };
}

function selectVisibleColor({ specificShade = null, broaderFamily = null } = {}) {
  if (specificShade) return specificShade;
  if (broaderFamily) return broaderFamily;
  return UNAVAILABLE.UNKNOWN;
}

function classifyBrandEvidence({
  legibleWordmark = false,
  legibleLabel = false,
  productAttachedLogo = false,
  productCode = false,
  authoritativeObjectRecord = false,
  contextualCue = false,
} = {}) {
  const productLevel = [
    legibleWordmark,
    legibleLabel,
    productAttachedLogo,
    productCode,
    authoritativeObjectRecord,
  ].some(Boolean);
  if (productLevel) {
    return { state: BRAND_EVIDENCE_STATES.PRODUCT_LEVEL, positiveBrandAllowed: true };
  }
  if (contextualCue) {
    return { state: BRAND_EVIDENCE_STATES.CONTEXTUAL_ONLY, positiveBrandAllowed: false };
  }
  return { state: BRAND_EVIDENCE_STATES.NONE, positiveBrandAllowed: false };
}

function unavailableFromEvidence({ evidencePresent, mapsToAllowedValue } = {}) {
  if (!evidencePresent) return UNAVAILABLE.NOT_VISIBLE;
  if (!mapsToAllowedValue) return UNAVAILABLE.UNKNOWN;
  return null;
}

function exactProductMetricDisposition() {
  return Object.freeze({
    exactProductPrecision: 'not_measured',
    incorrectExactMatchRate: 'not_measured',
  });
}

function visiblePerson({
  liveFace = false,
  liveHand = false,
  liveArm = false,
  liveTorso = false,
  liveLeg = false,
  livePersonReflection = false,
} = {}) {
  return [liveFace, liveHand, liveArm, liveTorso, liveLeg, livePersonReflection].some(Boolean);
}

function samePhysicalItem({ explicitlyDesignatedSameItem = false, signals = [] } = {}) {
  if (explicitlyDesignatedSameItem) return true;
  const observed = new Set(Array.isArray(signals) ? signals : []);
  return SAME_ITEM_SIGNALS.some((signal) => observed.has(signal));
}

module.exports = {
  GUIDE_VERSION,
  UNAVAILABLE,
  BRAND_EVIDENCE_STATES,
  SUBJECT_DESIGNATIONS,
  SAME_ITEM_SIGNALS,
  NON_FASHION_FIELDS,
  designateSubject,
  canonicalNonFashionLabels,
  selectVisibleColor,
  classifyBrandEvidence,
  unavailableFromEvidence,
  exactProductMetricDisposition,
  visiblePerson,
  samePhysicalItem,
};
