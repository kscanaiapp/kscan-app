'use strict';

/**
 * Compile corpus records into Fashion Match Quality Lab fixtures
 * (mission sections 28, 30, 31, 33).
 *
 *   "The existing evaluator remains authoritative. The real corpus must load
 *    through the same conceptual evaluation interface as existing fixtures.
 *    Do NOT create a second independent match-quality scoring system."
 *
 * So: this lane supplies INPUTS to FMQL's evaluator and never re-implements
 * scoring. A compiled fixture is a valid FMQL `APPROVED_REAL` fixture,
 * accepted by the inherited `schema/fixtureSchema.js` unchanged.
 *
 * Compiled fixtures are written into THIS lane's tree, not into
 * `fashion-match-quality/corpus/real/` — see design DM-02. That directory is
 * merged into FMQL's default synthetic report with no tier gate, and blending
 * real cases into it would both invalidate the committed synthetic baseline
 * and mix tiers silently, which invariant 42.14 forbids.
 */

const {
  validateFixture,
  VALID_GROUND_TRUTH_SOURCES,
} = require('../../fashion-match-quality/schema/fixtureSchema');
const { deriveGrade, evaluateIdentityEligibility } = require('./groundTruth');
const { ASSET_TIER_REAL } = require('./constants');
const { ONTOLOGY_VERSION } = require('./ontology');

/**
 * Corpus evidence type -> FMQL ground-truth source.
 *
 * FMQL's vocabulary is preserved rather than extended (mission section 33:
 * do not redesign the existing taxonomies). Every target is a traceable,
 * non-model source; `exploratory_non_authoritative` is deliberately absent
 * from this map, because a record that would need it never gets compiled.
 */
const EVIDENCE_TO_FMQL_SOURCE = Object.freeze({
  MANUFACTURER_TAG: 'manufacturer_specification',
  MANUFACTURER_PRODUCT_PAGE: 'manufacturer_specification',
  RETAILER_PDP: 'retailer_pdp',
  GTIN_UPC_EAN: 'known_sku_metadata',
  MANUFACTURER_STYLE_CODE: 'known_sku_metadata',
  PURCHASE_RECORD: 'known_sku_metadata',
  DIRECT_OWNER_KNOWLEDGE: 'owner_annotation',
  OTHER_VERIFIABLE_PRODUCT_EVIDENCE: 'owner_annotation',
});

