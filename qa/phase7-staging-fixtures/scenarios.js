// Phase 7 pre-staging deterministic scenario fixtures.
//
// NOT accuracy evidence. Every request body here is synthetic and hand-built
// specifically to exercise one contract boundary; none of it is real user
// data, real provider output, or a claim about identification quality. These
// exist so the staging verification script (scripts/verify-phase7-staging.js)
// has a fixed, reviewable set of scenarios to run once the real staging
// environment is available — see Section 11 of the pre-staging integration
// brief this fixture set was built for.
//
// Each scenario names:
//   - request: the scan-identify request body to send
//   - flags: the EXPO_PUBLIC_* / env flags the scenario assumes are set, so
//     the verification script can assert-and-restore around it
//   - expect: contract assertions the script checks against the response
//   - productCountBaseline: an explicit baseline for
//     recommendedProducts.length (or null where none is established yet —
//     see the module docstring in scripts/verify-phase7-staging.js for the
//     P2/P3 product-count-deviation policy this baseline exists to support)

'use strict';

const NOW_LABEL = 'phase7-prestaging-2026-08-05';

/**
 * A tiny valid base64 JPEG (1x1 pixel). Real image bytes are not needed to
 * exercise the contract paths these scenarios test — the scan-identify
 * handler's provider call is what varies output, and these scenarios test
 * everything AROUND that call (flags, selection, bridge, similarity), not
 * provider accuracy.
 */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

const SCENARIOS = [
  {
    name: 'NO_NOTICE',
    description: 'Single-item scan, no closet/recent-scan overlap. Primary identification succeeds; no advisory notice.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-no-notice`,
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true', SIMILAR_ITEM_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      statusIn: ['completed', 'non_fashion', 'failed'],
      identificationV2ClothingTypePresentIfClassified: true,
      potentialSimilarItemAbsent: true,
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'CLOSET_SIMILARITY',
    description: 'Single-item scan with an existingItems candidate sourced from Closet that should produce a controlled advisory notice.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-closet-similarity`,
      existingItems: [
        {
          id: 'closet-fixture-1',
          source: 'closet',
          canonicalCategory: 'pants',
          clothingType: 'jeans',
          color: 'dark blue',
          material: 'denim',
        },
      ],
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true', SIMILAR_ITEM_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      potentialSimilarItemSourceIn: ['closet', null],
      neverEmitsIsDuplicate: true,
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'RECENT_SCAN_SIMILARITY',
    description: 'Same as CLOSET_SIMILARITY but the existingItems candidate is sourced from Recent Scans, which requires more evidence than Closet.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-recent-scan-similarity`,
      existingItems: [
        {
          id: 'recent-scan-fixture-1',
          source: 'recent_scan',
          canonicalCategory: 'pants',
          clothingType: 'jeans',
          color: 'dark blue',
          material: 'denim',
        },
      ],
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true', SIMILAR_ITEM_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      potentialSimilarItemSourceIn: ['recent_scan', null],
      neverEmitsIsDuplicate: true,
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'MULTI_ITEM_SELECTION_REQUIRED',
    description: 'A scan the multi-item detector should flag as ambiguous. Fixture cannot force provider detection deterministically without a live provider call — staging run must supply a real multi-garment image and record the actual outcome.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-multi-item-selection`,
      useMultiItemDetectionProvider: true,
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      ifSelectionRequired: {
        selectionRequired: true,
        selectionCandidatesMinLength: 2,
        selectionCandidatesRetainClothingTypeWhenSupplied: true,
        legacyIdentificationAbsent: true,
        v2ItemCategorySubtypeClothingTypeAllNull: true,
      },
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'SELECTED_ITEM_FOLLOWUP',
    description: 'The selected-item request that follows MULTI_ITEM_SELECTION_REQUIRED. Depends on a real selectionToken from a prior live detection — staging run must chain these two calls, not fabricate a token.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-selected-item-followup`,
      selectedCandidate: {
        candidateId: '<FROM_PRIOR_DETECTION_RESPONSE>',
        evidenceId: '<FROM_PRIOR_DETECTION_RESPONSE>',
        category: '<FROM_PRIOR_DETECTION_RESPONSE>',
        clothingType: '<FROM_PRIOR_DETECTION_RESPONSE_IF_PRESENT>',
        subtype: '<FROM_PRIOR_DETECTION_RESPONSE>',
      },
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      statusIn: ['completed', 'non_fashion', 'failed'],
      identificationV2ClothingTypeIndependentlyIdentified: true,
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'UNCERTAIN_CLOTHING_TYPE',
    description: 'A scan expected to yield an uncertain/unsupported middle-tier value. Real uncertainty depends on live provider behavior — staging run records the actual token returned and confirms it is never fabricated into a concrete value or used to build an aggressive commerce query.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-uncertain-clothingtype`,
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true' },
    expect: {
      httpStatus: 200,
      clothingTypeUncertaintyTokensAllowed: ['unknown', 'not_visible', 'not_applicable', null],
      clothingTypeNeverCountsAsAnswered: true,
    },
    productCountBaseline: { source: 'not_yet_measured', date: null, range: null },
  },
  {
    name: 'PRODUCT_MATCH_TIMEOUT',
    description: 'Product-match bridge enabled but the downstream call cannot complete in time. Scanner identification must remain intact (fail-open).',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-product-match-timeout`,
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'true', PRODUCT_MATCH_INTERNAL_SECRET: '<INTENTIONALLY_WRONG_TO_FORCE_REJECTION>' },
    expect: {
      httpStatus: 200,
      primaryIdentificationPresent: true,
      productMatchSkipReasonIn: ['rejected', 'unreachable', 'timeout', 'not_configured'],
    },
    productCountBaseline: { source: 'not_applicable', date: null, range: null },
  },
  {
    name: 'FEATURE_FLAG_ROLLBACK',
    description: 'Every new flag OFF. Response must be the legacy/baseline scanner behavior.',
    request: {
      mode: 'image',
      image: TINY_JPEG_BASE64,
      scanSessionId: `${NOW_LABEL}-flag-rollback`,
    },
    flags: { SCAN_PRODUCT_MATCH_ENABLED: 'false', SIMILAR_ITEM_ENABLED: 'false' },
    expect: {
      httpStatus: 200,
      productMatchBridgeNotAttempted: true,
      potentialSimilarItemAbsent: true,
      legacyResponseUnaffected: true,
    },
    productCountBaseline: { source: 'not_applicable', date: null, range: null },
  },
];

module.exports = { SCENARIOS, TINY_JPEG_BASE64 };
