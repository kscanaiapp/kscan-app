'use strict';

const { assertPrivacySafe, scanForPrivacyViolations } = require('./privacyGuard');

const SCHEMA_VERSION = 'fmql-fixture-schema-v1';

const VALID_CORPUS_TIERS = ['SYNTHETIC', 'APPROVED_REAL'];
const VALID_GROUND_TRUTH_SOURCES = [
  'synthetic_generator_construction', // section 15 synthetic carve-out
  'retailer_pdp',
  'manufacturer_specification',
  'known_sku_metadata',
  'owner_annotation',
  'exploratory_non_authoritative', // never contributes to headline metrics
];
const VALID_GROUND_TRUTH_CONFIDENCE = ['authoritative', 'exploratory_non_authoritative'];
const VALID_CAPTURE_PROFILES = ['ios-current-v1', 'android-current-v1', 'profile-neutral'];

function err(errors, msg) {
  errors.push(msg);
}

/**
 * Validate one fixture object. Returns { valid, errors }.
 * Does NOT throw - callers decide whether to reject.
 */
function validateFixture(fixture) {
  const errors = [];

  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return { valid: false, errors: ['fixture must be a non-null object'] };
  }

  if (typeof fixture.fixtureId !== 'string' || fixture.fixtureId.length === 0) {
    err(errors, 'fixtureId is required and must be a non-empty string');
  }

  if (!VALID_CORPUS_TIERS.includes(fixture.corpusTier)) {
    err(errors, `corpusTier must be one of ${VALID_CORPUS_TIERS.join(', ')}, got ${JSON.stringify(fixture.corpusTier)}`);
  }

  if (!VALID_CAPTURE_PROFILES.includes(fixture.captureProfile)) {
    err(errors, `captureProfile must be one of ${VALID_CAPTURE_PROFILES.join(', ')}, got ${JSON.stringify(fixture.captureProfile)}`);
  }

  // Ground-truth integrity (spec section 15) - CRITICAL.
  const gt = fixture.groundTruth;
  if (!gt || typeof gt !== 'object') {
    err(errors, 'groundTruth is required');
  } else {
    if (!VALID_GROUND_TRUTH_SOURCES.includes(gt.source)) {
      err(errors, `groundTruth.source must be one of ${VALID_GROUND_TRUTH_SOURCES.join(', ')}, got ${JSON.stringify(gt.source)}`);
    }
    if (!VALID_GROUND_TRUTH_CONFIDENCE.includes(gt.confidence)) {
      err(errors, `groundTruth.confidence must be one of ${VALID_GROUND_TRUTH_CONFIDENCE.join(', ')}, got ${JSON.stringify(gt.confidence)}`);
    }
    // A synthetic fixture's ground truth must say so - it cannot claim to be
    // retailer/manufacturer sourced (that would be a fabricated provenance
    // claim, which section 15 forbids).
    if (fixture.corpusTier === 'SYNTHETIC' && gt.source !== 'synthetic_generator_construction') {
      err(errors, "SYNTHETIC fixtures must set groundTruth.source = 'synthetic_generator_construction'");
    }
    if (fixture.corpusTier === 'APPROVED_REAL' && gt.source === 'synthetic_generator_construction') {
      err(errors, "APPROVED_REAL fixtures must not use the synthetic ground-truth source");
    }
    // A model-generated guess may only participate as non-authoritative.
    if (gt.source === 'exploratory_non_authoritative' && gt.confidence !== 'exploratory_non_authoritative') {
      err(errors, "groundTruth.source exploratory_non_authoritative requires confidence = exploratory_non_authoritative");
    }
  }

  if (!fixture.garmentIdentification || typeof fixture.garmentIdentification !== 'object') {
    err(errors, 'garmentIdentification is required (feeds the L1 offline ranker)');
  }

  if (!Array.isArray(fixture.candidateProducts)) {
    err(errors, 'candidateProducts must be an array (may be empty)');
  } else {
    const ids = fixture.candidateProducts.map((p) => p && p.id).filter(Boolean);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      err(errors, 'candidateProducts contains duplicate product ids within a single fixture');
    }
  }

  if (fixture.pairedFixtureId !== undefined && fixture.pairedFixtureId !== null && typeof fixture.pairedFixtureId !== 'string') {
    err(errors, 'pairedFixtureId, when present, must be a string or null');
  }

  // Privacy guard applies to fixtures too (spec section 25).
  const privacy = scanForPrivacyViolations(fixture);
  if (!privacy.safe) {
    for (const v of privacy.violations) {
      err(errors, `privacy_violation at ${v.path}: ${v.reason}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an entire corpus (array of fixtures). Checks cross-fixture
 * invariants that a single-fixture check cannot: duplicate fixture IDs,
 * corpus-tier homogeneity is NOT required (a corpus may mix tiers), but
 * every fixture must individually validate.
 */
function validateCorpus(fixtures) {
  const errors = [];
  if (!Array.isArray(fixtures)) {
    return { valid: false, errors: ['corpus must be an array of fixtures'] };
  }

  const seenIds = new Set();
  fixtures.forEach((fixture, idx) => {
    const { valid, errors: fixtureErrors } = validateFixture(fixture);
    if (!valid) {
      fixtureErrors.forEach((e) => err(errors, `fixture[${idx}] (${fixture && fixture.fixtureId}): ${e}`));
    }
    if (fixture && typeof fixture.fixtureId === 'string') {
      if (seenIds.has(fixture.fixtureId)) {
        err(errors, `duplicate fixtureId across corpus: ${fixture.fixtureId}`);
      }
      seenIds.add(fixture.fixtureId);
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  VALID_CORPUS_TIERS,
  VALID_GROUND_TRUTH_SOURCES,
  VALID_GROUND_TRUTH_CONFIDENCE,
  VALID_CAPTURE_PROFILES,
  validateFixture,
  validateCorpus,
  assertFixturePrivacySafe: (fixture) => assertPrivacySafe(fixture, 'fixture'),
};