function normalise(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

/**
 * Pick the FMQL source from the strongest evidence record present. "Strongest"
 * means the one whose provenance is hardest to dispute, in the order below.
 */
const EVIDENCE_STRENGTH_ORDER = [
  'GTIN_UPC_EAN',
  'MANUFACTURER_TAG',
  'MANUFACTURER_STYLE_CODE',
  'MANUFACTURER_PRODUCT_PAGE',
  'RETAILER_PDP',
  'PURCHASE_RECORD',
  'DIRECT_OWNER_KNOWLEDGE',
  'OTHER_VERIFIABLE_PRODUCT_EVIDENCE',
];

function selectFmqlSource(garment) {
  const present = (garment.groundTruth?.evidence || []).map((record) => record.evidenceType);
  for (const type of EVIDENCE_STRENGTH_ORDER) {
    if (present.includes(type)) return EVIDENCE_TO_FMQL_SOURCE[type];
  }
  // A VISUAL_ONLY garment has no usable evidence record at all. It is still a
  // human annotation, not a model guess, so owner_annotation is the honest
  // mapping - and it will carry no identitySku, so FMQL can never score it EXACT.
  return 'owner_annotation';
}

/**
 * The identity key FMQL scores against. Only supplied when the garment is
 * identity-eligible under mission section 6 - the durable identifier IS the
 * identity claim, and a garment that cannot establish exact identity must not
 * present one.
 */
function identitySkuFor(garment) {
  const eligibility = evaluateIdentityEligibility(garment);
  if (!eligibility.eligible) return undefined;
  const identity = garment.groundTruth.identity;
  const style = identity.style || {};
  const variant = identity.variant || {};
  // Colourway is part of the key: the right style in the wrong colour is a
  // different product to a shopper, and section 6 requires colorway-level
  // truth for an EXACT claim.
  const base = style.styleCode || variant.gtin;
  const colorway = variant.colorwayCode || variant.colorwayName;
  return `${base}::${colorway}`;
}

function titleNormalizedFor(garment) {
  const style = garment.groundTruth?.identity?.style || {};
  const parts = [style.brand, style.productName].filter(Boolean);
  return parts.length > 0 ? normalise(parts.join(' ')) : undefined;
}

/**
 * Build the `garmentIdentification` block - shaped exactly like production's
 * NormalizedIdentification input, as FMQL requires.
 *
 * CRITICAL: every field here comes from HUMAN annotation of the physical
 * garment, never from a scanner run. This block is what the evaluated pipeline
 * would be given, not what it produced.
 */
function buildGarmentIdentification(garment, caseRecord) {
  const attributes = garment.attributes || {};
  const style = garment.groundTruth?.identity?.style || {};
  const strata = caseRecord.difficultyStrata || [];

  return {
    visual_observation: garment.notes || `A ${attributes.colorFamily || ''} ${garment.category}`.trim(),
    item_type: garment.category,
    primary_color: attributes.colorFamily ?? null,
    material_estimate: attributes.material ?? null,
    silhouette: attributes.silhouette ?? null,
    distinctive_features: [attributes.pattern, attributes.construction].filter(Boolean),
    style_tags: [],
    search_queries: [[attributes.colorFamily, garment.category].filter(Boolean).join(' ')].filter(Boolean),
    // Whether a logo is visible is a recorded difficulty stratum, not a guess.
    visible_brand_text: strata.includes('VISIBLE_LOGO') ? style.brand ?? null : null,
    logo_detected: strata.includes('VISIBLE_LOGO'),
    // Deliberately null. A confidence score is something the MODEL produces;
    // a corpus fixture that carried one would be smuggling model output into
    // the evaluation input (mission section 5).
    confidence_score: null,
    non_fashion: false,
  };
}

/**
 * Compile one (garment, case) pair into an FMQL fixture.
 *
 * `replayRecord`, when supplied, provides `candidateProducts` captured from a
 * previously-recorded Scanner response (mission section 31). With no replay
 * record the fixture carries an empty candidate list, which FMQL scores as
 * UNKNOWN / insufficient evidence - the honest state when the Scanner has
 * never been run against this case.
 */
function compileCase(garment, caseRecord, { replayRecord = null } = {}) {
  if (caseRecord.assetTier !== ASSET_TIER_REAL) {
    return {
      ok: false,
      error:
        `case ${caseRecord.caseId} is tier ${caseRecord.assetTier}. Only ${ASSET_TIER_REAL} cases compile into ` +
        'evaluation fixtures - a procedurally generated asset may never enter the real corpus or a real metric ' +
        '(mission section 26).',
    };
  }

  const derived = deriveGrade(garment.groundTruth);
  if (derived.invalid) {
    return { ok: false, error: `garment ${garment.garmentId}: ${derived.reasons.join('; ')}` };
  }

  const attributes = garment.attributes || {};
  const style = garment.groundTruth?.identity?.style || {};
  const source = selectFmqlSource(garment);

  const groundTruth = {
    source,
    // Every compiled fixture is traceable non-model evidence, so it is
    // authoritative in FMQL's sense. A model-derived record never reaches here
    // - deriveGrade refuses it above.
    confidence: 'authoritative',
    category: garment.category,
    brandNormalized: normalise(style.brand),
    titleNormalized: titleNormalizedFor(garment),
    color_family: attributes.colorFamily,
    material: attributes.material,
    silhouette: attributes.silhouette,
    texture: attributes.texture ?? attributes.material,
    pattern: attributes.pattern,
    construction: attributes.construction,
    hardware_details: attributes.hardwareDetails,
    brand: style.brand,
    price_tier: attributes.priceTier,
    cut_proportion: attributes.cutProportion ?? attributes.silhouette,
    // Corpus-side provenance, carried through so an evaluation record can be
    // traced back to the garment and grade it came from without re-opening the
    // corpus. FMQL ignores unknown ground-truth keys.
    realCorpus: {
      garmentId: garment.garmentId,
      caseId: caseRecord.caseId,
      derivedGrade: derived.grade,
      identityEligible: evaluateIdentityEligibility(garment).eligible,
      catalogStateVerifiedOn: garment.groundTruth.catalogStateVerifiedOn,
    },
  };

  const identitySku = identitySkuFor(garment);
  if (identitySku) groundTruth.identitySku = identitySku;

  const fixture = {
    fixtureId: caseRecord.caseId,
    corpusTier: 'APPROVED_REAL',
    captureProfile: caseRecord.capture.captureProfile,
    pairedFixtureId: caseRecord.pairing?.pairedCaseId ?? null,
    groundTruth,
    garmentIdentification: buildGarmentIdentification(garment, caseRecord),
    candidateProducts: replayRecord?.observedResponse?.candidateProducts ?? [],
    realCorpusMeta: {
      garmentId: garment.garmentId,
      partition: caseRecord.partition,
      difficultyStrata: caseRecord.difficultyStrata || [],
      inputHardNegativeOf: caseRecord.inputHardNegativeOf ?? null,
      collectionSource: garment.collection?.source,
      collectorId: garment.collection?.collectorId,
      devicePlatform: caseRecord.capture?.device?.platform,
      candidateSource: replayRecord ? 'REPLAY' : 'NONE_SCANNER_NOT_RUN',
      // V2: record the ontology version and carry raw+canonical fashion
      // truth through to every compiled evaluation artifact (spec section
      // 5). FMQL ignores unknown ground-truth/meta keys, so this never
      // risks the inherited fixture schema.
      ontologyVersion: ONTOLOGY_VERSION,
      ontology: garment.ontology,
      // V2: garment-level spatial ground truth, when the case carries it -
      // Workstream 04 segmentation readiness (spec section 18).
      spatial:
        caseRecord.garments !== undefined
          ? {
              garmentCount: caseRecord.garmentCount,
              multiGarment: caseRecord.multiGarment,
              garments: caseRecord.garments,
            }
          : null,
      failureTaxonomy: caseRecord.failureTaxonomy || [],
    },
  };

  // The compiled fixture must satisfy the INHERITED schema unmodified. If this
  // ever fails, the corpus has drifted away from the evaluation authority.
  const schema = validateFixture(fixture);
  if (!schema.valid) {
    return { ok: false, error: `compiled fixture failed the FMQL schema: ${schema.errors.join('; ')}`, fixture };
  }

  return { ok: true, fixture };
}

/** Compile a set of cases. Returns { fixtures, errors }. */
function compileCorpus({ garmentsById, cases, replayById = new Map() }) {
  const fixtures = [];
  const errors = [];
  for (const caseRecord of cases) {
    const garment = garmentsById.get(caseRecord.garmentId);
    if (!garment) {
      errors.push({ caseId: caseRecord.caseId, message: `garment ${caseRecord.garmentId} not found` });
      continue;
    }
    const result = compileCase(garment, caseRecord, { replayRecord: replayById.get(caseRecord.caseId) ?? null });
    if (!result.ok) {
      errors.push({ caseId: caseRecord.caseId, message: result.error });
      continue;
    }
    fixtures.push(result.fixture);
  }
  return { fixtures, errors };
}

module.exports = {
  compileCase,
  compileCorpus,
  EVIDENCE_TO_FMQL_SOURCE,
  VALID_GROUND_TRUTH_SOURCES,
  identitySkuFor,
  selectFmqlSource,
};
