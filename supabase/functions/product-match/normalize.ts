/**
 * Product Match Foundation V1 — existing-provider normalization.
 *
 * Adapts the shapes the deployed `scan-identify` closure already produces into
 * the canonical family/variant/listing model. NO NEW PROVIDERS. Every input
 * type here corresponds to a source that is already reachable in production:
 *
 *   RecommendedProduct  → serper / brave  (shoppingProvider.ts)
 *   FarfetchProduct     → farfetch        (farfetchProvider.ts)
 *   KicksCrewProduct    → kickscrew       (kicksCrewProvider.ts)
 *   CatalogRow          → catalog         (_shared/catalogRetrieval.ts)
 *
 * The adapters are structural rather than nominal — they accept the field names
 * those modules emit without importing them. Importing `scan-identify` modules
 * from here would pull this function into the governed `scan-identify` bundle
 * closure and change its manifest hash, which is exactly the drift the edge
 * parity gate exists to catch. The duplication is deliberate and the cost is
 * one structural test per adapter, which `normalize.test.ts` pays.
 */

import type { ProductListing, ProductSource, ProductVariant, ProductFamily } from './contracts.ts';
import { sourceCanCarryExactId } from './contracts.ts';
import {
  canonicalizeProductUrl,
  contentTokens,
  familyKeyOf,
  hostOf,
  listingKeyOf,
  normalizeBrand,
  normalizeColor,
  normalizeModel,
  slugify,
  variantKeyOf,
} from './identity.ts';

/** One fully-resolved provider row, before dedupe. */
export type NormalizedRow = {
  family: ProductFamily;
  variant: ProductVariant;
  listing: ProductListing;
};

/** Structural shape of `shoppingProvider.RecommendedProduct`. */
export type RawRecommendedProduct = {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  price?: unknown;
  type?: unknown;
  imageUrl?: unknown;
  productUrl?: unknown;
};

/** Structural shape of `farfetchProvider.FarfetchProduct` / KicksCrew's twin. */
export type RawRetailerProduct = RawRecommendedProduct & {
  name?: unknown;
  retailer?: unknown;
  image_url?: unknown;
  product_url?: unknown;
  url?: unknown;
};

/** Structural shape of a `product_catalog` row. */
export type RawCatalogRow = {
  id?: unknown;
  retailer?: unknown;
  brand?: unknown;
  product_name?: unknown;
  canonical_category?: unknown;
  price?: unknown;
  currency?: unknown;
  product_url?: unknown;
  image_url?: unknown;
  availability?: unknown;
  color_normalized?: unknown;
  material_tags?: unknown;
  silhouette_tags?: unknown;
  style_tags?: unknown;
  pattern_tags?: unknown;
  external_product_id?: unknown;
  source?: unknown;
};

/** Hints the caller already knows, used to fill gaps a provider left blank. */
export type NormalizeHints = {
  brand?: string | null;
  canonicalCategory?: string | null;
  color?: string | null;
};

function str(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function priceString(value: unknown): string | null {
  if (typeof value === 'string') return str(value, 24);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Recovers a brand from a title when the provider did not label one.
 *
 * Only the hinted brand is accepted, and only when it actually appears in the
 * title. Guessing a brand from arbitrary leading tokens would manufacture
 * `brand` evidence out of nothing, and brand evidence is load-bearing for the
 * LIKELY_EXACT tier.
 */
function resolveBrand(explicit: unknown, title: string | null, hints: NormalizeHints): string | null {
  const direct = normalizeBrand(explicit);
  if (direct) return direct;
  const hinted = normalizeBrand(hints.brand);
  if (!hinted || !title) return null;
  const titleTokens = new Set(contentTokens(title));
  const hintedTokens = contentTokens(hints.brand ?? '');
  const present = hintedTokens.length > 0 && hintedTokens.every((token) => titleTokens.has(token));
  return present ? hinted : null;
}

function buildRow(input: {
  source: ProductSource;
  providerId: unknown;
  title: string | null;
  brand: string | null;
  canonicalCategory: string | null;
  colorway: string | null;
  exactProductId: string | null;
  retailer: string | null;
  /** Raw provider value; validated and canonicalized below, never trusted. */
  productUrl: unknown;
  imageUrl: string | null;
  price: string | null;
  currency: string | null;
  availability: string | null;
  sizeHint: string | null;
}): NormalizedRow | null {
  const title = input.title;
  if (!title) return null;

  const productUrl = canonicalizeProductUrl(input.productUrl);
  const model = normalizeModel(title, input.brand);
  const family: ProductFamily = {
    familyKey: familyKeyOf({
      brand: input.brand,
      model,
      canonicalCategory: input.canonicalCategory,
    }),
    brand: input.brand,
    model,
    canonicalCategory: slugify(input.canonicalCategory) || null,
    displayName: title,
  };

  // An exact identifier is only honoured from a source structurally capable of
  // carrying one. A Serper result id is a position, not a SKU.
  const exactProductId = sourceCanCarryExactId(input.source) ? input.exactProductId : null;

  const variant: ProductVariant = {
    variantKey: variantKeyOf({
      familyKey: family.familyKey,
      colorway: input.colorway,
      exactProductId,
    }),
    familyKey: family.familyKey,
    colorway: input.colorway,
    exactProductId,
    sizeHint: input.sizeHint,
  };

  const listing: ProductListing = {
    listingKey: listingKeyOf({
      productUrl,
      source: input.source,
      providerId: typeof input.providerId === 'string' ? input.providerId : null,
    }),
    variantKey: variant.variantKey,
    familyKey: family.familyKey,
    source: input.source,
    retailer: input.retailer ?? hostOf(productUrl),
    title,
    productUrl,
    imageUrl: input.imageUrl,
    price: input.price,
    currency: input.currency,
    availability: input.availability,
  };

  return { family, variant, listing };
}

/** Serper / Brave results, as emitted by `shoppingProvider.ts`. */
export function normalizeRecommendedProduct(
  raw: RawRecommendedProduct,
  source: Extract<ProductSource, 'serper' | 'brave'>,
  hints: NormalizeHints = {},
): NormalizedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title);
  const brand = resolveBrand(null, title, hints);
  return buildRow({
    source,
    providerId: raw.id,
    title,
    brand,
    canonicalCategory: str(hints.canonicalCategory),
    // Web search results rarely state a colourway; the scanner's own reading is
    // the better signal and is applied only as a hint, never as agreement.
    colorway: normalizeColor(hints.color),
    exactProductId: null,
    retailer: str(raw.source, 60),
    productUrl: raw.productUrl,
    imageUrl: str(raw.imageUrl, 1024),
    price: priceString(raw.price),
    currency: null,
    availability: null,
    sizeHint: null,
  });
}

