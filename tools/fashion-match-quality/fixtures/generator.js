'use strict';

/**
 * Deterministic synthetic fixture generator (spec section 16B).
 *
 * NOT a photorealistic garment-rendering engine - this generates structured
 * DESCRIPTORS (the same field shapes the real production pipeline consumes:
 * see supabase/functions/_shared/scanHelpers.ts NormalizedIdentification and
 * supabase/functions/_shared/catalogRetrieval.ts CatalogProductCandidate),
 * not images or pixels. Its only job is to exercise schemas, scoring,
 * capture profiles, ranking, statistics, duplicate detection, report
 * generation, comparison, and holdout mechanics deterministically.
 *
 * Ground truth for every generated fixture comes from the generator's own
 * construction parameters (spec section 15's synthetic carve-out) - the
 * "exact" candidate is built FROM the same parameters as
 * fixture.groundTruth, so there is no circularity and no guessing.
 */

const { SeededRandom } = require('../lib/seededRandom');

const GENERATOR_VERSION = 'fmql-synthetic-generator-v1';
const GENERATOR_SEED = 'fashion-match-quality-lab-v1::synthetic-corpus';

// Garment archetypes span the canonical categories the real normalizeCategory()
// function resolves to (supabase/functions/_shared/scanHelpers.ts).
const ARCHETYPES = [
  { category: 'dress', silhouette: 'a-line', material: 'cotton', colorFamily: 'navy', brand: 'Reformation' },
  { category: 'top', silhouette: 'fitted', material: 'silk', colorFamily: 'white', brand: 'Everlane' },
  { category: 'pants', silhouette: 'straight', material: 'denim', colorFamily: 'black', brand: 'Levi\'s' },
  { category: 'footwear', silhouette: 'tailored/structured', material: 'leather', colorFamily: 'brown/tan', brand: 'Clarks' },
  { category: 'bag', silhouette: 'structured', material: 'leather', colorFamily: 'black', brand: 'Coach' },
  { category: 'outerwear', silhouette: 'oversized/relaxed', material: 'wool/wool blend', colorFamily: 'gray', brand: 'Aritzia' },
  { category: 'accessory', silhouette: 'straight', material: 'silk', colorFamily: 'multicolor', brand: 'Vince' },
  { category: 'blazer', silhouette: 'tailored/structured', material: 'wool/wool blend', colorFamily: 'navy', brand: 'Theory' },
];

const RETAILERS = ['nordstrom', 'revolve', 'shopbop', 'zappos', 'net-a-porter'];
const PRICE_TIERS = ['budget', 'mid', 'premium', 'luxury'];

function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function normalizedTitle(brand, category, silhouette, colorFamily) {
  return `${brand} ${colorFamily} ${silhouette} ${category}`.toLowerCase();
}

/**
 * Build one fixture: an "exact" candidate constructed from the archetype
 * (this literally IS the ground truth by construction), a near-miss
 * candidate (one attribute deliberately wrong - proves substitute/identity
 * independence), a cross-category distractor (proves wrong-garment
 * penalty), a cross-retailer near-duplicate of the exact candidate (proves
 * duplicate detection), and one candidate with no purchase URL (proves the
 * UNUSABLE substitute gate).
 */
