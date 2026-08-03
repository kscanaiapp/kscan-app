/**
 * Product Match V1 — Checkpoint 2 user-value surfaces (Deno).
 *
 * Query planning, relevance, advisory closet similarity, the production
 * test-catalog gate, and the exact-claims policy.
 *
 * The similarity tests are the ones to read first: several of them exist purely
 * to fail if this feature ever drifts toward deduplication.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildStrategyQuery,
  categoryRouteOf,
  planQueries,
  shouldRunFallback,
  FALLBACK_LISTING_FLOOR,
  MAX_PRIMARY_QUERIES,
} from './queryPlanner.ts';
import { filterByRelevance, inferListingRoute, scoreListing, RELEVANCE_FLOOR } from './relevance.ts';
import {
  collectSimilarityReasons,
  detectPotentialSimilarItems,
  reasonsAreSufficient,
} from './closetSimilarity.ts';
import {
  applyCatalogExclusionGate,
  exclusionRulesFor,
  isExcludedCatalogRow,
  KNOWN_PRODUCTION_TEST_ROWS,
} from './catalogExclusion.ts';
import { applyExactClaimPolicy, assignTier, collectEvidence, EVIDENCE_WEIGHTS } from './evidence.ts';
import { isTestCatalogRow, normalizeRecommendedProduct } from './normalize.ts';
import { SIMILAR_ITEM_ACTIONS, type ProductListing, type ProductMatchQuery } from './contracts.ts';
import type { DedupedFamily, DedupedVariant } from './dedupe.ts';

// ── query planning ──────────────────────────────────────────────────────────

Deno.test('category routes map the vocabulary the scanner actually emits', () => {
  assertEquals(categoryRouteOf('footwear'), 'footwear');
  assertEquals(categoryRouteOf('Sneakers'), 'footwear');
  assertEquals(categoryRouteOf('outerwear'), 'outerwear');
  assertEquals(categoryRouteOf('blazer'), 'outerwear');
  assertEquals(categoryRouteOf('dress'), 'garment');
  assertEquals(categoryRouteOf('bag'), 'bag');
  assertEquals(categoryRouteOf('accessory'), 'accessory');
  assertEquals(categoryRouteOf('spaceship'), 'unknown');
});

Deno.test('footwear leads with model; outerwear leads with material and shape', () => {
  const sneaker = planQueries({
    visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
  });
  assertEquals(sneaker.route, 'footwear');
  assertEquals(sneaker.primary[0].strategy, 'visible_brand_model');

  const coat = planQueries({
    canonicalCategory: 'coat', color: 'grey', material: 'wool', silhouette: 'double breasted',
  });
  assertEquals(coat.route, 'outerwear');
  assertEquals(coat.primary[0].strategy, 'material_silhouette_category');
  assert(coat.primary[0].text.includes('wool'));
});

Deno.test('a strategy missing its required signals returns null, not a degraded query', () => {
  // A brand_model query with no brand is a different query wearing the wrong
  // label, and it would make the retrieval report lie about what was known.
  assertEquals(buildStrategyQuery('brand_model', { model: 'Air Force 1' }), null);
  assertEquals(buildStrategyQuery('visible_brand_model', { brand: 'Nike', model: 'AF1' }), null);
  assertEquals(buildStrategyQuery('category_color', { color: 'white' }), null);
});

Deno.test('visible brand text is never satisfied by an inferred brand', () => {
  const inferredOnly = buildStrategyQuery('visible_brand_model', {
    brand: 'Nike', model: 'Air Force 1',
  });
  assertEquals(inferredOnly, null, 'visible_brand_model requires text read off the garment');
});

Deno.test('a caller-supplied query leads but no longer suppresses attribute strategies', () => {
  // Checkpoint 1 returned early on a caller-supplied string, so the strongest
  // identity signals were never tried whenever the caller passed anything.
  const plan = planQueries({
    searchQueries: ['nike af1 white'],
    visibleBrandText: 'Nike',
    model: 'Air Force 1',
    canonicalCategory: 'footwear',
    color: 'white',
  });
  assertEquals(plan.primary[0].strategy, 'caller_supplied');
  assert(plan.primary.length > 1, 'attribute strategies must still be planned');
  assertEquals(plan.primary[1].strategy, 'visible_brand_model');
});

Deno.test('primary queries are capped and duplicates are never issued twice', () => {
  const plan = planQueries({
    searchQueries: ['Nike Air Force 1 white'],
    visibleBrandText: 'Nike',
    model: 'Air Force 1',
    canonicalCategory: 'footwear',
    color: 'white',
  });
  assert(plan.primary.length <= MAX_PRIMARY_QUERIES);
  const texts = plan.primary.map((planned) => planned.text.toLowerCase());
  assertEquals(new Set(texts).size, texts.length, 'the same string must not be issued twice');
});

Deno.test('the fallback is a distinct broader query, never a re-run of a primary', () => {
  const plan = planQueries({
    visibleBrandText: 'Nike',
    model: 'Air Force 1',
    canonicalCategory: 'footwear',
    color: 'white',
  });
  assert(plan.fallback !== null);
  assertEquals(plan.fallback.role, 'fallback');
  const primaryTexts = new Set(plan.primary.map((planned) => planned.text));
  assert(!primaryTexts.has(plan.fallback.text));
});

Deno.test('the fallback triggers on an evidence gap, never on elapsed time', () => {
  assertEquals(shouldRunFallback(0), true);
  assertEquals(shouldRunFallback(FALLBACK_LISTING_FLOOR - 1), true);
  assertEquals(shouldRunFallback(FALLBACK_LISTING_FLOOR), false);
  assertEquals(shouldRunFallback(50), false);
});

Deno.test('a query with nothing usable plans nothing rather than searching blindly', () => {
  assertEquals(planQueries({ styleTags: ['minimal'] }).primary.length, 0);
});

// ── relevance ───────────────────────────────────────────────────────────────

function listing(title: string, overrides: Partial<ProductListing> = {}): ProductListing {
  return {
    listingKey: `url:https://example.com/${title.length}`,
    variantKey: 'v', familyKey: 'f', source: 'serper', retailer: 'example.com',
    title, productUrl: 'https://example.com/x', imageUrl: null, price: null,
    currency: null, availability: null, ...overrides,
  };
}

const SNEAKER_QUERY: ProductMatchQuery = {
  visibleBrandText: 'Nike', brand: 'Nike', model: 'Air Force 1',
  canonicalCategory: 'footwear', color: 'white',
};

Deno.test('a listing in a conflicting category is rejected outright', () => {
  const verdict = scoreListing(listing('Nike leather tote bag white'), SNEAKER_QUERY);
  assertEquals(verdict.admitted, false);
  assertEquals(verdict.reason, 'category_conflict');
});

Deno.test('no score rescues a category conflict', () => {
  // Shares brand, colour and even a model token — and is still a bag.
  const verdict = scoreListing(listing('Nike Air Force white crossbody bag'), SNEAKER_QUERY);
  assertEquals(verdict.admitted, false);
  assertEquals(verdict.reason, 'category_conflict');
});

Deno.test('accessories TO the product are rejected even in the right category', () => {
  for (const title of [
    'Nike sneaker cleaner spray for white shoes',
    'Shoe trees for Nike Air Force 1',
    'Replacement laces white sneakers',
  ]) {
    const verdict = scoreListing(listing(title), SNEAKER_QUERY);
    assertEquals(verdict.admitted, false, `"${title}" must not be admitted`);
    assertEquals(verdict.reason, 'adjacent_product');
  }
});

Deno.test('the real product is admitted with a high score', () => {
  const verdict = scoreListing(listing("Nike Air Force 1 '07 white leather sneakers"), SNEAKER_QUERY);
  assertEquals(verdict.admitted, true);
  assert(verdict.score > 0.7, `expected a strong score, got ${verdict.score}`);
});

Deno.test('an unrelated listing in no recognizable category is rejected on score', () => {
  const verdict = scoreListing(listing('Assorted household items value pack'), SNEAKER_QUERY);
  assertEquals(verdict.admitted, false);
  assertEquals(verdict.reason, 'low_relevance');
});

Deno.test('a low-signal query admits rather than emptying the result set', () => {
  // The population with the fewest known attributes is the one most in need of
  // a "similar item" answer; rejecting it here would serve them nothing.
  const verdict = scoreListing(listing('Grey wool overcoat'), {});
  assertEquals(verdict.admitted, true);
  assertEquals(verdict.score, RELEVANCE_FLOOR);
});

Deno.test('an unrecognizable listing route never conflicts with anything', () => {
  assertEquals(inferListingRoute('Mystery fashion item'), 'unknown');
  assertEquals(scoreListing(listing('Nike Air Force 1 white'), SNEAKER_QUERY).admitted, true);
});

Deno.test('relevance filtering counts rejections by reason', () => {
  const rows = [
    'Nike Air Force 1 07 white sneakers',
    'Nike white leather tote bag',
    'Sneaker cleaner spray',
    'Assorted household items value pack',
  ].map((title, index) => {
    const row = normalizeRecommendedProduct(
      { id: String(index), title, productUrl: `https://example.com/${index}` },
      'serper',
      { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
    );
    if (!row) throw new Error('fixture failed to normalize');
    return row;
  });

  const result = filterByRelevance(rows, SNEAKER_QUERY);
  assertEquals(result.admitted.length, 1);
  assertEquals(result.categoryConflictRejections, 1);
  assertEquals(result.adjacentProductRejections, 1);
  assertEquals(result.lowRelevanceRejections, 1);
});

// ── advisory closet similarity ──────────────────────────────────────────────

const CLOSET_ITEM = {
  id: 'closet-1',
  source: 'closet' as const,
  label: 'White AF1',
  imageUri: 'file:///closet/af1.jpg',
  brand: 'Nike',
  model: 'Air Force 1',
  canonicalCategory: 'footwear',
  color: 'white',
};

Deno.test('THE CONTRACT: a similar item is advisory and carries no duplicate verdict', () => {
  const [result] = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [CLOSET_ITEM],
    newScanImageUri: 'file:///scan/new.jpg',
  });
  assert(result !== undefined);
  assertEquals(result.potentialSimilarItem, true);
  assertEquals(result.resolution, 'user_required');
  // The safety property, asserted on the serialized form so it survives
  // whatever a client does with the object.
  const serialized = JSON.stringify(result);
  assert(!serialized.includes('isDuplicate'), 'no duplicate verdict may exist in this contract');
  assert(!serialized.includes('duplicate'), 'the word duplicate must not appear at all');
  assert(!serialized.includes('merge'));
});

Deno.test('every one of the six user actions is always offered', () => {
  const [result] = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [CLOSET_ITEM],
  });
  assertEquals(result.availableActions, [...SIMILAR_ITEM_ACTIONS]);
  assertEquals(result.availableActions.length, 6);
  for (const action of [
    'reject_new_scan', 'add_to_closet', 'keep_in_recent_scans',
    'delete_existing_item', 'shop_identified_product', 'keep_both',
  ]) {
    assert(result.availableActions.includes(action as never), `${action} must be offered`);
  }
});

Deno.test('the comparison carries both images and both labels', () => {
  const [result] = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [CLOSET_ITEM],
    newScanImageUri: 'file:///scan/new.jpg',
    newScanLabel: 'Scanned sneaker',
  });
  assertEquals(result.comparison.newScanImageUri, 'file:///scan/new.jpg');
  assertEquals(result.comparison.existingItemImageUri, 'file:///closet/af1.jpg');
  assertEquals(result.comparison.newScanLabel, 'Scanned sneaker');
  assertEquals(result.comparison.existingItemLabel, 'White AF1');
});

Deno.test('the source of the existing item is always reported', () => {
  const [fromRecent] = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [{ ...CLOSET_ITEM, id: 'recent-1', source: 'recent_scan' }],
  });
  assertEquals(fromRecent.existingItemSource, 'recent_scan');
});

Deno.test('reasons are named, ordered strongest first, and never a bare score', () => {
  const reasons = collectSimilarityReasons(SNEAKER_QUERY, CLOSET_ITEM);
  assert(reasons.includes('same_brand'));
  assert(reasons.includes('same_model_tokens'));
  assert(reasons.includes('same_normalized_color'));
  assert(reasons.includes('same_canonical_category'));
  // Strongest first.
  assertEquals(reasons[0], 'same_brand');
});

Deno.test('category agreement alone is never enough to prompt', () => {
  // Otherwise every coat flags against every other coat, and the user learns to
  // dismiss the prompt that matters.
  assertEquals(reasonsAreSufficient(['same_canonical_category']), false);
  assertEquals(reasonsAreSufficient(['same_canonical_category', 'same_normalized_color']), true);
  assertEquals(reasonsAreSufficient([]), false);
});

Deno.test('a genuinely different item produces no comparison', () => {
  const results = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [{
      id: 'closet-2', source: 'closet', brand: 'Acne Studios',
      canonicalCategory: 'outerwear', color: 'grey',
    }],
  });
  assertEquals(results.length, 0);
});

Deno.test('an empty result means "nothing to offer", not "confirmed different"', () => {
  // Asserted as a shape property: there is no negative-verdict field to set.
  const results = detectPotentialSimilarItems({ query: SNEAKER_QUERY, existingItems: [] });
  assertEquals(results, []);
});

Deno.test('candidates are ordered by advisory confidence and capped', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    ...CLOSET_ITEM,
    id: `closet-${index}`,
    // Progressively weaker: drop the model on the later ones.
    model: index < 2 ? 'Air Force 1' : null,
  }));
  const results = detectPotentialSimilarItems({ query: SNEAKER_QUERY, existingItems: items });
  assert(results.length <= 3, 'a wall of comparisons is not a decision aid');
  assert(results[0].advisoryConfidence >= results[results.length - 1].advisoryConfidence);
});

Deno.test('a malformed candidate is skipped rather than throwing', () => {
  const results = detectPotentialSimilarItems({
    query: SNEAKER_QUERY,
    existingItems: [
      { id: '', source: 'closet' },
      { id: 'x', source: 'wardrobe' as never },
      CLOSET_ITEM,
    ],
  });
  assertEquals(results.length, 1);
  assertEquals(results[0].existingItemId, 'closet-1');
});

// ── production test-catalog exclusion gate ──────────────────────────────────

Deno.test('every real production test row is excluded, by a named rule', () => {
  for (const row of KNOWN_PRODUCTION_TEST_ROWS) {
    const rules = exclusionRulesFor(row);
    assert(rules.length > 0, `production row escaped the gate: ${JSON.stringify(row)}`);
  }
  const gated = applyCatalogExclusionGate([...KNOWN_PRODUCTION_TEST_ROWS]);
  assertEquals(gated.admitted.length, 0);
  assertEquals(gated.excludedCount, KNOWN_PRODUCTION_TEST_ROWS.length);
  assertEquals(gated.ruleCounts.source_marked_test, 14);
});

Deno.test('a real catalog row is admitted', () => {
  const real = {
    source: 'manual', brand: 'Acne Studios', retailer: 'Farfetch',
    external_product_id: 'ACNE-COAT-1', product_url: 'https://farfetch.com/item/1',
  };
  assertEquals(isExcludedCatalogRow(real), false);
  assertEquals(applyCatalogExclusionGate([real]).admitted.length, 1);
});

Deno.test('reserved and non-routable hosts are treated as non-production', () => {
  assert(isExcludedCatalogRow({ product_url: 'https://shop.example.com/x' }));
  assert(isExcludedCatalogRow({ product_url: 'http://localhost:3000/x' }));
  assert(isExcludedCatalogRow({ product_url: 'https://store.test/x' }));
});

Deno.test('an unparseable URL is not by itself evidence of test data', () => {
  assertEquals(isExcludedCatalogRow({ product_url: 'not a url', source: 'manual' }), false);
});

Deno.test('every violated rule is reported, not just the first', () => {
  const rules = exclusionRulesFor({
    source: 'TEST', brand: 'KSCAN_TEST', retailer: 'TEST_RETAILER_A',
    external_product_id: 'test-1',
  });
  assert(rules.length >= 4, `expected several rules, got ${rules.join(',')}`);
});

Deno.test('the normalizer delegates to the gate — one implementation only', () => {
  for (const row of KNOWN_PRODUCTION_TEST_ROWS) {
    assertEquals(isTestCatalogRow(row), isExcludedCatalogRow(row));
  }
});

// ── EXACT: decisive identity, and the claim policy ──────────────────────────

function variantFixture(overrides: Partial<DedupedVariant> = {}): DedupedVariant {
  return {
    variantKey: 'v', familyKey: 'f', colorway: 'white', exactProductId: null,
    sizeHint: null,
    listings: [listing('Nike Air Force 1 07 white sneakers', { source: 'farfetch' })],
    sources: ['farfetch'], exactIdSources: [],
    ...overrides,
  };
}

const FAMILY: DedupedFamily = {
  familyKey: 'f', brand: 'nike', model: 'air-force-1',
  canonicalCategory: 'footwear', displayName: 'Nike Air Force 1 07',
};

Deno.test('an authoritative identifier reaches EXACT on its own — no second provider', () => {
  // The durable rule. Corroboration is EVIDENCE OF authority, not its
  // definition, and must not calcify into the permanent meaning of EXACT.
  const evidence = collectEvidence({
    query: SNEAKER_QUERY,
    family: FAMILY,
    variant: variantFixture({ exactProductId: 'SKU', exactIdSources: ['farfetch'] }),
  });
  evidence.push({ kind: 'authoritative_product_id', weight: EVIDENCE_WEIGHTS.authoritative_product_id });
  assertEquals(assignTier(evidence).tier, 'EXACT');
});

Deno.test('corroboration across two id-bearing catalogues also reaches EXACT', () => {
  const assessment = assignTier(collectEvidence({
    query: SNEAKER_QUERY,
    family: FAMILY,
    variant: variantFixture({
      exactProductId: 'CW2288-111',
      sources: ['farfetch', 'kickscrew'],
      exactIdSources: ['farfetch', 'kickscrew'],
    }),
  }));
  assertEquals(assessment.tier, 'EXACT');
});

Deno.test('exact claims are downgraded to LIKELY_EXACT while the flag is off', () => {
  const assessment = assignTier(collectEvidence({
    query: SNEAKER_QUERY,
    family: FAMILY,
    variant: variantFixture({
      exactProductId: 'CW2288-111',
      sources: ['farfetch', 'kickscrew'],
      exactIdSources: ['farfetch', 'kickscrew'],
    }),
  }));
  assertEquals(assessment.tier, 'EXACT');

  const gated = applyExactClaimPolicy(assessment, false);
  assertEquals(gated.tier, 'LIKELY_EXACT');
  // The evidence is deliberately untouched, so the downgrade stays legible.
  assert(gated.evidence.some((item) => item.kind === 'corroborated_product_id'));
});

Deno.test('the claim policy leaves every other tier alone', () => {
  for (const tier of ['LIKELY_EXACT', 'PRODUCT_FAMILY', 'SIMILAR', 'NO_CONFIDENT_MATCH'] as const) {
    assertEquals(applyExactClaimPolicy({ tier, confidence: 0.5, evidence: [] }, false).tier, tier);
  }
});
