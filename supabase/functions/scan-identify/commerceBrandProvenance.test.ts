import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { scoreCommercialIdentity, scoreProductAgreement } from './commerceRelevanceAgreement.ts';
import { buildWeightedCommerceQueries, filterAndDedupeProducts, hasValidPurchaseUrl } from './qualityTuneCommerce.ts';
import { buildCategoryCommerceQueries } from './commerceRelevanceQueries.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

const sneaker = { item_type: 'footwear', subtype: 'sneaker', primary_color: 'burgundy' };
function identity(overrides: Partial<CommerceIdentityEvidence> = {}): CommerceIdentityEvidence {
  return {
    brand: 'New Balance', brandConfidence: 'high', brandGrade: 'verified',
    visibleBrandText: 'New Balance', logoDetected: true,
    exactItemHypothesis: null, exactMatchConfidence: null, exactMatchGrade: 'invalid',
    distinctiveFeatures: [], ...overrides,
  };
}
function product(title: string, brand?: string, productUrl = 'https://shop.test/p/shoe'): RecommendedProduct {
  return { id: title, title, ...(brand ? { brand } : {}), productUrl,
    imageUrl: 'https://cdn.shop.test/shoe.jpg', price: '$100', source: 'Retailer', type: 'retail' };
}

Deno.test('brand provenance: a conflicting guess never overrides the New Balance wordmark in queries', () => {
  const identification = { ...sneaker, logo_detected: true, visible_brand_text: 'New Balance', brand_guess: 'Nike' };
  for (const options of [{}, { detailLevel: 'specific' as const, brandAllowed: true }]) {
    const q = buildWeightedCommerceQueries({ identification, ...options });
    assert(q.primary.includes('New Balance'), q.primary);
    assert(!q.primary.includes('Nike'), q.primary);
  }
});

Deno.test('brand provenance: model-generated queries cannot reintroduce a rejected brand hypothesis', () => {
  for (const visible_brand_text of ['New Balance', null]) {
    const identification = { ...sneaker, logo_detected: true, visible_brand_text, brand_guess: 'Nike', search_queries: ['Nike burgundy sneaker'] };
    const q = buildWeightedCommerceQueries({ identification });
    assert(!q.primary.includes('Nike'), q.primary);
    if (visible_brand_text) assert(q.primary.includes('New Balance'), q.primary);
  }
});

Deno.test('brand provenance: an unnamed logo does not verify an arbitrary guess in retrieval or scoring', () => {
  const identification = { ...sneaker, logo_detected: true, brand_guess: 'New Balance' };
  const legacy = buildWeightedCommerceQueries({ identification });
  const category = buildCategoryCommerceQueries({ identification, categoryRoute: 'footwear' });
  assert(!legacy.primary.includes('New Balance'), legacy.primary);
  assert(!category.primary.includes('New Balance'), category.primary);
  const p = product('New Balance burgundy sneaker');
  assertEquals(scoreProductAgreement(p, identification).score, scoreProductAgreement(p, sneaker).score);
});

Deno.test('brand provenance: a classified high-confidence distinctive logo supports brand retrieval', () => {
  const identification = { ...sneaker, logo_detected: true, logo_brand: 'New Balance', logo_confidence: 'high', brand_guess: 'Nike' };
  const legacy = buildWeightedCommerceQueries({ identification });
  const category = buildCategoryCommerceQueries({ identification, categoryRoute: 'footwear' });
  assert(legacy.primary.includes('New Balance'), legacy.primary);
  assert(category.primary.includes('New Balance'), category.primary);
  assert(!legacy.primary.includes('Nike'));
});

Deno.test('brand scoring: provider brand contradiction wins over a reference to the scanned brand in a title', () => {
  const p = product('Nike burgundy sneaker alternative to New Balance 574', 'Nike');
  const result = scoreCommercialIdentity(p, identity({ exactItemHypothesis: 'New Balance 574', exactMatchGrade: 'verified' }));
  assertEquals(result.brandMatched, false);
  assertEquals(result.brandMismatched, true);
  assertEquals(result.exactMatchCoverage, 0);
  assert(result.delta < 0);
});