function buildFixture(rng, archetype, index, captureProfile, pairedFixtureId) {
  const fixtureId = `synthetic-${slug(archetype.category)}-${index.toString().padStart(2, '0')}${captureProfile === 'android-current-v1' ? '-android' : ''}`;
  const priceTier = rng.pick(PRICE_TIERS);
  const retailer = rng.pick(RETAILERS);
  const price = Math.round((rng.int(20, 800) + rng.float()) * 100) / 100;

  const exactId = `${fixtureId}::exact`;
  const exactCandidate = {
    id: exactId,
    identitySku: `SKU-${slug(archetype.brand)}-${slug(archetype.category)}-${index}`,
    brand: archetype.brand,
    brandNormalized: slug(archetype.brand),
    name: `${archetype.brand} ${archetype.colorFamily} ${archetype.category}`,
    title: `${archetype.brand} ${archetype.colorFamily} ${archetype.category}`,
    titleNormalized: normalizedTitle(archetype.brand, archetype.category, archetype.silhouette, archetype.colorFamily),
    category: archetype.category,
    canonical_category: archetype.category,
    color: archetype.colorFamily,
    color_normalized: archetype.colorFamily,
    silhouette: archetype.silhouette,
    material: archetype.material,
    materialEstimate: archetype.material,
    material_tags: [archetype.material],
    styleTags: ['classic'],
    tags: ['classic'],
    price_tier: priceTier,
    price,
    currency: 'USD',
    retailer,
    purchaseUrl: `https://${retailer}.example/${slug(archetype.brand)}/${fixtureId}-exact`,
    imageUrl: `https://cdn.example/${fixtureId}-exact.jpg`,
    availability: 'in_stock',
    retailer_quality: 'verified_retailer',
    construction: 'standard',
    hardware_details: 'none',
    texture: archetype.material,
    pattern: 'solid',
    cut_proportion: archetype.silhouette,
  };

  // Near-miss: same category/brand, wrong silhouette AND wrong color -
  // must not be conflated with the exact match, and should land as an
  // ACCEPTABLE/WEAK substitute rather than STRONG. Its name/title/
  // titleNormalized are recomputed from its OWN (changed) attributes -
  // reusing the exact candidate's stale title text would make it
  // string-match the exact candidate and misclassify as a duplicate
  // instead of a distinct variant.
  const nearMissId = `${fixtureId}::near-miss`;
  const nearMissSilhouette = 'fitted';
  const nearMissColor = 'gray';
  const nearMissCandidate = {
    ...exactCandidate,
    id: nearMissId,
    identitySku: `SKU-${slug(archetype.brand)}-${slug(archetype.category)}-${index}-alt`,
    silhouette: nearMissSilhouette,
    color: nearMissColor,
    color_normalized: nearMissColor,
    name: `${archetype.brand} ${nearMissColor} ${archetype.category}`,
    title: `${archetype.brand} ${nearMissColor} ${archetype.category}`,
    titleNormalized: normalizedTitle(archetype.brand, archetype.category, nearMissSilhouette, nearMissColor),
    cut_proportion: nearMissSilhouette,
    purchaseUrl: `https://${retailer}.example/${slug(archetype.brand)}/${fixtureId}-near`,
    imageUrl: `https://cdn.example/${fixtureId}-near.jpg`,
  };

  // Cross-category distractor - proves the wrong-garment penalty (spec
  // section 29 EVALUATION control: "wrong garment penalized").
  const otherArchetype = ARCHETYPES[(ARCHETYPES.indexOf(archetype) + 3) % ARCHETYPES.length];
  const distractorId = `${fixtureId}::distractor`;
  const distractorCandidate = {
    id: distractorId,
    brand: otherArchetype.brand,
    brandNormalized: slug(otherArchetype.brand),
    name: `${otherArchetype.brand} ${otherArchetype.colorFamily} ${otherArchetype.category}`,
    title: `${otherArchetype.brand} ${otherArchetype.colorFamily} ${otherArchetype.category}`,
    titleNormalized: normalizedTitle(otherArchetype.brand, otherArchetype.category, otherArchetype.silhouette, otherArchetype.colorFamily),
    category: otherArchetype.category,
    canonical_category: otherArchetype.category,
    color: otherArchetype.colorFamily,
    color_normalized: otherArchetype.colorFamily,
    silhouette: otherArchetype.silhouette,
    material: otherArchetype.material,
    materialEstimate: otherArchetype.material,
    purchaseUrl: `https://${retailer}.example/${slug(otherArchetype.brand)}/${fixtureId}-distractor`,
    imageUrl: `https://cdn.example/${fixtureId}-distractor.jpg`,
    availability: 'in_stock',
  };

  // Cross-retailer near-duplicate of the exact candidate: same normalized
  // brand+title+category, different retailer/URL/id - proves LIKELY_DUPLICATE
  // classification (spec section 20) without pretending it is a
  // CONFIRMED_DUPLICATE (no shared SKU).
  const dupRetailer = RETAILERS.find((r) => r !== retailer) || RETAILERS[0];
  const duplicateId = `${fixtureId}::cross-retailer-dup`;
  const duplicateCandidate = {
    ...exactCandidate,
    id: duplicateId,
    identitySku: null, // a different retailer rarely exposes the manufacturer SKU
    retailer: dupRetailer,
    purchaseUrl: `https://${dupRetailer}.example/${slug(archetype.brand)}/${fixtureId}-dup`,
    imageUrl: `https://cdn.example/${fixtureId}-dup.jpg`,
  };

  // Unusable candidate: matches well but has no purchase path. Reuses the
  // exact candidate's own product photo (a plausible real listing - the
  // same retailer marking its own item out of stock) - this gives the
  // duplicate classifier a genuine CONFIRMED_DUPLICATE case (identical
  // image, supporting evidence on top of an already-matching brand/title/
  // category) without needing a shared SKU.
  const unusableId = `${fixtureId}::no-purchase-path`;
  const unusableCandidate = {
    ...exactCandidate,
    id: unusableId,
    identitySku: null,
    purchaseUrl: null,
    imageUrl: exactCandidate.imageUrl,
    availability: 'out_of_stock',
  };

  const garmentIdentification = {
    visual_observation: `A ${archetype.colorFamily} ${archetype.silhouette} ${archetype.category}.`,
    item_type: archetype.category,
    primary_color: archetype.colorFamily,
    material_estimate: archetype.material,
    silhouette: archetype.silhouette,
    distinctive_features: ['classic'],
    style_tags: ['classic'],
    search_queries: [`${archetype.colorFamily} ${archetype.category}`],
    visible_brand_text: null,
    logo_detected: false,
    confidence_score: 0.72,
    non_fashion: false,
  };

  return {
    fixtureId,
    corpusTier: 'SYNTHETIC',
    captureProfile,
    pairedFixtureId: pairedFixtureId || null,
    generatorVersion: GENERATOR_VERSION,
    archetype: archetype.category,
    groundTruth: {
      source: 'synthetic_generator_construction',
      confidence: 'authoritative',
      identitySku: exactCandidate.identitySku,
      brandNormalized: exactCandidate.brandNormalized,
      category: archetype.category,
      titleNormalized: exactCandidate.titleNormalized,
      color_family: archetype.colorFamily,
      material: archetype.material,
      silhouette: archetype.silhouette,
      texture: archetype.material,
      pattern: 'solid',
      construction: 'standard',
      hardware_details: 'none',
      brand: archetype.brand,
      price_tier: priceTier,
      availability: 'in_stock',
      retailer_quality: 'verified_retailer',
      cut_proportion: archetype.silhouette,
    },
    garmentIdentification,
    candidateProducts: [
      exactCandidate,
      nearMissCandidate,
      distractorCandidate,
      duplicateCandidate,
      unusableCandidate,
    ],
  };
}

