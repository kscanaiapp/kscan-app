/**
 * Product Match V1 — evidence and tier assignment (Deno).
 *
 * The tests that matter most here are the NEGATIVE ones: that no amount of soft
 * evidence promotes a match to EXACT, and that a search-result identifier can
 * never be laundered into an exact-identifier claim.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { assignTier, collectEvidence, EVIDENCE_WEIGHTS } from './evidence.ts';
import type { MatchEvidence, ProductMatchQuery } from './contracts.ts';
import { isUsefulTier, MATCH_TIERS, sourceCanCarryExactId, tierRank } from './contracts.ts';
import type { DedupedFamily, DedupedVariant } from './dedupe.ts';
import type { ProductListing, ProductSource } from './contracts.ts';

function listing(overrides: Partial<ProductListing> = {}): ProductListing {
  return {
    listingKey: 'url:https://example.com/x',
    variantKey: 'v',
    familyKey: 'f',
    source: 'serper',
    retailer: 'example.com',
    title: 'Nike Air Force 1 07 white leather sneakers',
    productUrl: 'https://example.com/x',
    imageUrl: null,
    price: null,
    currency: null,
    availability: null,
    ...overrides,
  };
}

function variant(overrides: Partial<DedupedVariant> = {}): DedupedVariant {
  return {
    variantKey: 'v',
    familyKey: 'f',
    colorway: 'white',
    exactProductId: null,
    sizeHint: null,
    listings: [listing()],
    sources: ['serper'] as ProductSource[],
    exactIdSources: [] as ProductSource[],
    ...overrides,
  };
}

function family(overrides: Partial<DedupedFamily> = {}): DedupedFamily {
  return {
    familyKey: 'f',
    brand: 'nike',
    model: 'air-force-1',
    canonicalCategory: 'footwear',
    displayName: 'Nike Air Force 1 07',
    ...overrides,
  };
}

const fullQuery: ProductMatchQuery = {
  brand: 'Nike',
  visibleBrandText: 'Nike',
  model: 'Air Force 1',
  canonicalCategory: 'footwear',
  color: 'white',
  material: 'leather',
};

// ── tier gates ──────────────────────────────────────────────────────────────

Deno.test('EXACT requires an exact identifier — soft evidence never reaches it', () => {
  const evidence = collectEvidence({ query: fullQuery, family: family(), variant: variant() });
  const assessment = assignTier(evidence);
  assert(
    assessment.evidence.every((item) => item.kind !== 'exact_product_id'),
    'fixture must not carry an identifier',
  );
  assertEquals(assessment.tier, 'LIKELY_EXACT');
});

Deno.test('a single retailer catalogue id does NOT reach EXACT', () => {
  // Farfetch asserting its own row number identifies a row in Farfetch's
  // database, not the photographed item. This is the case the offline benchmark
  // caught, and it is the reason corroboration exists as a separate gate.
  const assessment = assignTier(collectEvidence({
    query: fullQuery,
    family: family(),
    variant: variant({
      exactProductId: 'ff-19334521',
      sources: ['farfetch'],
      exactIdSources: ['farfetch'],
      listings: [listing({ source: 'farfetch' })],
    }),
  }));
  assert(
    assessment.evidence.some((item) => item.kind === 'exact_product_id'),
    'the identifier is still recorded as evidence',
  );
  assertEquals(assessment.tier, 'LIKELY_EXACT');
});

Deno.test('EXACT is reached only when two id-bearing sources corroborate the identifier', () => {
  const assessment = assignTier(collectEvidence({
    query: fullQuery,
    family: family(),
    variant: variant({
      exactProductId: 'CW2288-111',
      sources: ['farfetch', 'kickscrew'],
      exactIdSources: ['farfetch', 'kickscrew'],
      listings: [listing({ source: 'farfetch' }), listing({ source: 'kickscrew' })],
    }),
  }));
  assert(assessment.evidence.some((item) => item.kind === 'corroborated_product_id'));
  assertEquals(assessment.tier, 'EXACT');
});

Deno.test('a corroborated identifier without brand agreement stops at PRODUCT_FAMILY', () => {
  const assessment = assignTier(collectEvidence({
    query: { canonicalCategory: 'footwear' },
    family: family({ brand: null, model: null }),
    variant: variant({
      exactProductId: 'CW2288-111',
      sources: ['farfetch', 'kickscrew'],
      exactIdSources: ['farfetch', 'kickscrew'],
    }),
  }));
  assertEquals(assessment.tier, 'PRODUCT_FAMILY');
});

Deno.test('an identifier from search-only sources is refused at both identifier gates', () => {
  // Even if a normalizer bug set exactProductId, exactIdSources is re-checked
  // against source capability here.
  const assessment = assignTier(collectEvidence({
    query: fullQuery,
    family: family(),
    variant: variant({
      exactProductId: 'not-a-sku',
      sources: ['serper', 'brave'],
      exactIdSources: ['serper', 'brave'],
    }),
  }));
  assert(
    !assessment.evidence.some(
      (item) => item.kind === 'exact_product_id' || item.kind === 'corroborated_product_id',
    ),
    'serper/brave ids are not identifiers at all',
  );
  assertEquals(assessment.tier, 'LIKELY_EXACT');
});

Deno.test('sourceCanCarryExactId encodes the capability the gate relies on', () => {
  assert(sourceCanCarryExactId('farfetch'));
  assert(sourceCanCarryExactId('kickscrew'));
  assert(sourceCanCarryExactId('catalog'));
  assert(!sourceCanCarryExactId('serper'));
  assert(!sourceCanCarryExactId('brave'));
});

Deno.test('a colourway disagreement drops LIKELY_EXACT to PRODUCT_FAMILY', () => {
  const assessment = assignTier(collectEvidence({
    query: { ...fullQuery, color: 'black' },
    family: family(),
    variant: variant({ colorway: 'white' }),
  }));
  assertEquals(assessment.tier, 'PRODUCT_FAMILY');
});

Deno.test('an unknown colourway also stops at PRODUCT_FAMILY — unknown is not agreement', () => {
  const assessment = assignTier(collectEvidence({
    query: fullQuery,
    family: family(),
    variant: variant({ colorway: null }),
  }));
  assertEquals(assessment.tier, 'PRODUCT_FAMILY');
});

Deno.test('category plus one attribute is SIMILAR, not FAMILY', () => {
  const assessment = assignTier(collectEvidence({
    query: { canonicalCategory: 'footwear', color: 'white' },
    family: family({ brand: null, model: null }),
    variant: variant(),
  }));
  assertEquals(assessment.tier, 'SIMILAR');
});

Deno.test('no agreement at all is NO_CONFIDENT_MATCH, and it is not useful', () => {
  const assessment = assignTier(collectEvidence({
    query: { canonicalCategory: 'dress' },
    family: family({ brand: null, model: null, canonicalCategory: 'footwear' }),
    variant: variant({ colorway: null }),
  }));
  assertEquals(assessment.tier, 'NO_CONFIDENT_MATCH');
  assert(!isUsefulTier(assessment.tier));
});

Deno.test('every tier other than NO_CONFIDENT_MATCH counts as useful', () => {
  for (const tier of MATCH_TIERS) {
    assertEquals(isUsefulTier(tier), tier !== 'NO_CONFIDENT_MATCH');
  }
});

Deno.test('tierRank orders strongest first', () => {
  assert(tierRank('EXACT') < tierRank('LIKELY_EXACT'));
  assert(tierRank('LIKELY_EXACT') < tierRank('PRODUCT_FAMILY'));
  assert(tierRank('PRODUCT_FAMILY') < tierRank('SIMILAR'));
  assert(tierRank('SIMILAR') < tierRank('NO_CONFIDENT_MATCH'));
});

// ── confidence must not be a back door ──────────────────────────────────────

Deno.test('a maximal soft-evidence score still cannot buy EXACT', () => {
  const everythingSoft: MatchEvidence[] = (
    ['visible_brand_text', 'brand_guess', 'model_token', 'colorway', 'category',
      'material', 'silhouette', 'pattern', 'cross_source_agreement'] as const
  ).map((kind) => ({ kind, weight: EVIDENCE_WEIGHTS[kind] }));

  const assessment = assignTier(everythingSoft);
  assert(assessment.confidence >= 0.8, 'fixture should be a high-confidence match');
  assertEquals(assessment.tier, 'LIKELY_EXACT');
});

Deno.test('confidence is clamped to 1', () => {
  const many: MatchEvidence[] = Array.from({ length: 20 }, () => ({
    kind: 'category' as const,
    weight: 0.5,
  }));
  assertEquals(assignTier(many).confidence, 1);
});

// ── evidence collection ─────────────────────────────────────────────────────

Deno.test('brand evidence prefers visible text over an inferred guess', () => {
  const evidence = collectEvidence({ query: fullQuery, family: family(), variant: variant() });
  assert(evidence.some((item) => item.kind === 'visible_brand_text'));
  assert(!evidence.some((item) => item.kind === 'brand_guess'));
});

Deno.test('a brand that appears in neither the family nor the titles yields no brand evidence', () => {
  const evidence = collectEvidence({
    query: { brand: 'Adidas', canonicalCategory: 'footwear' },
    family: family(),
    variant: variant(),
  });
  assert(!evidence.some((item) => item.kind === 'visible_brand_text' || item.kind === 'brand_guess'));
});

Deno.test('token matching is whole-token, not substring', () => {
  const evidence = collectEvidence({
    query: { brand: 'Puma', canonicalCategory: 'footwear' },
    family: family({ brand: null, model: null }),
    variant: variant({ listings: [listing({ title: 'Pumice stone grey sneaker' })] }),
  });
  assert(
    !evidence.some((item) => item.kind === 'brand_guess'),
    '"puma" must not match inside "pumice"',
  );
});

Deno.test('cross-source agreement is recorded when more than one source produced the variant', () => {
  const evidence = collectEvidence({
    query: fullQuery,
    family: family(),
    variant: variant({ sources: ['farfetch', 'serper'] }),
  });
  assert(evidence.some((item) => item.kind === 'cross_source_agreement'));
});

Deno.test('every declared evidence kind has a weight', () => {
  const kinds = Object.keys(EVIDENCE_WEIGHTS);
  assertEquals(kinds.length, 12);
  for (const weight of Object.values(EVIDENCE_WEIGHTS)) {
    assert(weight > 0 && weight <= 1, 'weights must be a usable fraction');
  }
});
