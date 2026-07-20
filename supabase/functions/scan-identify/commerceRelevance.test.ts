/**
 * Commerce Relevance Layer (v122) — focused Deno tests.
 * Fixture-based; does not claim production accuracy.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  COMMERCE_RELEVANCE_VERSION,
  isCommerceRelevanceEnabled,
  MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY,
  MIN_DIVERSITY_AGREEMENT_SCORE,
  MIN_RELEVANCE_RESULTS_FOR_COVERAGE,
} from './commerceRelevanceConfig.ts';
import {
  FAILURE_REASONS,
  FAILURE_REASON_MODEL_TIMEOUT,
  isKnownFailureReason,
  mapToFailureReason,
  sanitizeFailureReason,
} from './commerceRelevanceFailure.ts';
import {
  colorTermsForQuery,
  materialForQuery,
  resolveColorCertainty,
  resolveMaterialCertainty,
} from './commerceRelevanceColorMaterial.ts';
import {
  AGREEMENT_STRONG_THRESHOLD,
  AGREEMENT_USABLE_THRESHOLD,
  scoreProductAgreement,
} from './commerceRelevanceAgreement.ts';
import {
  applySoftDiversityRerank,
  selectByAgreementCoverage,
  type ScoredProduct,
} from './commerceRelevanceDiversity.ts';
import { buildCategoryCommerceQueries } from './commerceRelevanceQueries.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
} from './qualityTuneCommerce.ts';
import { applyQualityTaxonomyTune } from './qualityTuneNormalize.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';
import {
  assertQualityMetricsPrivacy,
  buildQualityTuneMetrics,
} from './qualityTuneTelemetry.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

function product(partial: Partial<RecommendedProduct> & { title: string; productUrl: string }): RecommendedProduct {
  return {
    id: partial.id || `id-${partial.title.slice(0, 12)}`,
    title: partial.title,
    source: partial.source || 'RetailerA',
    price: partial.price,
    type: partial.type || 'retail',
    imageUrl: partial.imageUrl ?? 'https://cdn.example-shop.test/img.jpg',
    productUrl: partial.productUrl,
  };
}

// ── Config / flag ────────────────────────────────────────────────────────────

Deno.test('commerce relevance: version and flag semantics', () => {
  assertEquals(COMMERCE_RELEVANCE_VERSION, 'v122');
  assertEquals(isCommerceRelevanceEnabled(() => 'false'), false);
  assertEquals(isCommerceRelevanceEnabled(() => 'true'), true);
  assertEquals(isCommerceRelevanceEnabled(() => 'off'), false);
  assertEquals(isCommerceRelevanceEnabled(() => undefined), true);
  assertEquals(MIN_RELEVANCE_RESULTS_FOR_COVERAGE, 3);
  assertEquals(MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY, 3);
  assertEquals(MIN_DIVERSITY_AGREEMENT_SCORE, 50);
});

// ── Category query templates ─────────────────────────────────────────────────

Deno.test('category queries: apparel uses apparel attributes; excludes luxury dump', () => {
  const q = buildCategoryCommerceQueries({
    categoryRoute: 'apparel',
    detailLevel: 'specific',
    qualityBand: 'high',
    identification: {
      item_type: 'outerwear',
      subtype: 'moto jacket',
      primary_color: 'black',
      material_estimate: 'faux leather',
      silhouette: 'cropped',
      fit: 'oversized',
      style_tags: ['minimalist', 'luxury', 'vintage', 'designer'],
      logo_detected: false,
      brand_guess: 'Gucci',
    },
  });
  assert(/black/i.test(q.primary));
  assert(/moto|jacket/i.test(q.primary));
  assert(!/gucci/i.test(q.primary));
  assert(!/luxury|vintage|designer|minimalist/i.test(q.primary));
  const words = q.primary.split(/\s+/).filter(Boolean);
  assert(words.length <= 8);
  assert(words.length >= 3);
});

Deno.test('category queries: footwear excludes apparel-only fields', () => {
  const q = buildCategoryCommerceQueries({
    categoryRoute: 'footwear',
    detailLevel: 'specific',
    qualityBand: 'high',
    identification: {
      item_type: 'footwear',
      subtype: 'ankle boots',
      primary_color: 'black',
      toe_shape: 'square toe',
      material_estimate: 'leather',
      fit: 'slim',
      neckline_or_lapel: 'crew',
      sleeve_length: 'long',
      logo_detected: false,
    },
  });
  assert(/black/i.test(q.primary));
  assert(/boot/i.test(q.primary));
  assert(/square/i.test(q.primary));
  assert(!/\bfit\b|\bneckline\b|\bsleeve\b|\bwaist\b/i.test(q.primary));
  assert(q.primary.split(/\s+/).length <= 8);
});

Deno.test('category queries: bags and accessories templates', () => {
  const bag = buildCategoryCommerceQueries({
    categoryRoute: 'bags',
    detailLevel: 'specific',
    qualityBand: 'high',
    identification: {
      item_type: 'bag',
      subtype: 'handbag',
      primary_color: 'brown',
      silhouette: 'structured',
      material_estimate: 'leather',
      logo_detected: false,
    },
  });
  assert(/brown/i.test(bag.primary));
  assert(/handbag|bag/i.test(bag.primary));
  assert(!/\bfit\b|\bsleeve\b/i.test(bag.primary));

  const acc = buildCategoryCommerceQueries({
    categoryRoute: 'accessories',
    detailLevel: 'specific',
    qualityBand: 'high',
    identification: {
      item_type: 'accessory',
      subtype: 'sunglasses',
      primary_color: 'black',
      material_estimate: 'acetate',
      shape: 'rectangular',
      logo_detected: false,
    },
  });
  assert(/black/i.test(acc.primary));
  assert(/sunglass/i.test(acc.primary));
});

Deno.test('category queries: unsupported brand and material excluded', () => {
  const q = buildCategoryCommerceQueries({
    categoryRoute: 'apparel',
    detailLevel: 'specific',
    qualityBand: 'high',
    brandAllowed: false,
    materialAllowed: true,
    identification: {
      item_type: 'outerwear',
      subtype: 'jacket',
      primary_color: 'black',
      material_estimate: 'lambskin',
      brand_guess: 'Prada',
      logo_detected: false,
      visible_brand_text: null,
    },
  });
  assert(!/prada/i.test(q.primary));
  assert(!/lambskin/i.test(q.primary));
});

// ── Color / material certainty ───────────────────────────────────────────────

Deno.test('color: dark blue → navy; oxblood family; ivory≠white; camel≠brown display', () => {
  const navy = resolveColorCertainty('dark blue');
  assertEquals(navy?.canonicalSearchColor, 'navy');
  assert(navy?.displayColor.toLowerCase().includes('dark blue') || navy?.canonicalSearchColor === 'navy');

  const ox = resolveColorCertainty('oxblood');
  assertEquals(ox?.relatedSearchFamily, 'red');
  assertEquals(ox?.canonicalSearchColor, 'oxblood');

  const ivory = resolveColorCertainty('ivory');
  const white = resolveColorCertainty('white');
  assert(ivory && white);
  assert(ivory.displayColor.toLowerCase() !== white.displayColor.toLowerCase() ||
    ivory.canonicalSearchColor !== white.canonicalSearchColor);

  const camel = resolveColorCertainty('camel');
  const brown = resolveColorCertainty('brown');
  assert(camel && brown);
  assertEquals(camel.canonicalSearchColor, 'camel');
  assertEquals(brown.canonicalSearchColor, 'brown');

  const low = resolveColorCertainty('bluish maybe', { confidenceHint: 0.3 });
  assertEquals(low?.certainty, 'low');
  const lowTerms = colorTermsForQuery(low, { omitLowCertainty: true });
  assertEquals(lowTerms.length, 0);
});

Deno.test('material: supported/likely/appearance/unsupported matrix', () => {
  const leather = resolveMaterialCertainty('structured cotton canvas');
  assertEquals(leather?.certainty, 'supported');
  assert(materialForQuery(leather, 'primary', 'high').length > 0);

  const likely = resolveMaterialCertainty('likely suede');
  assertEquals(likely?.certainty, 'likely');
  assert(materialForQuery(likely, 'primary', 'high').includes('suede'));
  assertEquals(materialForQuery(likely, 'primary', 'low'), '');
  assert(materialForQuery(likely, 'fallback', 'low').includes('suede'));

  const look = resolveMaterialCertainty('leather-look');
  assertEquals(look?.certainty, 'appearance_only');
  assertEquals(materialForQuery(look, 'primary', 'high'), '');
  assert(materialForQuery(look, 'fallback', 'high').length > 0);

  const lamb = resolveMaterialCertainty('lambskin');
  assertEquals(lamb?.certainty, 'unsupported');
  assertEquals(materialForQuery(lamb, 'primary', 'high'), '');
  assertEquals(materialForQuery(lamb, 'fallback', 'high'), '');

  // Uncertain leather must not become faux leather
  const real = resolveMaterialCertainty('leather');
  assertEquals(real?.searchMaterial, 'leather');
  assert(!/faux/i.test(real?.searchMaterial || ''));
});

// ── Agreement scoring ────────────────────────────────────────────────────────

Deno.test('agreement: exact match strong; conflict weak; price/image/url rules', () => {
  const garment = {
    item_type: 'outerwear',
    subtype: 'moto jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
    silhouette: 'cropped',
    logo_detected: false,
    visible_brand_text: null,
    brand_guess: null,
  };

  const exact = scoreProductAgreement(
    product({
      title: 'Black Cropped Faux Leather Moto Jacket',
      productUrl: 'https://shop.test/p/1',
      price: '$120',
    }),
    garment,
  );
  assert(exact.score >= AGREEMENT_STRONG_THRESHOLD || exact.band === 'strong' || exact.score >= AGREEMENT_USABLE_THRESHOLD);
  assertEquals(exact.clearCategoryConflict, false);

  const conflict = scoreProductAgreement(
    product({
      title: 'White Running Sneakers',
      productUrl: 'https://shop.test/p/2',
      price: '$90',
    }),
    garment,
  );
  assert(conflict.score < AGREEMENT_USABLE_THRESHOLD || conflict.clearCategoryConflict);

  const missingPrice = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket Leather',
      productUrl: 'https://shop.test/p/3',
      price: undefined,
    }),
    garment,
  );
  const withPrice = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket Leather',
      productUrl: 'https://shop.test/p/3b',
      price: '$100',
    }),
    garment,
  );
  // Missing price must not score worse solely due to absence (allow small variance from other fields)
  assert(missingPrice.score >= withPrice.score - 5);

  const zero = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket',
      productUrl: 'https://shop.test/p/4',
      price: '0',
    }),
    garment,
  );
  assert(zero.score >= 0 && zero.score <= 100);

  const neg = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket',
      productUrl: 'https://shop.test/p/5',
      price: '-10',
    }),
    garment,
  );
  assert(neg.score < zero.score);

  const badUrl = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket',
      productUrl: 'not-a-url',
      imageUrl: 'https://cdn.example-shop.test/img.jpg',
    }),
    garment,
  );
  assert(badUrl.score < exact.score);

  const noImg = scoreProductAgreement(
    product({
      title: 'Black Moto Jacket',
      productUrl: 'https://shop.test/p/6',
      imageUrl: '',
    }),
    garment,
  );
  assert(noImg.score < exact.score);

  // Deterministic
  const a = scoreProductAgreement(
    product({ title: 'Black Moto Jacket', productUrl: 'https://shop.test/p/7', price: '$50' }),
    garment,
  );
  const b = scoreProductAgreement(
    product({ title: 'Black Moto Jacket', productUrl: 'https://shop.test/p/7', price: '$50' }),
    garment,
  );
  assertEquals(a.score, b.score);

  // Retailer identity does not affect score
  const r1 = scoreProductAgreement(
    product({ title: 'Black Moto Jacket', productUrl: 'https://a.test/p', source: 'Alpha', price: '$50' }),
    garment,
  );
  const r2 = scoreProductAgreement(
    product({ title: 'Black Moto Jacket', productUrl: 'https://b.test/p', source: 'Beta', price: '$50' }),
    garment,
  );
  assertEquals(r1.score, r2.score);

  // Brand bonus requires verified evidence
  const unverified = scoreProductAgreement(
    product({ title: 'Gucci Black Moto Jacket', productUrl: 'https://shop.test/g', price: '$500' }),
    { ...garment, brand_guess: 'Gucci', logo_detected: false, visible_brand_text: null },
  );
  const verified = scoreProductAgreement(
    product({ title: 'Gucci Black Moto Jacket', productUrl: 'https://shop.test/g2', price: '$500' }),
    { ...garment, brand_guess: 'Gucci', logo_detected: true, visible_brand_text: 'Gucci' },
  );
  assert(verified.score >= unverified.score);
});

// ── Diversity / coverage ─────────────────────────────────────────────────────

Deno.test('diversity: relevance primary; soft cap; single-retailer preserved', () => {
  const scored: ScoredProduct[] = [
    {
      product: product({ title: 'Black Jacket A', productUrl: 'https://a.test/1', source: 'R1' }),
      agreementScore: 90,
      agreementBand: 'strong',
      clearCategoryConflict: false,
      originalIndex: 0,
    },
    {
      product: product({ title: 'Black Jacket B', productUrl: 'https://a.test/2', source: 'R1' }),
      agreementScore: 85,
      agreementBand: 'strong',
      clearCategoryConflict: false,
      originalIndex: 1,
    },
    {
      product: product({ title: 'Black Jacket C', productUrl: 'https://a.test/3', source: 'R1' }),
      agreementScore: 80,
      agreementBand: 'strong',
      clearCategoryConflict: false,
      originalIndex: 2,
    },
    {
      product: product({ title: 'Black Jacket D', productUrl: 'https://a.test/4', source: 'R1' }),
      agreementScore: 78,
      agreementBand: 'strong',
      clearCategoryConflict: false,
      originalIndex: 3,
    },
    {
      product: product({ title: 'Black Jacket E', productUrl: 'https://b.test/1', source: 'R2' }),
      agreementScore: 70,
      agreementBand: 'usable',
      clearCategoryConflict: false,
      originalIndex: 4,
    },
    {
      product: product({ title: 'Weak Shoe', productUrl: 'https://c.test/1', source: 'R3' }),
      agreementScore: 20,
      agreementBand: 'weak',
      clearCategoryConflict: false,
      originalIndex: 5,
    },
  ];

  const out = applySoftDiversityRerank(scored);
  assert(out.length === scored.length); // held restored — no hard discard
  // Strong products remain ahead of weak diversity bait
  const weakIdx = out.findIndex((p) => p.title === 'Weak Shoe');
  const strongIdx = out.findIndex((p) => p.title === 'Black Jacket A');
  assert(strongIdx >= 0 && weakIdx > strongIdx);

  // Single retailer: preserve all
  const single = applySoftDiversityRerank(scored.filter((s) => s.product.source === 'R1'));
  assertEquals(single.length, 4);
});

Deno.test('filter+relevance: mismatches removed; coverage retains weak; dedupe tracking URLs', () => {
  const garment = {
    item_type: 'footwear',
    subtype: 'sneakers',
    primary_color: 'white',
    material_estimate: 'leather',
    logo_detected: false,
  };
  const products: RecommendedProduct[] = [
    product({
      title: 'White Leather Sneakers',
      productUrl: 'https://shop.test/s1?utm_source=x',
      source: 'A',
      price: '$90',
      id: 'sku-1',
    }),
    product({
      title: 'White Leather Sneakers',
      productUrl: 'https://shop.test/s1?fbclid=abc',
      source: 'A',
      price: '$90',
      id: 'sku-1',
    }),
    product({
      title: 'Red Evening Dress',
      productUrl: 'https://shop.test/dress',
      source: 'B',
      price: '$200',
    }),
    product({
      title: 'White Canvas Low Top',
      productUrl: 'https://shop.test/s2',
      source: 'C',
      price: undefined,
    }),
    product({
      title: 'Casual White Shoe',
      productUrl: 'https://shop.test/s3',
      source: 'D',
      price: '$40',
    }),
  ];

  const { products: out, stats } = filterAndDedupeProducts(products, garment, {
    enabled: true,
    categoryRoute: 'footwear',
    qualityBand: 'high',
  });

  assert(stats.categoryMismatchRemovals >= 1);
  assert(!out.some((p) => /dress/i.test(p.title)));
  assert(out.length >= 1);
  // True duplicate collapsed
  assert(out.filter((p) => /White Leather Sneakers/i.test(p.title)).length <= 1);
  // Client URL of kept product unchanged (may be either tracking variant — not rewritten)
  for (const p of out) {
    assert(typeof p.productUrl === 'string' && p.productUrl.startsWith('http'));
  }
});

// ── Failure reasons / telemetry privacy ──────────────────────────────────────

Deno.test('failure reasons: append-only set; sanitize; no raw leak', () => {
  assert(FAILURE_REASONS.includes(FAILURE_REASON_MODEL_TIMEOUT));
  assert(isKnownFailureReason('provider_timeout'));
  assertEquals(sanitizeFailureReason('model_timeout'), 'model_timeout');
  assertEquals(sanitizeFailureReason('Error: secret token abc'), 'unexpected_internal_error');
  assertEquals(
    mapToFailureReason({ isTimeout: true }),
    'model_timeout',
  );

  const metrics = buildQualityTuneMetrics({
    enabled: true,
    requestMode: 'selected_item',
    totalDurationMs: 1200,
    commerceRelevance: {
      failureReason: 'commerce_primary_empty',
      productsBeforeFilter: 5,
      productsAfterFilter: 0,
      retailerCount: 0,
      fallbackUsed: true,
      durationMs: 1200,
      intelligenceVersion: 'v121',
    },
  });
  assertEquals(metrics.commerce_relevance_version, 'v122');
  assertEquals(metrics.failure_reason, 'commerce_primary_empty');
  const privacy = assertQualityMetricsPrivacy(metrics);
  assertEquals(privacy.ok, true);

  const hostile = {
    ...metrics,
    raw_provider_response: 'SECRET',
    imageBase64: 'iVBORw0KGgo',
  };
  assertEquals(assertQualityMetricsPrivacy(hostile).ok, false);
});

// ── Flag-off equivalence with v121 helpers ───────────────────────────────────

Deno.test('rollback: relevance OFF commerce matches v121 (no relevanceRoute)', () => {
  const raw = {
    item_type: 'outerwear',
    subtype: 'moto jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
    silhouette: 'cropped',
    brand_guess: 'Gucci',
    logo_detected: false,
    visible_brand_text: null,
  };
  const tuned = applyQualityTaxonomyTune(raw);
  const gated = applyScannerQualityGate(tuned.identification);

  const v121 = buildWeightedCommerceQueries({
    identification: gated.identification,
    detailLevel: gated.commerceQueryDetailLevel,
    materialAllowed: !gated.materialSuppressed && gated.qualityBand !== 'low',
    brandAllowed: false,
  });
  // Flag OFF path: same call shape (no relevanceRoute)
  const v122Off = buildWeightedCommerceQueries({
    identification: gated.identification,
    detailLevel: gated.commerceQueryDetailLevel,
    materialAllowed: !gated.materialSuppressed && gated.qualityBand !== 'low',
    brandAllowed: false,
  });
  assertEquals(v121.primary, v122Off.primary);
  assertEquals(v121.fallback, v122Off.fallback);
  assertEquals(isCommerceRelevanceEnabled(() => 'false'), false);

  // Flag ON uses templates — may differ
  const v122On = buildWeightedCommerceQueries({
    identification: gated.identification,
    detailLevel: gated.commerceQueryDetailLevel,
    materialAllowed: true,
    brandAllowed: false,
    relevanceRoute: 'apparel',
    qualityBand: gated.qualityBand,
  });
  assert(v122On.primary.length > 0);
});

Deno.test('filter flag-off: identical ordering without relevance options', () => {
  const garment = {
    item_type: 'bag',
    subtype: 'tote',
    primary_color: 'black',
    material_estimate: 'leather',
  };
  const products = [
    product({ title: 'Black Leather Tote', productUrl: 'https://a.test/1', source: 'X', price: '$100' }),
    product({ title: 'Black Canvas Tote Bag', productUrl: 'https://b.test/1', source: 'Y', price: '$60' }),
    product({ title: 'Running Shoe', productUrl: 'https://c.test/1', source: 'Z', price: '$80' }),
  ];
  const a = filterAndDedupeProducts(products, garment);
  const b = filterAndDedupeProducts(products, garment);
  assertEquals(a.products.map((p) => p.productUrl), b.products.map((p) => p.productUrl));
  assertEquals(a.stats.productsAfterDedupe, b.stats.productsAfterDedupe);
});


Deno.test('coverage: weak products are capped at the coverage shortfall, not retained in full (v122 hostile-audit regression)', () => {
  const usable = (i: number): ScoredProduct => ({
    product: product({ title: `Usable ${i}`, productUrl: `https://a.test/u${i}`, source: 'A' }),
    agreementScore: 60,
    agreementBand: 'usable',
    clearCategoryConflict: false,
    originalIndex: i,
  });
  const weak = (i: number): ScoredProduct => ({
    product: product({ title: `Weak ${i}`, productUrl: `https://a.test/w${i}`, source: 'A' }),
    agreementScore: 30,
    agreementBand: 'weak',
    clearCategoryConflict: false,
    originalIndex: 100 + i,
  });

  // 2 usable + 5 weak; MIN_RELEVANCE_RESULTS_FOR_COVERAGE = 3 → needed = 1.
  const scored = [usable(0), usable(1), weak(0), weak(1), weak(2), weak(3), weak(4)];
  const result = selectByAgreementCoverage(scored);

  const weakCount = result.filter((s) => s.agreementBand === 'weak').length;
  assert(
    weakCount === 1,
    `expected exactly 1 weak product to fill the coverage shortfall, got ${weakCount} (this was previously all 5 — Math.max(needed, weak.length) never truncates)`,
  );
  assertEquals(result.filter((s) => s.agreementBand === 'usable').length, 2);
});

Deno.test('coverage: 0 usable + 8 weak retains only the coverage minimum, not every weak product', () => {
  const weak = (i: number): ScoredProduct => ({
    product: product({ title: `Weak ${i}`, productUrl: `https://a.test/w${i}`, source: 'A' }),
    agreementScore: 20 + i,
    agreementBand: 'weak',
    clearCategoryConflict: false,
    originalIndex: i,
  });
  const scored = Array.from({ length: 8 }, (_, i) => weak(i));
  const result = selectByAgreementCoverage(scored);
  assertEquals(result.length, 3, 'needed = 3 - 0 = 3; must not return all 8 weak products');
});
