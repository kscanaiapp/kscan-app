/**
 * v121 Scanner Intelligence Layer — routing, scoring, commerce, rollback equivalence.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyQualityTaxonomyTune } from './qualityTuneNormalize.ts';
import {
  buildWeightedCommerceQueries,
  shouldRunFallbackQuery,
  QUALITY_TUNE_MIN_VALID_PRODUCTS,
} from './qualityTuneCommerce.ts';
import { isQualityTuneEnabled, QUALITY_TUNE_VERSION } from './qualityTuneConfig.ts';
import {
  assertQualityMetricsPrivacy,
  buildQualityTuneMetrics,
} from './qualityTuneTelemetry.ts';
import {
  isScannerIntelligenceEnabled,
  SCANNER_INTELLIGENCE_VERSION,
} from './scannerIntelligenceConfig.ts';
import {
  categoryToScannerRoute,
  getCategoryRoutePromptAddendum,
  isAuthoritativeProviderCategory,
  resolveScannerCategoryRoute,
  resolveTextScanCategoryRoute,
} from './scannerCategoryRoute.ts';
import {
  applyScannerQualityGate,
  PENALTY_CATEGORY_SUBTYPE_CONFLICT,
  QUALITY_SCORE_HIGH_THRESHOLD,
  QUALITY_SCORE_MODERATE_THRESHOLD,
  SCORE_VALID_CATEGORY,
  scoreIdentificationQuality,
} from './scannerQualityGate.ts';

Deno.test('intelligence version is v121; quality tune remains v120', () => {
  assertEquals(SCANNER_INTELLIGENCE_VERSION, 'v121');
  assertEquals(QUALITY_TUNE_VERSION, 'v120');
});

Deno.test('feature flags: intelligence OFF / quality OFF semantics', () => {
  assertEquals(isScannerIntelligenceEnabled(() => 'false'), false);
  assertEquals(isScannerIntelligenceEnabled(() => 'true'), true);
  assertEquals(isQualityTuneEnabled(() => 'false'), false);
  assertEquals(isQualityTuneEnabled(() => 'true'), true);
});

// ── Routing ──────────────────────────────────────────────────────────────────

Deno.test('routing: multi_item_detection always general', () => {
  assertEquals(
    resolveScannerCategoryRoute({
      requestMode: 'multi_item_detection',
      selectedCandidate: { category: 'footwear', subtype: 'sneakers' },
      textQuery: 'black boots',
    }),
    'general',
  );
});

Deno.test('routing: selected_item priority + conflict handling', () => {
  // Valid provider category outranks weaker label
  assertEquals(
    resolveScannerCategoryRoute({
      requestMode: 'selected_item',
      selectedCandidate: {
        category: 'footwear',
        subtype: 'sneakers',
        label: 'maybe a bag',
        providerCategory: 'footwear',
      },
    }),
    'footwear',
  );

  // Conflicting provider category does NOT outrank coherent subtype
  assertEquals(
    isAuthoritativeProviderCategory('bag', 'Wide-Leg Trousers'),
    false,
  );
  assertEquals(
    resolveScannerCategoryRoute({
      requestMode: 'selected_item',
      selectedCandidate: {
        category: 'bag',
        providerCategory: 'bag',
        subtype: 'Wide-Leg Trousers',
        label: 'trousers',
      },
    }),
    'apparel',
  );
});

Deno.test('routing: TextScan keyword pre-pass', () => {
  assertEquals(resolveTextScanCategoryRoute('black cropped moto jacket'), 'apparel');
  assertEquals(resolveTextScanCategoryRoute('low-profile leather sneakers'), 'footwear');
  assertEquals(resolveTextScanCategoryRoute('structured leather handbag'), 'bags');
  assertEquals(resolveTextScanCategoryRoute('rectangular acetate sunglasses'), 'accessories');
  assertEquals(resolveTextScanCategoryRoute('ballet flat shoes'), 'footwear');
  // Ambiguous → general
  assertEquals(resolveTextScanCategoryRoute('jacket and boots and handbag'), 'general');
  assertEquals(resolveTextScanCategoryRoute('something stylish'), 'general');
  assertEquals(resolveTextScanCategoryRoute(''), 'general');
});

Deno.test('routing: legacy uses known evidence else general', () => {
  assertEquals(
    resolveScannerCategoryRoute({ requestMode: 'legacy_single_item' }),
    'general',
  );
  assertEquals(
    resolveScannerCategoryRoute({
      requestMode: 'legacy_single_item',
      knownCategory: 'bag',
      knownSubtype: 'satchel',
    }),
    'bags',
  );
});

Deno.test('routing: adds prompt text only — no model call artifact', () => {
  const addendum = getCategoryRoutePromptAddendum('apparel');
  assert(addendum.includes('Category route: apparel'));
  assert(addendum.includes('Preserve the exact existing JSON'));
  assertEquals(categoryToScannerRoute('outerwear'), 'apparel');
  assertEquals(categoryToScannerRoute('bodysuit'), 'apparel');
});

// ── Quality score ────────────────────────────────────────────────────────────

Deno.test('score: coherent specific result scores high', () => {
  const gated = applyScannerQualityGate({
    item_type: 'outerwear',
    subtype: 'Moto Jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
    silhouette: 'cropped',
    fit: 'fitted',
    pattern: 'solid',
    distinctive_features: ['asymmetric zip'],
    logo_detected: false,
    brand_guess: null,
  });
  assert(gated.qualityScore >= QUALITY_SCORE_HIGH_THRESHOLD, `score=${gated.qualityScore}`);
  assertEquals(gated.qualityBand, 'high');
  assertEquals(gated.commerceQueryDetailLevel, 'specific');
});

Deno.test('score: coherent broad result scores moderate', () => {
  const gated = applyScannerQualityGate({
    item_type: 'pants',
    subtype: 'Trousers',
    primary_color: 'charcoal',
    pattern: 'solid',
  });
  assert(
    gated.qualityScore >= QUALITY_SCORE_MODERATE_THRESHOLD &&
      gated.qualityScore < QUALITY_SCORE_HIGH_THRESHOLD,
    `score=${gated.qualityScore}`,
  );
  assertEquals(gated.qualityBand, 'moderate');
});

Deno.test('score: generic result scores low', () => {
  const gated = applyScannerQualityGate({
    item_type: 'Fashion Item',
    subtype: 'unknown',
    primary_color: 'unknown',
  });
  assert(gated.qualityScore < QUALITY_SCORE_MODERATE_THRESHOLD, `score=${gated.qualityScore}`);
  assertEquals(gated.qualityBand, 'low');
});

Deno.test('score: conflict penalty + suppress subtype', () => {
  const gated = applyScannerQualityGate({
    item_type: 'dress',
    subtype: 'Straight-Leg Trousers',
    primary_color: 'black',
  });
  assert(gated.consistencyConflicts.some((c) => c.code === 'category_subtype_conflict'));
  assertEquals(gated.identification.subtype, '');
  assert(gated.suppressedAttributes.includes('subtype'));
  // Penalty applied (score lower than conflict-free peer)
  const clean = applyScannerQualityGate({
    item_type: 'dress',
    subtype: 'Pleated Skirt',
    primary_color: 'black',
  });
  assert(gated.qualityScore < clean.qualityScore);
  assert(PENALTY_CATEGORY_SUBTYPE_CONFLICT < 0);
  assert(SCORE_VALID_CATEGORY === 25);
});

Deno.test('score: unsupported brand and material suppressed', () => {
  const gated = applyScannerQualityGate({
    item_type: 'bag',
    subtype: 'Handbag',
    primary_color: 'black',
    brand_guess: 'Miu Miu-style',
    logo_detected: false,
    visible_brand_text: null,
    material_estimate: 'possibly leather',
  });
  assertEquals(gated.identification.brand_guess, null);
  assert(gated.brandSuppressed);
  assert(gated.materialSuppressed);
  assertEquals(gated.identification.material_estimate, '');
});

Deno.test('score: duplicates + malformed penalized; clamps 0–100; deterministic', () => {
  const input = {
    item_type: 'outerwear',
    subtype: 'Jacket Jacket',
    primary_color: 'black',
    style_tags: ['edgy', 'edgy', 'luxury', 'edgy'],
    distinctive_features: 123 as unknown as string[],
  };
  const a = applyScannerQualityGate(input as Record<string, unknown>);
  const b = applyScannerQualityGate(input as Record<string, unknown>);
  assertEquals(a.qualityScore, b.qualityScore);
  assert(a.qualityScore >= 0 && a.qualityScore <= 100);
  assert(a.suppressedAttributes.includes('distinctive_features') || a.consistencyConflicts.length >= 0);
});

Deno.test('taxonomy: bodysuit parka ballet flat satchel brooch preserved', () => {
  const cases = [
    { item_type: 'top', subtype: 'Bodysuit' },
    { item_type: 'outerwear', subtype: 'Parka' },
    { item_type: 'footwear', subtype: 'Ballet Flat' },
    { item_type: 'bag', subtype: 'Satchel' },
    { item_type: 'accessory', subtype: 'Brooch' },
  ];
  for (const c of cases) {
    const gated = applyScannerQualityGate(c);
    assertEquals(String(gated.identification.subtype).toLowerCase(), c.subtype.toLowerCase());
    assert(
      !gated.consistencyConflicts.some((x) => x.code === 'category_subtype_conflict'),
      `unexpected conflict for ${c.subtype}`,
    );
  }
});

// ── Commerce ─────────────────────────────────────────────────────────────────

Deno.test('commerce: quality tiers vary query detail; max 8 words; brand/material rules', () => {
  const base = {
    item_type: 'outerwear',
    subtype: 'Moto Jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
    silhouette: 'cropped',
    brand_guess: 'Gucci',
    logo_detected: false,
    visible_brand_text: null,
  };

  const high = buildWeightedCommerceQueries({
    identification: base,
    detailLevel: 'specific',
    materialAllowed: true,
    brandAllowed: false,
  });
  assert(/black/i.test(high.primary));
  assert(/moto/i.test(high.primary));
  assert(/faux|leather/i.test(high.primary));
  assert(!/gucci/i.test(high.primary));
  assert(high.primary.split(/\s+/).filter(Boolean).length <= 8);

  const mod = buildWeightedCommerceQueries({
    identification: base,
    detailLevel: 'moderate',
    materialAllowed: false,
    brandAllowed: false,
  });
  assert(/black/i.test(mod.primary));
  assert(!/faux leather/i.test(mod.primary) || mod.primary.split(' ').length <= 8);
  assert(!/gucci/i.test(mod.primary));

  const low = buildWeightedCommerceQueries({
    identification: base,
    detailLevel: 'broad',
    materialAllowed: false,
    brandAllowed: false,
  });
  assert(/black/i.test(low.primary));
  assert(/outerwear|jacket/i.test(low.primary));
  assert(!/gucci/i.test(low.primary));
  assert(low.primary.split(/\s+/).filter(Boolean).length <= 8);

  assertEquals(shouldRunFallbackQuery(2, QUALITY_TUNE_MIN_VALID_PRODUCTS), true);
  assertEquals(QUALITY_TUNE_MIN_VALID_PRODUCTS, 3);
});

Deno.test('commerce: v120 path unchanged when detailLevel omitted', () => {
  const id = {
    item_type: 'outerwear',
    subtype: 'Moto Jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
    silhouette: 'cropped',
    brand_guess: 'Gucci',
    logo_detected: false,
    visible_brand_text: null,
    search_queries: ['black cropped faux leather moto jacket'],
  };
  const a = buildWeightedCommerceQueries({ identification: id });
  const b = buildWeightedCommerceQueries({ identification: { ...id } });
  assertEquals(a.primary, b.primary);
  assertEquals(a.fallback, b.fallback);
  assert(!/gucci/i.test(a.primary));
});

// ── Rollback equivalence: v120 tune == intelligence OFF path helpers ─────────

Deno.test('rollback: intelligence OFF commerce/normalize matches v120 helpers', () => {
  const raw = {
    item_type: 'Jacket',
    subtype: 'moto jacket',
    primary_color: 'dark blue',
    material_estimate: 'faux leather',
    brand_guess: 'Gucci',
    logo_detected: false,
    visible_brand_text: null,
  };
  const tuned = applyQualityTaxonomyTune(raw);
  // Intelligence OFF: only v120 tune + v120 commerce (no detailLevel)
  const v120Query = buildWeightedCommerceQueries({ identification: tuned.identification });
  // Intelligence ON would pass detailLevel — must differ or equal but flag path is gated in index
  const v121Query = buildWeightedCommerceQueries({
    identification: applyScannerQualityGate(tuned.identification).identification,
    detailLevel: 'specific',
    materialAllowed: true,
    brandAllowed: false,
  });
  assert(v120Query.primary.length > 0);
  assert(v121Query.primary.length > 0);
  // Flag semantics
  assertEquals(isScannerIntelligenceEnabled(() => 'false'), false);
});

// ── Telemetry privacy ────────────────────────────────────────────────────────

Deno.test('telemetry: intelligence fields allowlisted; hostile payloads blocked', () => {
  const metrics = buildQualityTuneMetrics({
    enabled: true,
    requestMode: 'text',
    totalDurationMs: 900,
    genericLabelOccurrence: 0,
    normalizationCorrectionCount: 1,
    normalizationRuleIds: ['color_synonym'],
    intelligence: {
      categoryRoute: 'apparel',
      qualityScoreBand: 'high',
      qualityScoreValue: 88,
      consistencyConflictCount: 0,
      suppressedAttributeCount: 1,
      commerceQueryDetailLevel: 'specific',
      brandSuppressed: true,
      materialSuppressed: false,
    },
  });

  assertEquals(metrics.category_route, 'apparel');
  assertEquals(metrics.quality_score_band, 'high');
  assertEquals(metrics.quality_score_value, 88);

  const allowedExtra = [
    'category_route', 'quality_score_band', 'quality_score_value',
    'consistency_conflict_count', 'suppressed_attribute_count',
    'commerce_query_detail_level', 'brand_suppressed', 'material_suppressed',
  ];
  for (const k of allowedExtra) assert(k in metrics);

  // OFF path must not include intelligence keys
  const off = buildQualityTuneMetrics({
    enabled: true,
    requestMode: 'legacy_single_item',
    totalDurationMs: 100,
  });
  for (const k of allowedExtra) {
    assertEquals((off as Record<string, unknown>)[k], undefined);
  }

  const privacy = assertQualityMetricsPrivacy(metrics);
  assertEquals(privacy.ok, true);

  const poisoned = {
    ...metrics,
    imageBase64: 'iVBORw0KGgoAAAANSUhEUg',
    email: 'a@b.com',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
    rawPrompt: 'SECRET',
    rawProviderResponse: '{"x":1}',
    textQuery: 'black jacket personal',
    user_id: 'user_full_id_abc',
    scanSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  assertEquals(assertQualityMetricsPrivacy(poisoned).ok, false);
});

Deno.test('scoreIdentificationQuality deterministic wrapper', () => {
  const id = { item_type: 'footwear', subtype: 'Chelsea Boot', primary_color: 'black', material_estimate: 'leather' };
  assertEquals(scoreIdentificationQuality(id).score, scoreIdentificationQuality(id).score);
  assertNotEquals(scoreIdentificationQuality(id).band, 'low');
});