/**
 * Generate the full deterministic synthetic corpus. Always produces the
 * same fixtures for the same GENERATOR_SEED - this is asserted by a
 * determinism test (fixtures/generator.test.js).
 */
function generateSyntheticCorpus() {
  const rng = new SeededRandom(GENERATOR_SEED);
  const fixtures = [];

  ARCHETYPES.forEach((archetype, index) => {
    fixtures.push(buildFixture(rng, archetype, index, 'ios-current-v1', null));
  });

  // Platform-parity pairs (spec section 12): the SAME garment, evaluated
  // under both capture profiles, linked via pairedFixtureId. We reuse the
  // first two archetypes for this - real paired iPhone/Android photographs
  // are out of scope for this autonomous build (spec section 12 forbids
  // fabricating that evidence); this only proves the pairing machinery.
  const pairArchetypes = ARCHETYPES.slice(0, 2);
  pairArchetypes.forEach((archetype, index) => {
    const iosId = `synthetic-${slug(archetype.category)}-${index.toString().padStart(2, '0')}`;
    const androidFixture = buildFixture(rng, archetype, index, 'android-current-v1', iosId);
    fixtures.push(androidFixture);
  });

  // Retroactively link the iOS fixtures to their Android pair.
  pairArchetypes.forEach((archetype, index) => {
    const iosId = `synthetic-${slug(archetype.category)}-${index.toString().padStart(2, '0')}`;
    const androidId = `${iosId}-android`;
    const iosFixture = fixtures.find((f) => f.fixtureId === iosId);
    if (iosFixture) iosFixture.pairedFixtureId = androidId;
  });

  return fixtures;
}

module.exports = { generateSyntheticCorpus, GENERATOR_VERSION, GENERATOR_SEED, ARCHETYPES };
