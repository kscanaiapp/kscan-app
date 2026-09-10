'use strict';

/**
 * Real Fashion Match Corpus V1 - shared vocabulary and policy versions.
 *
 * Every enum here is closed. A value not listed is a validation error, never
 * a silently-accepted free-text field: the whole point of the corpus is that
 * a later reader can trust what a label means.
 */

const GARMENT_SCHEMA_VERSION = 'rfc-garment-schema-v1';
const CASE_SCHEMA_VERSION = 'rfc-case-schema-v1';
const GRADE_RULES_VERSION = 'rfc-ground-truth-grade-rules-v1';
const EXIF_POLICY_VERSION = 'rfc-exif-policy-v1';
const QC_POLICY_VERSION = 'rfc-qc-policy-v1';
const CAPTURE_PROFILE_POLICY_VERSION = 'rfc-capture-profile-policy-v1';
const CORPUS_ARTIFACT_SCHEMA_VERSION = 'rfc-corpus-artifact-schema-v1';

/* ------------------------------------------------------------------ *
 * Ground truth (mission sections 5 + 6)
 * ------------------------------------------------------------------ */

/** Grades, ordered strongest -> weakest. */
const GROUND_TRUTH_GRADES = Object.freeze(['IDENTIFIER_GRADE', 'PARTIAL', 'VISUAL_ONLY']);

/**
 * Traceable, non-model evidence types. This list is exactly mission section
 * 5's allow-list. Adding to it is a deliberate policy change that must bump
 * GRADE_RULES_VERSION.
 */
const ALLOWED_EVIDENCE_TYPES = Object.freeze([
  'MANUFACTURER_TAG',
  'MANUFACTURER_PRODUCT_PAGE',
  'RETAILER_PDP',
  'GTIN_UPC_EAN',
  'MANUFACTURER_STYLE_CODE',
  'PURCHASE_RECORD',
  'DIRECT_OWNER_KNOWLEDGE',
  'OTHER_VERIFIABLE_PRODUCT_EVIDENCE',
]);

/**
 * Model-derived "evidence". The model being evaluated may never create its
 * own truth (mission section 5). These are rejected by the schema, by
 * ingestion, and again by the independent validator - three independent
 * refusals, because a single check is a single point of failure.
 */
const FORBIDDEN_EVIDENCE_TYPES = Object.freeze([
  'KSCAN_RESULT',
  'SCANNER_OUTPUT',
  'GEMINI_OUTPUT',
  'LLAMA_OUTPUT',
  'LLM_GENERATED_SKU',
  'LLM_INFERRED_BRAND',
  'LLM_INFERRED_MODEL',
  'MODEL_DERIVED_LABEL',
  'AI_GENERATED',
]);

/* ------------------------------------------------------------------ *
 * Corpus tiers (mission section 26)
 * ------------------------------------------------------------------ */

const ASSET_TIER_REAL = 'REAL_CAPTURE';
const ASSET_TIER_PIPELINE_TEST = 'PIPELINE_TEST_ASSET';
const ASSET_TIERS = Object.freeze([ASSET_TIER_REAL, ASSET_TIER_PIPELINE_TEST]);

/* ------------------------------------------------------------------ *
 * Collection (mission sections 10, 16, 35)
 * ------------------------------------------------------------------ */

const COLLECTION_SOURCES = Object.freeze([
  'OWNER_TEAM_GARMENT',
  'AUTHORIZED_IN_STORE',
  'OTHER_AUTHORIZED_PHYSICAL',
]);

/** Prefer garment-only presentations (mission section 16). */
const CAPTURE_TYPES = Object.freeze(['HANGER', 'FLAT_LAY', 'MANNEQUIN', 'GARMENT_ONLY', 'WORN']);

const CONSENT_STATUSES = Object.freeze([
  'NOT_APPLICABLE', // no human present in frame
  'EXPLICIT_COLLECTOR_CONSENT',
]);

const CAPTURE_ENVIRONMENTS = Object.freeze([
  'INDOOR_ARTIFICIAL',
  'INDOOR_NATURAL',
  'INDOOR_MIXED',
  'OUTDOOR_DAYLIGHT',
  'OUTDOOR_OVERCAST',
  'LOW_LIGHT',
  'RETAIL_FLOOR',
]);

const PLATFORMS = Object.freeze(['ios', 'android']);

/** FMQL's own capture-profile identifiers - reused, not redefined. */
const CAPTURE_PROFILES = Object.freeze(['ios-current-v1', 'android-current-v1', 'profile-neutral']);

/* ------------------------------------------------------------------ *
 * Case lifecycle (mission section 24)
 * ------------------------------------------------------------------ */

const CASE_STATUSES = Object.freeze([
  'PLANNED',
  'CAPTURED',
  'GROUND_TRUTH_PENDING',
  'QC_PENDING',
  'VALID',
  'REJECTED',
]);

const PARTITIONS = Object.freeze(['development', 'holdout']);

/* ------------------------------------------------------------------ *
 * Category strategy (mission section 12)
 *
 * Derived from K Scan's own taxonomy rather than invented - see
 * docs/POWER_CLAIM_MAP.md for why these seven and not more.
 * ------------------------------------------------------------------ */

const CATEGORIES = Object.freeze([
  'top',
  'dress',
  'pants',
  'outerwear',
  'footwear',
  'bag',
  'accessory',
]);

