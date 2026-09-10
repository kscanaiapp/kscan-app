'use strict';

/**
 * Record builders for the invariant suite.
 *
 * IMPORTANT: nothing here is a real garment, a real capture, or real ground
 * truth. These builders exist to exercise schema/QC/ingestion machinery. Every
 * case they build is tagged PIPELINE_TEST_ASSET unless a test deliberately
 * flips the tier to prove the real-corpus validator rejects it
 * (mission section 26 + invariant 42.1).
 */

const {
  GARMENT_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  EXIF_POLICY_VERSION,
  ASSET_TIER_PIPELINE_TEST,
} = require('../../lib/constants');
const { buildGarmentOntology } = require('../../lib/ontology');

const ZERO_HASH = '0'.repeat(64);

/**
 * Merge `patch` over `base`.
 *
 * Objects merge key-by-key; `undefined` in a patch DELETES the key (that is
 * how a test says "this field is absent"). Arrays REPLACE rather than merge -
 * element-wise array merging reads clearly but behaves treacherously, since a
 * one-key patch element would silently inherit the rest of the base element
 * and a test could then pass for a reason it never intended. A test that wants
 * a different evidence record must write the whole record.
 */
function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key];
      continue;
    }
    out[key] = deepMerge(base && typeof base === 'object' ? base[key] : undefined, value);
  }
  return out;
}

/** An IDENTIFIER_GRADE, colorway-level, identity-eligible garment. */
function makeGarment(overrides) {
  const category = 'outerwear';
  const attributes = {
    silhouette: 'boxy',
    material: 'polyester',
    pattern: 'solid',
    colorFamily: 'navy',
    priceTier: 'mid',
    genderPresentation: 'unisex',
  };
  const base = {
    recordType: 'GARMENT',
    schemaVersion: GARMENT_SCHEMA_VERSION,
    garmentId: 'G001',
    category,
    // V2: every garment carries a CanonicalFashionAttributesV1 block, always
    // computed the same way production intake computes it - from `category`
    // and `attributes` - so this fixture never drifts from real behavior. A
    // test that wants an invalid/tampered ontology overrides this key
    // directly (see tests/ontology.test.js's negative-control anchor).
    ontology: buildGarmentOntology({ category, attributes }),
    collection: {
      collectorId: 'COL-TEST-01',
      source: 'OWNER_TEAM_GARMENT',
    },
    groundTruth: {
      assertedGrade: 'IDENTIFIER_GRADE',
      identity: {
        style: {
          brand: 'Test Brand',
          productName: 'Test Quilted Jacket',
          styleCode: 'TB-QJ-1200',
        },
        variant: {
          colorwayName: 'Deep Navy',
          colorwayCode: 'NVY-401',
          gtin: '0123456789012',
          size: 'M',
        },
      },
      evidence: [
        {
          evidenceType: 'MANUFACTURER_TAG',
          verifiedOn: '2026-09-01',
          verifiedBy: 'COL-TEST-01',
          observedFacts: {
            brandOnTag: 'Test Brand',
            styleCodeOnTag: 'TB-QJ-1200',
            colorwayOnTag: 'Deep Navy / NVY-401',
            materialOnTag: '100% recycled polyester',
          },
        },
      ],
      catalogStateVerifiedOn: '2026-09-01',
    },
    attributes,
    revisions: [],
  };
  return deepMerge(base, overrides);
}

/** A PIPELINE_TEST_ASSET case attached to the garment above. */
function makeCase(overrides) {
  const base = {
    recordType: 'CASE',
    schemaVersion: CASE_SCHEMA_VERSION,
    caseId: 'C0001',
    garmentId: 'G001',
    assetTier: ASSET_TIER_PIPELINE_TEST,
    pipelineTestPurpose: 'exercise schema/QC/ingestion machinery in the invariant suite',
    status: 'VALID',
    partition: 'development',
    capture: {
      device: { platform: 'ios', model: 'Test Device 1' },
      captureProfile: 'ios-current-v1',
      captureType: 'HANGER',
      environment: 'INDOOR_ARTIFICIAL',
      capturedOn: '2026-09-01',
      capturedDimensions: { width: 4032, height: 3024 },
      processedDimensions: { width: 1024, height: 768 },
      uploadedDimensions: { width: 896, height: 672 },
      format: 'png',
      consent: { humanPresent: false, consentStatus: 'NOT_APPLICABLE' },
    },
    asset: {
      assetPath: 'G001/C0001-ios.png',
      sha256: ZERO_HASH,
      byteSize: 1024,
      exifSanitization: {
        policyVersion: EXIF_POLICY_VERSION,
        sanitizedOn: '2026-09-01T00:00:00.000Z',
        locationStripped: true,
      },
    },
    difficultyStrata: ['NO_VISIBLE_LOGO', 'DARK_GARMENT', 'SOLID_COLOR'],
  };
  return deepMerge(base, overrides);
}

module.exports = { makeGarment, makeCase, deepMerge, ZERO_HASH };