Deno.test('brand scoring: short brands and model identifiers match whole tokens, never substrings', () => {
  assertEquals(scoreCommercialIdentity(product('Converse burgundy sneaker', 'Converse'), identity({ brand: 'On' })).brandMatched, false);
  assertEquals(scoreCommercialIdentity(product('Fashion burgundy sneaker'), identity({ brand: 'On' })).brandMatched, false);
  const nb = identity({ exactItemHypothesis: '574', exactMatchGrade: 'verified' });
  assertEquals(scoreCommercialIdentity(product('New Balance 5740 sneaker', 'New Balance'), nb).exactMatchCoverage, 0);
  assertEquals(scoreCommercialIdentity(product('New Balance 574 sneaker', 'New Balance'), nb).exactMatchCoverage, 1);
  assertEquals(scoreCommercialIdentity(product('New Balance 5740 sneaker', 'New Balance'), identity({ exactItemHypothesis: 'New Balance 574', exactMatchGrade: 'verified' })).exactMatchCoverage, 0);
  assertEquals(scoreCommercialIdentity(product('New Balance burgundy sneaker', 'New Balance'), identity({ exactItemHypothesis: 'New Balance sneaker', exactMatchGrade: 'verified' })).exactMatchCoverage, 0);
  assertEquals(scoreCommercialIdentity(product('New Balance burgundy sneaker', 'New Balance'), identity({ exactItemHypothesis: 'New Balance burgundy sneaker', exactMatchGrade: 'verified' })).exactMatchCoverage, 0);
  assertEquals(scoreCommercialIdentity(product('New-Balance burgundy sneaker'), identity()).brandMatched, true);
});

Deno.test('ranking: same-brand sneaker outranks competitor titles referencing the recognized model', () => {
  const nb = product('New Balance burgundy sneaker', 'New Balance', 'https://shop.test/p/nb');
  const competitor = product('Nike burgundy sneaker like New Balance 574', 'Nike', 'https://shop.test/p/nike');
  const ranked = filterAndDedupeProducts([competitor, nb], sneaker, {
    enabled: true, categoryRoute: 'footwear', commerceIdentity: identity({ exactItemHypothesis: '574', exactMatchGrade: 'verified' }),
  });
  assertEquals(ranked.products[0].id, nb.id);
});

Deno.test('default relevance ranking: verified same-brand alternatives precede verbose other-brand styles without identity opt-in', () => {
  const garment = { ...sneaker, material_estimate: 'suede', visible_brand_text: 'New Balance' };
  const nb = product('New Balance sneakers', 'New Balance', 'https://shop.test/p/nb');
  const competitor = product('Nike burgundy suede sneaker', 'Nike', 'https://shop.test/p/nike');
  const ranked = filterAndDedupeProducts([competitor, nb], garment, { enabled: true, categoryRoute: 'footwear' });
  assertEquals(ranked.products[0].id, nb.id);
});

Deno.test('default relevance ranking: same-brand precedence requires subtype relevance and product brand evidence', () => {
  const garment = { ...sneaker, material_estimate: 'suede', visible_brand_text: 'New Balance' };
  const relevant = product('Nike burgundy suede sneaker', 'Nike', 'https://shop.test/p/relevant');
  const negativeControls = [
    product('New Balance boots', 'New Balance', 'https://shop.test/p/boots'),
    { ...product('Generic sneakers', undefined, 'https://shop.test/p/retailer'), source: 'New Balance' },
    product('Nike sneaker alternative to New Balance', 'Nike', 'https://shop.test/p/contradiction'),
  ];
  for (const control of negativeControls) {
    const ranked = filterAndDedupeProducts([control, relevant], garment, { enabled: true, categoryRoute: 'footwear' });
    assertEquals(ranked.products[0].id, relevant.id, control.title);
  }
});

