// Phase 2B.4 — shared cross-path certification fixtures.
//
// ONE fixture definition per case, consumed by BOTH the Scanner adapter and the
// Elise adapter. Separately authored Scanner and Elise fixtures would prove
// nothing: two mocks can agree because they were written to agree, not because
// the two paths handle one payload identically. Everything here is therefore a
// single canonical backend payload, deep-frozen, handed to each path as an
// independent structural clone.
//
// WHAT A FIXTURE IS: the `identificationV2` object a real `scan-identify`
// response carries. It is the LAST point at which both paths still hold the same
// thing, which is exactly where cross-path equivalence has to be measured.
//
// DEEP FREEZE IS THE MUTATION PROOF: if either adapter wrote into the result it
// was handed, the frozen source would either throw (strict mode) or silently
// refuse the write and `assertFixturesPristine` would catch the divergence. The
// clones exist so a path CAN mutate its own copy without that being mistaken for
// mutating the shared source.

'use strict';

const EVIDENCE_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const SECOND_EVIDENCE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

/** Recursively freezes an object graph in place and returns it. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** Structural clone with no shared references back to the frozen source. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A minimal but COMPLETE canonical result.
 *
 * Every field `validateFashionV2Response` requires is present, so a fixture that
 * fails validation fails because the case says it should, never because the base
 * shape was short a key.
 */
function baseResult(overrides = {}) {
  const item = overrides.item || {};
  const base = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-shared-fixture',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'outerwear',
      subtype: 'chore jacket',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: 'navy', secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
      ...item,
    },
    confidence: {
      category: 0.92,
      subtype: 0.81,
      brand: null,
      modelFamily: null,
      exactProduct: null,
    },
    exactProduct: null,
    evidence: [{ evidenceId: EVIDENCE_ID, observations: ['visible chest pockets'] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.86 },
  };
  const merged = { ...base, ...overrides, item: base.item };
  return merged;
}

function candidate(id, category, subtype, extras = {}) {
  return {
    candidateId: id,
    evidenceId: EVIDENCE_ID,
    category,
    subtype: subtype ?? null,
    ...extras,
  };
}

// ── Group 1: single fashion item ─────────────────────────────────────────────

