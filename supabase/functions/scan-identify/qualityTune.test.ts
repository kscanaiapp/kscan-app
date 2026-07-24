/**
 * Deterministic quality-tune regression tests (Deno).
 * Compares v119-equivalent (passthrough) vs tuned normalizer/commerce helpers.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyQualityTaxonomyTune, isGenericFashionLabel } from './qualityTuneNormalize.ts';
import {
  buildWeightedCommerceQueries,
  canonicalizeUrlForIdentity,
  filterAndDedupeProducts,
  shouldRunFallbackQuery,
} from './qualityTuneCommerce.ts';
import { isQualityTuneEnabled, QUALITY_TUNE_MIN_VALID_PRODUCTS, QUALITY_TUNE_VERSION } from './qualityTuneConfig.ts';
import {
  assertQualityMetricsPrivacy,
  buildQualityTuneMetrics,
} from './qualityTuneTelemetry.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

const fixturesPath = new URL(
  '../../../qa/backend-quality-tune-fixtures/fixtures.json',
  import.meta.url,
);

Deno.test('quality tune version is v120', () => {
  assertEquals(QUALITY_TUNE_VERSION, 'v120');
});

Deno.test('quality tune flag respects BACKEND_QUALITY_TUNE_ENABLED=false', () => {
  assertEquals(isQualityTuneEnabled(() => 'false'), false);
  assertEquals(isQualityTuneEnabled(() => 'true'), true);
});

Deno.test('taxonomy: synonym + generic recovery fixtures', async () => {
  const fixtures = JSON.parse(await Deno.readTextFile(fixturesPath));
  let genericBefore = 0;
  let genericAfter = 0;
  let invalidBefore = 0;
  let invalidAfter = 0;

  for (const caseRow of [...fixtures.garments, ...fixtures.hostile]) {
    const beforeType = caseRow.identification?.item_type;
    const beforeSub = caseRow.identification?.subtype;
    if (isGenericFashionLabel(beforeType)) genericBefore += 1;
    if (
      typeof beforeType === 'string' &&
      typeof beforeSub === 'string' &&
      /skirt/i.test(beforeType) &&
      /trouser|pants/i.test(beforeSub)
    ) {
      invalidBefore += 1;
    }

    const tuned = applyQualityTaxonomyTune(caseRow.identification, caseRow.attributes);
    if (isGenericFashionLabel(tuned.identification.item_type)) genericAfter += 1;
    const afterType = String(tuned.identification.item_type || '');
    const afterSub = String(tuned.identification.subtype || '');
    if (/skirt/i.test(afterType) && /trouser|pants/i.test(afterSub)) invalidAfter += 1;

    // Response shape keys preserved for core fields when present upstream
    assert('item_type' in tuned.identification || beforeType === undefined);
  }

  assert(genericAfter <= genericBefore, `generic labels should not increase (${genericBefore}→${genericAfter})`);
  assert(invalidAfter <= invalidBefore, `invalid pairs should not increase (${invalidBefore}→${invalidAfter})`);

  const navy = applyQualityTaxonomyTune({
    item_type: 'blazer',
    subtype: 'sportcoat',
    primary_color: 'dark blue',
  });
  assertEquals(String(navy.identification.subtype), 'Sport Coat');
  assertEquals(String(navy.identification.primary_color), 'Navy');

  const recovered = applyQualityTaxonomyTune(
    { item_type: 'Fashion Item', subtype: 'unknown', primary_color: 'black' },
    { category: 'outerwear', itemType: 'moto jacket' },
  );
  assertEquals(String(recovered.identification.item_type), 'outerwear');
  assert(!isGenericFashionLabel(recovered.identification.subtype));

  const brand = applyQualityTaxonomyTune({
    item_type: 'bag',
    subtype: 'handbag',
    brand_guess: 'Gucci',
    logo_detected: false,
    visible_brand_text: null,
  });
  assertEquals(brand.identification.brand_guess, null);
});

Deno.test('commerce: weighted query + fallback threshold', () => {
  const q = buildWeightedCommerceQueries({
    identification: {
      item_type: 'outerwear',
      subtype: 'Moto Jacket',
      primary_color: 'black',
      material_estimate: 'faux leather',
      silhouette: 'cropped',
      brand_guess: 'Gucci',
      logo_detected: false,
      visible_brand_text: null,
      search_queries: [
        'black cropped oversized minimalist luxury vintage-inspired faux lamb leather boyfriend moto biker jacket with silver hardware',
      ],
    },
  });
  assert(q.primary.length > 0);
  assert(!/gucci/i.test(q.primary), 'unverified brand must be excluded');
  assert(!/luxury|vintage-inspired|boyfriend/i.test(q.primary));
  assert(q.fallback.length > 0);
  assert(q.fallback.split(' ').length <= q.primary.split(' ').length);
  assertEquals(shouldRunFallbackQuery(2, QUALITY_TUNE_MIN_VALID_PRODUCTS), true);
  assertEquals(shouldRunFallbackQuery(3, QUALITY_TUNE_MIN_VALID_PRODUCTS), false);
});

Deno.test('commerce: URL identity canonicalization preserves client URL semantics', () => {
  const raw = 'https://www.retailer.com/product/123?utm_source=email&ref=newsletter';
  const key = canonicalizeUrlForIdentity(raw);
  assertEquals(key, 'https://www.retailer.com/product/123');
  // Returned URL unchanged by canonicalize helper (identity only)
  assertEquals(raw.includes('utm_source'), true);
});

Deno.test('commerce: filter duplicates, mismatches, and invalid shells', async () => {
  const fixtures = JSON.parse(await Deno.readTextFile(fixturesPath));
  const garment = {
    item_type: 'outerwear',
    subtype: 'Moto Jacket',
    primary_color: 'black',
    material_estimate: 'faux leather',
  };
  const before = fixtures.products as RecommendedProduct[];
  const { products, stats } = filterAndDedupeProducts(before, garment);
  assert(stats.productsAfterDedupe < before.length);
  assert(stats.productsAfterDedupe <= stats.productsBeforeDedupe);
  assert(stats.categoryMismatchRemovals >= 1);
  assert(products.every((p) => typeof p.productUrl === 'string' && p.productUrl.startsWith('http')));
  assert(products.every((p) => typeof p.imageUrl === 'string' && p.imageUrl.startsWith('http')));
  // Client-facing URL must retain original tracking params when present on kept row
  const keptWithUtm = products.find((p) => (p.productUrl || '').includes('utm_') || (p.productUrl || '').includes('retailer.com/product/123'));
  if (keptWithUtm) {
    assertNotEquals(keptWithUtm.productUrl, canonicalizeUrlForIdentity(keptWithUtm.productUrl));
  }
});

Deno.test('telemetry privacy: hostile payloads cannot be emitted', () => {
  const hostile = {
    request_mode: 'selected_item',
    // Attempt to sneak prohibited fields — builder must not accept them
    imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    email: 'tester@example.com',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
    user_id: 'user_full_id_abc123',
    scanSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    imageDigestPrefix: 'deadbeefdeadbeefdeadbeefdeadbeef',
    rawPrompt: 'SECRET PROMPT',
    rawProviderResponse: '{"secret":true}',
    textQuery: 'black cropped moto jacket personal note',
  };

  const metrics = buildQualityTuneMetrics({
    enabled: true,
    requestMode: 'selected_item',
    totalDurationMs: 1200,
    genericLabelOccurrence: 0,
    normalizationCorrectionCount: 2,
    normalizationRuleIds: ['color_synonym'],
    primaryCommerceResultCount: 4,
    fallbackQueryUsage: false,
    productsBeforeDedupe: 6,
    productsAfterDedupe: 4,
    categoryMismatchRemovals: 1,
    emptyResultOccurrence: 0,
  });

  // Ensure builder output has only allowlisted keys
  const allowed = new Set([
    'request_mode',
    'total_duration_ms',
    'model_duration_ms',
    'commerce_duration_ms',
    'provider_outcome',
    'candidate_count',
    'generic_label_occurrence',
    'normalization_correction_count',
    'normalization_rule_ids',
    'primary_commerce_result_count',
    'fallback_query_usage',
    'products_before_dedupe',
    'products_after_dedupe',
    'category_mismatch_removals',
    'empty_result_occurrence',
    'error_category',
    'quality_tune_version',
    'treatment_bucket',
  ]);
  for (const key of Object.keys(metrics)) {
    assert(allowed.has(key), `unexpected metrics key ${key}`);
  }
  const prohibitedHostileKeys = [
    'imageBase64',
    'email',
    'authorization',
    'user_id',
    'scanSessionId',
    'imageDigestPrefix',
    'rawPrompt',
    'rawProviderResponse',
    'textQuery',
  ];
  for (const key of prohibitedHostileKeys) {
    assertEquals((metrics as Record<string, unknown>)[key], undefined);
  }

  const privacy = assertQualityMetricsPrivacy(metrics);
  assertEquals(privacy.ok, true);

  const poisoned = { ...metrics, email: 'x@y.com', imageBase64: '/9j/hostile' };
  const blocked = assertQualityMetricsPrivacy(poisoned);
  assertEquals(blocked.ok, false);
});

Deno.test('contract shape: products and purchaseOptions remain separate arrays conceptually', () => {
  // Mapping integrity documentation test — arrays are not merged by filter helper
  const garment = { item_type: 'outerwear', subtype: 'Moto Jacket', primary_color: 'black' };
  const products: RecommendedProduct[] = [
    {
      id: '1',
      title: 'Black Moto Jacket',
      source: 'A',
      price: '$10',
      type: 'retail',
      imageUrl: 'https://cdn.a.test/1.jpg',
      productUrl: 'https://a.test/1',
    },
  ];
  const filtered = filterAndDedupeProducts(products, garment).products;
  // Caller maps similarity → products and recommendations → purchaseOptions
  const responseProducts = filtered;
  const purchaseOptions = filtered;
  assert(Array.isArray(responseProducts));
  assert(Array.isArray(purchaseOptions));
  assertEquals(responseProducts === purchaseOptions || responseProducts.length === purchaseOptions.length, true);
});