Deno.test('commerce category: low/high-top sneaker construction is retained without accepting genuine tops or conflicting metadata', () => {
  for (const title of ['New Balance low top sneaker', 'New Balance high-top sneakers', 'New Balance low-top suede sneakers']) {
    for (const metadata of [{}, { category: 'footwear' }]) {
      const p = { ...product(title, 'New Balance'), ...metadata };
      const result = filterAndDedupeProducts([p], sneaker, { enabled: true, categoryRoute: 'footwear' });
      assertEquals(result.products.length, 1, `${title} ${JSON.stringify(metadata)}`);
      assertEquals(scoreProductAgreement(p, sneaker).clearCategoryConflict, false, title);
    }
  }
  for (const p of [
    product('New Balance cotton top', 'New Balance'),
    { ...product('New Balance high-top sneaker', 'New Balance'), category: 'top' },
    { ...product('New Balance low top sneaker', 'New Balance'), category: 'footwear', item_type: 'top' },
    { ...product('New Balance cotton top', 'New Balance'), category: 'footwear' },
  ]) {
    const result = filterAndDedupeProducts([p], sneaker, { enabled: true, categoryRoute: 'footwear' });
    assertEquals(result.products.length, 0, p.title);
    assertEquals(scoreProductAgreement(p, sneaker).clearCategoryConflict, true, p.title);
  }
});

Deno.test('commerce brand review: title-only brand matches use token boundaries and fallback remains brand neutral', () => {
  const garment = { ...sneaker, visible_brand_text: 'On' };
  const sameBrand = product('On sneakers', undefined, 'https://shop.test/p/on');
  const unrelated = product('Fashion burgundy suede sneaker', undefined, 'https://shop.test/p/fashion');
  const ranked = filterAndDedupeProducts([unrelated, sameBrand], { ...garment, material_estimate: 'suede' }, { enabled: true, categoryRoute: 'footwear' });
  assertEquals(ranked.products[0].id, sameBrand.id);
  for (const options of [{}, { detailLevel: 'specific' as const, brandAllowed: true }, { relevanceRoute: 'footwear' as const }]) {
    const query = buildWeightedCommerceQueries({ identification: { ...sneaker, visible_brand_text: 'New Balance' }, ...options });
    assert(!query.fallback.toLowerCase().includes('new balance'), query.fallback);
    assert(query.fallback.toLowerCase().includes('sneaker') || query.fallback.toLowerCase().includes('footwear'), query.fallback);
  }
});

Deno.test('commerce query: confirmed On brand survives stopword cleanup while attribute filler and budgets stay bounded', () => {
  const identification = { ...sneaker, visible_brand_text: 'On', distinctive_features: ['logo on tongue'] };
  for (const options of [{}, { detailLevel: 'specific' as const, brandAllowed: true }, { relevanceRoute: 'footwear' as const }]) {
    const query = buildWeightedCommerceQueries({ identification, ...options });
    assertEquals(query.primary.split(/\s+/).filter((word) => word.toLowerCase() === 'on').length, 1, query.primary);
    assert(query.primary.split(/\s+/).length <= 8, query.primary);
    assert(!/\bon\b/i.test(query.fallback), query.fallback);
  }
  const graded = buildCategoryCommerceQueries({
    identification, categoryRoute: 'footwear',
    commerceIdentity: identity({ brand: 'On', visibleBrandText: 'On', distinctiveFeatures: ['logo on tongue'] }),
  });
  assertEquals(graded.primary.split(/\s+/).filter((word) => word.toLowerCase() === 'on').length, 1, graded.primary);
  assert(graded.primary.split(/\s+/).length <= 8, graded.primary);
  const unbranded = buildWeightedCommerceQueries({ identification: { ...sneaker, distinctive_features: ['logo on tongue'] } });
  assert(!/\bon\b/i.test(unbranded.primary), unbranded.primary);
});

Deno.test('candidate validation: purchase destinations reject embedded credentials and malformed hosts', () => {
  for (const url of ['https://user:password@shop.test/p/shoe', 'https://shop.test:bad/p/shoe', 'javascript:alert(1)']) {
    assertEquals(hasValidPurchaseUrl(product('Burgundy sneaker', undefined, url)), false, url);
  }
  assertEquals(hasValidPurchaseUrl(product('Burgundy sneaker')), true);
});

Deno.test('candidate validation: malformed and negative prices are removed while absent prices remain optional', () => {
  for (const price of ['-10', 'USD', 'not priced']) {
    const result = filterAndDedupeProducts([{ ...product('Burgundy sneaker'), price }], sneaker);
    assertEquals(result.products.length, 0, price);
    assertEquals(result.stats.removedReasons.malformed_price, 1, price);
  }
  const result = filterAndDedupeProducts([{ ...product('Burgundy sneaker'), price: undefined }], sneaker);
  assertEquals(result.products.length, 1);
});