/* ------------------------------------------------------------------ *
 * Difficulty strata (mission section 13)
 *
 * A case may carry several. The taxonomy deliberately mixes garment-intrinsic
 * difficulty (dark, unpatterned, no logo) with corpus-relational difficulty
 * (a same-brand adjacent style is only hard because a sibling exists).
 * ------------------------------------------------------------------ */

const DIFFICULTY_STRATA = Object.freeze([
  'VISIBLE_LOGO',
  'NO_VISIBLE_LOGO',
  'DARK_GARMENT',
  'LIGHT_GARMENT',
  'MID_TONE_GARMENT',
  'SOLID_COLOR',
  'PATTERNED',
  'HIGH_TEXTURE',
  'MINIMAL_TEXTURE',
  'COMMON_SILHOUETTE',
  'UNUSUAL_SILHOUETTE',
  'SAME_BRAND_ADJACENT_STYLE',
  'COLORWAY_SIBLING',
  'MATERIAL_VARIANT',
  'VISUALLY_SIMILAR_DISTINCT_PRODUCT',
]);

/**
 * Two kinds of hard negative, kept distinct (mission section 14).
 *
 *  INPUT_HARD_NEGATIVE      - a real captured garment easy to confuse with
 *                             another known product. Requires a real capture,
 *                             so it is a property of a CASE.
 *  RESULT_SET_HARD_NEGATIVE - a distinct product the correct scanned item
 *                             should not be confused with. Needs identity
 *                             evidence but no separate photograph, so it is a
 *                             property of a GARMENT.
 *
 * Conflating these would let a metadata-only record inflate the real capture
 * count, which is exactly what section 14 guards against.
 */
const HARD_NEGATIVE_KINDS = Object.freeze(['INPUT_HARD_NEGATIVE', 'RESULT_SET_HARD_NEGATIVE']);

const IMAGE_FORMATS = Object.freeze(['jpeg', 'png']);

/* ------------------------------------------------------------------ *
 * Garment-level spatial annotation (V2 - Workstream 04 segmentation
 * readiness). A case's `garments[]` entries carry these; see
 * lib/recordSchema.js#validateCase and docs/DESIGN.md DM-09.
 * ------------------------------------------------------------------ */

const OCCLUSION_LEVELS = Object.freeze(['none', 'partial', 'heavy']);
const RELATIVE_SIZE_LEVELS = Object.freeze(['normal', 'small']);

/* ------------------------------------------------------------------ *
 * Fashion failure taxonomy (V2). Classifies the real failure mode a case is
 * meant to exercise, distinct from `DIFFICULTY_STRATA` above:
 * DIFFICULTY_STRATA describes properties of the garment/photograph itself,
 * while this taxonomy names the kind of MATCHING MISTAKE the case is built
 * to surface (a garment can carry both - e.g. DARK_GARMENT strata and a
 * BLACK_NAVY_CONFUSION failure-taxonomy entry are complementary, not
 * duplicative).
 * ------------------------------------------------------------------ */

const FAILURE_TAXONOMY = Object.freeze([
  'EXACT_SAME_PRODUCT',
  'SAME_PRODUCT_DIFFERENT_COLOR',
  'SAME_STYLE_DIFFERENT_VARIANT',
  'VISUALLY_SIMILAR_COMPETITOR',
  'SAME_COLOR_WRONG_SILHOUETTE',
  'BLACK_NAVY_CONFUSION',
  'MATERIAL_CONFUSION',
  'PATTERN_CONFUSION',
  'PARTIAL_GARMENT',
  'OCCLUDED_GARMENT',
  'MULTI_GARMENT',
  'SMALL_GARMENT',
  'STREET_LIGHTING',
  'LOW_LIGHT',
  'RETAILER_PHOTOGRAPHY',
  'ACCESSORY_APPAREL_MIX',
]);

/** Mission section 39 - stamped on every artifact this lane produces. */
const BENCHMARK_STATUS = 'INTERNAL ENGINEERING EVIDENCE ONLY';

/** Mission section 32 - not a configurable knob in code. */
const AUTHORIZED_LIVE_EVALUATION_SPEND_USD = 0;

/** Mission section 22 - never "training". */
const EVALUATION_SET_TERMS = Object.freeze({
  development: 'DEVELOPMENT EVALUATION SET',
  holdout: 'HOLDOUT EVALUATION SET',
});

module.exports = {
  GARMENT_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  GRADE_RULES_VERSION,
  EXIF_POLICY_VERSION,
  QC_POLICY_VERSION,
  CAPTURE_PROFILE_POLICY_VERSION,
  CORPUS_ARTIFACT_SCHEMA_VERSION,
  GROUND_TRUTH_GRADES,
  ALLOWED_EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPES,
  ASSET_TIER_REAL,
  ASSET_TIER_PIPELINE_TEST,
  ASSET_TIERS,
  COLLECTION_SOURCES,
  CAPTURE_TYPES,
  CONSENT_STATUSES,
  CAPTURE_ENVIRONMENTS,
  PLATFORMS,
  CAPTURE_PROFILES,
  CASE_STATUSES,
  PARTITIONS,
  CATEGORIES,
  DIFFICULTY_STRATA,
  HARD_NEGATIVE_KINDS,
  IMAGE_FORMATS,
  OCCLUSION_LEVELS,
  RELATIVE_SIZE_LEVELS,
  FAILURE_TAXONOMY,
  BENCHMARK_STATUS,
  AUTHORIZED_LIVE_EVALUATION_SPEND_USD,
  EVALUATION_SET_TERMS,
};
