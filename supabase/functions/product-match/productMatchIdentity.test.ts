/**
 * Product Match V1 — identity, normalization and dedupe (Deno).
 *
 * Deterministic. No network, no database, no clock dependence.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  canonicalizeProductUrl,
  contentTokens,
  familyKeyOf,
  listingKeyOf,
  normalizeColor,
  normalizeModel,
  slugify,
  variantKeyOf,
} from './identity.ts';
import {
  isTestCatalogRow,
  normalizeCatalogRow,
  normalizeRecommendedProduct,
  normalizeRetailerProduct,
  type NormalizedRow,
} from './normalize.ts';
import { dedupeRows } from './dedupe.ts';

// ── identity ────────────────────────────────────────────────────────────────

Deno.test('slugify is stable and punctuation-insensitive', () => {
  assertEquals(slugify("Nike Air Force 1 '07"), 'nike-air-force-1-07');
  assertEquals(slugify('nike  air   force 1 07'), 'nike-air-force-1-07');
  assertEquals(slugify(''), '');
  assertEquals(slugify(null), '');
});

Deno.test('contentTokens strips listing noise but keeps model tokens', () => {
  const tokens = contentTokens("Buy Nike Air Force 1 '07 — Men's Shoes (Sale)");
  assert(tokens.includes('air'), 'model token "air" must survive');
  assert(tokens.includes('force'), 'model token "force" must survive');
  assert(!tokens.includes('buy'), 'listing noise must be removed');
  assert(!tokens.includes('sale'), 'listing noise must be removed');
  assert(!tokens.includes('mens'), 'listing noise must be removed');
});

Deno.test('normalizeColor maps synonyms to a canonical head term', () => {
  assertEquals(normalizeColor('Triple White'), 'white');
  assertEquals(normalizeColor('off-white'), 'white');
  assertEquals(normalizeColor('Charcoal'), 'grey');
  assertEquals(normalizeColor('gray'), 'grey');
  assertEquals(normalizeColor(null), null);
});

Deno.test('normalizeColor preserves an unrecognized colour rather than dropping it', () => {
  assertEquals(normalizeColor('chartreuse'), 'chartreuse');
});

Deno.test('normalizeModel removes the brand and returns null when nothing survives', () => {
  assertEquals(normalizeModel('Nike Air Force 1', 'nike'), 'air-force-1');
  assertEquals(normalizeModel('Nike', 'nike'), null);
});

Deno.test('canonicalizeProductUrl strips tracking parameters and www', () => {
  assertEquals(
    canonicalizeProductUrl('https://www.farfetch.com/shopping/item-123.aspx?utm_source=x&size=10'),
    'https://farfetch.com/shopping/item-123.aspx',
  );
  assertEquals(canonicalizeProductUrl('javascript:alert(1)'), null);
  assertEquals(canonicalizeProductUrl('not a url'), null);
});

Deno.test('familyKey separates different models and unites spellings of one', () => {
  const a = familyKeyOf({ brand: 'nike', model: 'air-force-1', canonicalCategory: 'footwear' });
  const b = familyKeyOf({ brand: 'nike', model: 'air-force-1', canonicalCategory: 'footwear' });
  const c = familyKeyOf({ brand: 'nike', model: 'air-max-90', canonicalCategory: 'footwear' });
  assertEquals(a, b);
  assertNotEquals(a, c);
});

Deno.test('variantKey prefers an exact identifier over colourway', () => {
  const family = 'nike|air-force-1|footwear';
  const byId = variantKeyOf({ familyKey: family, colorway: 'white', exactProductId: 'CW2288-111' });
  const byIdOtherColorSpelling = variantKeyOf({
    familyKey: family,
    colorway: 'cream',
    exactProductId: 'CW2288-111',
  });
  assertEquals(byId, byIdOtherColorSpelling);
});

Deno.test('listingKey collapses to the canonical URL when one exists', () => {
  const a = listingKeyOf({ productUrl: 'https://farfetch.com/x', source: 'farfetch', providerId: '1' });
  const b = listingKeyOf({ productUrl: 'https://farfetch.com/x', source: 'serper', providerId: '9' });
  assertEquals(a, b, 'the same canonical URL from two sources is one listing');
});

// ── normalization ───────────────────────────────────────────────────────────

Deno.test('a Serper result never carries an exact product identifier', () => {
  const row = normalizeRecommendedProduct(
    { id: '3', title: 'Nike Air Force 1 07 White', source: 'nike.com', productUrl: 'https://nike.com/t/af1' },
    'serper',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
  );
  assert(row !== null);
  assertEquals(row.variant.exactProductId, null, 'a search-result id is a position, not a SKU');
});

Deno.test('a Farfetch result does carry an exact product identifier', () => {
  const row = normalizeRetailerProduct(
    {
      id: 'ff-99123',
      title: 'Nike Air Force 1 07 sneakers',
      retailer: 'Farfetch',
      productUrl: 'https://www.farfetch.com/shopping/item-99123.aspx',
    },
    'farfetch',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
  );
  assert(row !== null);
  assertEquals(row.variant.exactProductId, 'ff-99123');
});

Deno.test('a brand hint is only credited when the title independently carries it', () => {
  const matching = normalizeRecommendedProduct(
    { id: '1', title: 'Nike Air Force 1', productUrl: 'https://nike.com/a' },
    'serper',
    { brand: 'Nike' },
  );
  const notMatching = normalizeRecommendedProduct(
    { id: '2', title: 'Generic white sneaker', productUrl: 'https://example.com/b' },
    'serper',
    { brand: 'Nike' },
  );
  assertEquals(matching?.family.brand, 'nike');
  assertEquals(notMatching?.family.brand, null, 'a hint must never manufacture brand evidence');
});

Deno.test('rows without a title are rejected rather than given an empty identity', () => {
  assertEquals(normalizeRecommendedProduct({ id: '1', productUrl: 'https://x.com/a' }, 'serper'), null);
});

Deno.test('production test-catalog rows are recognized and excluded', () => {
  // These are the exact shapes present in the production product_catalog table.
  assert(isTestCatalogRow({ source: 'TEST', brand: 'KSCAN_TEST', retailer: 'K Scan Demo Catalog' }));
  assert(isTestCatalogRow({ retailer: 'TEST_RETAILER_A', brand: 'Test Brand A' }));
  assert(isTestCatalogRow({ external_product_id: 'kscan-test-blue-denim-jacket' }));
  assert(isTestCatalogRow({ external_product_id: 'test-blazer-1' }));
  assert(!isTestCatalogRow({ source: 'manual', brand: 'Nike', retailer: 'Farfetch' }));
});

Deno.test('a real catalog row normalizes with its declared identity', () => {
  const row = normalizeCatalogRow({
    id: 'uuid-1',
    retailer: 'Farfetch',
    brand: 'Acne Studios',
    product_name: 'Acne Studios wool coat',
    canonical_category: 'outerwear',
    color_normalized: 'grey',
    external_product_id: 'ACNE-COAT-1',
    product_url: 'https://farfetch.com/item/acne-coat',
    source: 'manual',
  });
  assert(row !== null);
  assertEquals(row.family.brand, 'acne-studios');
  assertEquals(row.variant.colorway, 'grey');
  assertEquals(row.variant.exactProductId, 'ACNE-COAT-1');
});

// ── dedupe ──────────────────────────────────────────────────────────────────

function serper(id: string, title: string, url: string): NormalizedRow {
  const row = normalizeRecommendedProduct({ id, title, productUrl: url }, 'serper', {
    brand: 'Nike',
    canonicalCategory: 'footwear',
    color: 'white',
  });
  if (!row) throw new Error('fixture failed to normalize');
  return row;
}

Deno.test('rule 1: identical canonical URLs from two sources collapse to one listing', () => {
  const a = serper('1', 'Nike Air Force 1 07', 'https://www.nike.com/t/af1?utm_source=a');
  const b = normalizeRetailerProduct(
    { id: 'ff-1', title: 'Nike Air Force 1 07', retailer: 'Farfetch', productUrl: 'https://nike.com/t/af1' },
    'farfetch',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
  );
  assert(b !== null);
  const result = dedupeRows([a, b]);
  assertEquals(result.stats.listingsMergedByUrl, 1);
  assertEquals(result.stats.listingsOut, 1);
  // The first-party retailer wins the merge.
  assertEquals(result.variants[0].listings[0].source, 'farfetch');
});

Deno.test('rule 2: a shared exact identifier merges variants across colour spellings', () => {
  const a = normalizeRetailerProduct(
    { id: 'SKU-1', title: 'Nike Air Force 1 07', retailer: 'Farfetch', productUrl: 'https://farfetch.com/a' },
    'farfetch',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'triple white' },
  );
  const b = normalizeRetailerProduct(
    { id: 'SKU-1', title: 'Nike Air Force 1 07', retailer: 'KicksCrew', productUrl: 'https://kickscrew.com/b' },
    'kickscrew',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'off white' },
  );
  assert(a !== null && b !== null);
  const result = dedupeRows([a, b]);
  assertEquals(result.stats.variantsOut, 1);
  assertEquals(result.stats.listingsOut, 2, 'both listings are kept — a second retailer is information');
  assertEquals(result.stats.variantsWithCrossSourceAgreement, 1);
  assertEquals(
    result.variants[0].exactIdSources,
    ['farfetch', 'kickscrew'],
    'both id-bearing sources are recorded, which is what opens the EXACT gate',
  );
});

Deno.test('a search-only source never lands in exactIdSources', () => {
  const retailer = normalizeRetailerProduct(
    { id: 'SKU-9', title: 'Nike Air Force 1 07', retailer: 'Farfetch', productUrl: 'https://farfetch.com/a' },
    'farfetch',
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
  );
  const search = serper('9', 'Nike Air Force 1 07', 'https://nike.com/9');
  assert(retailer !== null);
  const result = dedupeRows([retailer, search]);
  const withId = result.variants.find((variant) => variant.exactProductId !== null);
  assert(withId !== undefined);
  assertEquals(withId.exactIdSources, ['farfetch']);
});

Deno.test('rule 3: same family and same colourway merges; different families never do', () => {
  const nikeA = serper('1', 'Nike Air Force 1 07', 'https://a.com/1');
  const nikeB = serper('2', 'Nike Air Force 1 07', 'https://b.com/2');
  const merged = dedupeRows([nikeA, nikeB]);
  assertEquals(merged.stats.variantsOut, 1);
  assertEquals(merged.stats.variantsMergedByColorway, 1);

  const other = normalizeRecommendedProduct(
    { id: '3', title: 'Adidas Samba OG', productUrl: 'https://c.com/3' },
    'serper',
    { brand: 'Adidas', canonicalCategory: 'footwear', color: 'white' },
  );
  assert(other !== null);
  const separate = dedupeRows([nikeA, other]);
  assertEquals(separate.stats.variantsOut, 2, 'different brands must never merge');
});

Deno.test('an unknown colourway is not agreement and does not merge', () => {
  const a = normalizeRecommendedProduct(
    { id: '1', title: 'Nike Air Force 1 07', productUrl: 'https://a.com/1' },
    'serper',
    { brand: 'Nike', canonicalCategory: 'footwear' },
  );
  const b = normalizeRecommendedProduct(
    { id: '2', title: 'Nike Air Force 1 07', productUrl: 'https://b.com/2' },
    'serper',
    { brand: 'Nike', canonicalCategory: 'footwear' },
  );
  assert(a !== null && b !== null);
  const result = dedupeRows([a, b]);
  assertEquals(result.variants.length, 1, 'identical unknown-colour variant keys still group');
  assertEquals(result.stats.variantsMergedByColorway, 0, 'but not via the colourway rule');
});

Deno.test('dedupe is order-insensitive', () => {
  const rows = [
    serper('1', 'Nike Air Force 1 07', 'https://a.com/1'),
    serper('2', 'Nike Air Max 90', 'https://b.com/2'),
    serper('3', 'Nike Air Force 1 07', 'https://c.com/3'),
  ];
  const forward = dedupeRows(rows);
  const reversed = dedupeRows([...rows].reverse());
  assertEquals(
    forward.variants.map((v) => v.variantKey),
    reversed.variants.map((v) => v.variantKey),
  );
  assertEquals(forward.stats.variantsOut, reversed.stats.variantsOut);
});