/** Farfetch / KicksCrew results — first-party retailer product pages. */
export function normalizeRetailerProduct(
  raw: RawRetailerProduct,
  source: Extract<ProductSource, 'farfetch' | 'kickscrew'>,
  hints: NormalizeHints = {},
): NormalizedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title) ?? str(raw.name);
  const brand = resolveBrand(null, title, hints);
  const url = raw.productUrl ?? raw.product_url ?? raw.url;
  return buildRow({
    source,
    providerId: raw.id,
    title,
    brand,
    canonicalCategory: str(hints.canonicalCategory),
    colorway: normalizeColor(hints.color),
    // These providers key their catalogue by `id`; that identifier is stable
    // and product-scoped, so it is admissible as an exact id.
    exactProductId: typeof raw.id === 'string' ? str(raw.id, 64) : null,
    retailer: str(raw.retailer, 60) ?? str(raw.source, 60),
    productUrl: url,
    imageUrl: str(raw.imageUrl, 1024) ?? str(raw.image_url, 1024),
    price: priceString(raw.price),
    currency: null,
    availability: null,
    sizeHint: null,
  });
}

/** Internal `product_catalog` rows. */
export function normalizeCatalogRow(
  raw: RawCatalogRow,
  hints: NormalizeHints = {},
): NormalizedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.product_name);
  const brand = normalizeBrand(raw.brand) ?? resolveBrand(null, title, hints);
  const firstTag = (value: unknown): string | null =>
    Array.isArray(value) && typeof value[0] === 'string' ? str(value[0], 60) : null;
  return buildRow({
    source: 'catalog',
    providerId: raw.id,
    title,
    brand,
    canonicalCategory: str(raw.canonical_category) ?? str(hints.canonicalCategory),
    colorway: normalizeColor(raw.color_normalized) ?? normalizeColor(hints.color),
    exactProductId: str(raw.external_product_id, 64),
    retailer: str(raw.retailer, 60),
    productUrl: raw.product_url,
    imageUrl: str(raw.image_url, 1024),
    price: priceString(raw.price),
    currency: str(raw.currency, 8),
    availability: str(raw.availability, 32),
    sizeHint: firstTag(raw.silhouette_tags),
  });
}

/**
 * Rejects catalog rows that are demonstration or test fixtures.
 *
 * This is not hypothetical hygiene. The production `product_catalog` table
 * currently holds 14 rows and every one of them is seeded test data
 * (`source = 'TEST'`, retailers `K Scan Demo Catalog` / `TEST_RETAILER_A` /
 * `TEST_RETAILER_B`, brand `KSCAN_TEST`), and the table is world-readable under
 * a `qual = true` SELECT policy. They have not surfaced to users only because
 * the similarity matcher's threshold happens to exclude them — an accident of
 * tuning, not a control. Anything reading that table must filter for itself.
 */
export function isTestCatalogRow(raw: RawCatalogRow): boolean {
  const source = typeof raw?.source === 'string' ? raw.source.trim().toUpperCase() : '';
  if (source === 'TEST' || source === 'DEMO' || source === 'FIXTURE') return true;

  const brand = typeof raw?.brand === 'string' ? raw.brand.toUpperCase() : '';
  if (brand.startsWith('KSCAN_TEST') || brand.startsWith('TEST ') || brand === 'TEST') return true;

  const retailer = typeof raw?.retailer === 'string' ? raw.retailer.toUpperCase() : '';
  if (retailer.startsWith('TEST_') || retailer.includes('DEMO CATALOG')) return true;

  const externalId = typeof raw?.external_product_id === 'string'
    ? raw.external_product_id.toLowerCase()
    : '';
  if (externalId.startsWith('test-') || externalId.startsWith('kscan-test-')) return true;

  return false;
}