const SINGLE_ITEM = [
  {
    id: 'single/clear-category',
    description: 'category only, no subtype',
    canonical: baseResult({
      resolutionLevel: 'category',
      item: { category: 'footwear', subtype: null },
      confidence: { category: 0.88, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    }),
  },
  {
    id: 'single/category-and-subtype',
    description: 'category plus subtype',
    canonical: baseResult(),
  },
  {
    id: 'single/brand-and-subtype',
    description: 'brand plus subtype at brand_and_subtype resolution',
    canonical: baseResult({
      resolutionLevel: 'brand_and_subtype',
      item: {
        category: 'footwear',
        subtype: 'low-top sneaker',
        brand: {
          value: 'Common Projects',
          confidence: 0.77,
          provenance: 'visible_text',
          evidence: [{ evidenceId: EVIDENCE_ID, type: 'wordmark', observation: 'heel stamp', confidence: 0.7 }],
        },
        colors: { primary: 'white', secondary: [] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
      confidence: { category: 0.95, subtype: 0.9, brand: 0.77, modelFamily: null, exactProduct: null },
    }),
  },
  {
    id: 'single/model-family',
    description: 'model_family resolution with no exact product',
    canonical: baseResult({
      resolutionLevel: 'model_family',
      item: {
        category: 'footwear',
        subtype: 'running shoe',
        brand: { value: 'Nike', confidence: 0.9, provenance: 'logo_shape', evidence: [] },
        colors: { primary: 'black', secondary: ['volt'] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
      confidence: { category: 0.96, subtype: 0.9, brand: 0.9, modelFamily: 0.72, exactProduct: null },
    }),
  },
  {
    id: 'single/exact-product',
    description: 'exact_product resolution carrying brand, model and a SKU',
    canonical: baseResult({
      resolutionLevel: 'exact_product',
      item: {
        category: 'footwear',
        subtype: 'running shoe',
        brand: { value: 'Nike', confidence: 0.97, provenance: 'catalog_corroboration', evidence: [] },
        colors: { primary: 'black', secondary: [] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
      confidence: { category: 0.98, subtype: 0.95, brand: 0.97, modelFamily: 0.93, exactProduct: 0.88 },
      // The SKU is deliberately present: the projection must DROP it, and a
      // fixture without one could not prove that.
      exactProduct: { brand: 'Nike', model: 'Pegasus 41', sku: 'FD2722-001', confidence: 0.88 },
    }),
  },
  {
    id: 'single/unknown-brand',
    description: 'unknown brand provenance with a null value',
    canonical: baseResult({
      item: {
        category: 'tops',
        subtype: 'crewneck sweatshirt',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'heather grey', secondary: [] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  },
  {
    id: 'single/nullable-subtype',
    description: 'subtype explicitly null while category resolves',
    canonical: baseResult({
      resolutionLevel: 'category',
      item: { category: 'bottoms', subtype: null },
      confidence: { category: 0.8, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    }),
  },
  {
    id: 'single/multiple-colors',
    description: 'primary plus ordered secondary colors',
    canonical: baseResult({
      item: {
        category: 'outerwear',
        subtype: 'windbreaker',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'teal', secondary: ['coral', 'cream', 'black'] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  },
  {
    id: 'single/material',
    description: 'multiple observed materials',
    canonical: baseResult({
      item: {
        category: 'outerwear',
        subtype: 'chore jacket',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'navy', secondary: [] },
        material: ['cotton canvas', 'corduroy'],
        silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  },
  {
    id: 'single/pattern',
    description: 'pattern list populated',
    canonical: baseResult({
      item: {
        category: 'tops',
        subtype: 'flannel shirt',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'red', secondary: ['black'] },
        material: ['brushed cotton'],
        silhouette: [],
        pattern: ['buffalo check'],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  },
  {
    id: 'single/silhouette',
    description: 'silhouette list populated',
    canonical: baseResult({
      item: {
        category: 'bottoms',
        subtype: 'trouser',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'olive', secondary: [] },
        material: ['twill'],
        silhouette: ['wide leg', 'high rise'],
        pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
    }),
  },
  {
    id: 'single/fit-and-style-tags',
    description: 'fit plus the descriptive attribute set the projection calls style tags',
    canonical: baseResult({
      item: {
        category: 'outerwear',
        subtype: 'chore jacket',
        brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
        colors: { primary: 'navy', secondary: [] },
        material: ['cotton canvas'],
        silhouette: ['boxy'],
        pattern: [],
        attributes: {
          fit: 'relaxed',
          length: 'hip',
          sleeve: 'long',
          neckline: null,
          collar: 'point',
          closure: 'button',
          pockets: ['patch', 'chest'],
          visible: ['contrast stitching'],
          distinctive: ['workwear', 'utility'],
        },
      },
    }),
  },
];

// ── Group 2: uncertain and partial identity ──────────────────────────────────

const UNCERTAIN = [
  {
    id: 'uncertain/partial-category',
    description: 'partial status resolved only to category',
    canonical: baseResult({
      status: 'partial',
      resolutionLevel: 'category',
      item: { category: 'outerwear', subtype: null },
      confidence: { category: 0.55, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.51 },
    }),
  },
  {
    id: 'uncertain/partial-subtype',
    description: 'partial status with a subtype but low confidence',
    canonical: baseResult({
      status: 'partial',
      resolutionLevel: 'subtype',
      confidence: { category: 0.6, subtype: 0.42, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.47 },
    }),
  },
  {
    id: 'uncertain/conflicting-brand-evidence',
    description: 'two brand readings in conflict, with evidence ids attached',
    canonical: baseResult({
      status: 'partial',
      resolutionLevel: 'subtype',
      item: {
        category: 'footwear',
        subtype: 'sneaker',
        brand: {
          value: 'Adidas',
          confidence: 0.44,
          provenance: 'logo_shape',
          evidence: [
            { evidenceId: EVIDENCE_ID, type: 'logo', observation: 'three stripes', confidence: 0.44 },
            { evidenceId: EVIDENCE_ID, type: 'wordmark', observation: 'tongue label unreadable', confidence: 0.2 },
          ],
        },
        colors: { primary: 'white', secondary: [] },
        material: [], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
      conflicts: [
        {
          field: 'brand',
          description: 'Logo shape suggests Adidas; tongue label is not legible.',
          evidenceIds: [EVIDENCE_ID],
        },
      ],
    }),
  },
  {
    id: 'uncertain/low-confidence',
    description: 'completed but every confidence low',
    canonical: baseResult({
      confidence: { category: 0.31, subtype: 0.22, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.26 },
    }),
  },
  {
    id: 'uncertain/unknown-exact-product',
    description: 'unknown resolution level with an unknownReason',
    canonical: baseResult({
      status: 'partial',
      resolutionLevel: 'unknown',
      unknownReason: 'Garment is heavily occluded by the bag strap.',
      confidence: { category: 0.4, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.33 },
    }),
  },
  {
    id: 'uncertain/completed-non-exact',
    description: 'completed at brand_and_subtype with exactProduct explicitly null',
    canonical: baseResult({
      resolutionLevel: 'brand_and_subtype',
      item: {
        category: 'outerwear',
        subtype: 'puffer jacket',
        brand: { value: 'Patagonia', confidence: 0.85, provenance: 'visible_text', evidence: [] },
        colors: { primary: 'black', secondary: [] },
        material: ['recycled nylon'], silhouette: [], pattern: [],
        attributes: { pockets: [], visible: [], distinctive: [] },
      },
      exactProduct: null,
      confidence: { category: 0.97, subtype: 0.92, brand: 0.85, modelFamily: null, exactProduct: null },
    }),
  },
];

// ── Group 3: negative and failure states ─────────────────────────────────────

const NEGATIVE = [
  {
    id: 'negative/insufficient-visual-evidence',
    description: 'backend saw the image and could not resolve a garment',
    canonical: baseResult({
      status: 'insufficient_visual_evidence',
      resolutionLevel: 'unknown',
      item: { category: null, subtype: null },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      unknownReason: 'Image is too blurred to resolve a garment.',
      compatibility: { legacyProjectionAvailable: false, globalConfidence: null },
    }),
  },
  {
    id: 'negative/non-fashion',
    description: 'no garment present',
    canonical: baseResult({
      status: 'non_fashion',
      resolutionLevel: 'unknown',
      item: { category: null, subtype: null },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      unknownReason: 'No clothing detected.',
      compatibility: { legacyProjectionAvailable: false, globalConfidence: null },
    }),
  },
  {
    id: 'negative/technical-failure',
    description: 'provider-side technical failure carried in a valid envelope',
    canonical: baseResult({
      status: 'technical_failure',
      resolutionLevel: 'unknown',
      item: { category: null, subtype: null },
      confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
      compatibility: { legacyProjectionAvailable: false, globalConfidence: null },
    }),
  },
  {
    id: 'negative/zero-candidates',
    description: 'completed detection reporting an empty candidate list',
    canonical: baseResult({ candidates: [] }),
  },
  {
    id: 'negative/single-candidate',
    description: 'detection reporting exactly one candidate',
    canonical: baseResult({
      status: 'multiple_items_need_selection',
      candidates: [candidate('cand-1', 'outerwear', 'chore jacket')],
    }),
  },
  {
    id: 'negative/multiple-candidates',
    description: 'detection reporting an ordered multi-candidate set',
    canonical: baseResult({
      status: 'multiple_items_need_selection',
      candidates: [
        candidate('cand-1', 'outerwear', 'chore jacket', { bounds: { x: 1, y: 2, width: 3, height: 4 } }),
        candidate('cand-2', 'bottoms', 'trouser', { bounds: { x: 5, y: 6, width: 7, height: 8 } }),
        candidate('cand-3', 'footwear', 'boot'),
      ],
    }),
  },
];

/**
 * Payloads that must FAIL validation on both paths.
 *
 * Kept apart from the canonical fixtures because there is no identity to
 * compare — the assertion is that both paths refuse them identically.
 */
const MALFORMED = [
  { id: 'malformed/not-an-object', payload: 'nope', expectedCategory: 'not_an_object' },
  { id: 'malformed/null', payload: null, expectedCategory: 'not_an_object' },
  {
    id: 'malformed/wrong-contract-version',
    payload: { ...clone(baseResult()), contractVersion: 'fashion-identification-v1' },
    expectedCategory: 'contract_version',
  },
  {
    id: 'malformed/unknown-status',
    payload: { ...clone(baseResult()), status: 'sort_of_done' },
    expectedCategory: 'status',
  },
  {
    id: 'malformed/unknown-resolution-level',
    payload: { ...clone(baseResult()), resolutionLevel: 'vibes' },
    expectedCategory: 'resolution_level',
  },
  {
    id: 'malformed/missing-brand-evidence-array',
    payload: (() => {
      const p = clone(baseResult());
      delete p.item.brand.evidence;
      return p;
    })(),
    expectedCategory: 'brand_evidence',
  },
  {
    id: 'malformed/missing-confidence-key',
    payload: (() => {
      const p = clone(baseResult());
      delete p.confidence.modelFamily;
      return p;
    })(),
    expectedCategory: 'confidence_missing_modelFamily',
  },
  {
    id: 'malformed/confidence-wrong-type',
    payload: (() => {
      const p = clone(baseResult());
      p.confidence.brand = 'high';
      return p;
    })(),
    expectedCategory: 'confidence_type_brand',
  },
  {
    id: 'malformed/conflicts-not-an-array',
    payload: { ...clone(baseResult()), conflicts: { field: 'brand' } },
    expectedCategory: 'conflicts',
  },
  {
    id: 'malformed/missing-compatibility',
    payload: (() => {
      const p = clone(baseResult());
      delete p.compatibility;
      return p;
    })(),
    expectedCategory: 'compatibility',
  },
];

const CANONICAL_FIXTURES = deepFreeze([...SINGLE_ITEM, ...UNCERTAIN, ...NEGATIVE]);
const MALFORMED_FIXTURES = deepFreeze(MALFORMED);

/**
 * A pristine JSON snapshot taken at module load.
 *
 * `assertFixturesPristine` compares the live frozen fixtures against this so a
 * silent mutation (a non-strict write that the freeze swallowed) is still caught.
 */
const PRISTINE_SNAPSHOT = JSON.stringify(CANONICAL_FIXTURES);

function assertFixturesPristine(assert, label) {
  assert.equal(
    JSON.stringify(CANONICAL_FIXTURES),
    PRISTINE_SNAPSHOT,
    `${label}: a path mutated the shared fixture source`,
  );
}

/** One prepared derivative, shared by both paths. Equivalent evidence, by construction. */
const SHARED_IMAGE_BASE64 = 'Zm9vYmFyLWpwZWctYnl0ZXM=';

function scannerEvidence(source = 'camera') {
  return {
    evidenceId: EVIDENCE_ID,
    imageBase64: SHARED_IMAGE_BASE64,
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1365,
    source,
  };
}

function eliseEvidence(source = 'camera') {
  return {
    evidenceId: EVIDENCE_ID,
    imageBase64: SHARED_IMAGE_BASE64,
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1365,
    source,
  };
}

module.exports = {
  EVIDENCE_ID,
  SECOND_EVIDENCE_ID,
  SHARED_IMAGE_BASE64,
  CANONICAL_FIXTURES,
  MALFORMED_FIXTURES,
  assertFixturesPristine,
  baseResult,
  candidate,
  clone,
  deepFreeze,
  eliseEvidence,
  scannerEvidence,
};
