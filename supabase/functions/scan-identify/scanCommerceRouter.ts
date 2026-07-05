// scanCommerceRouter.ts — Camera-scan live commerce fallback for image mode.
//
// Phase 2A scope:
//   - Farfetch specialized provider (when enabled)
//   - Serper Shopping fallback
//   - Brave Web Search fallback
//   - No other specialized providers yet
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

import {
  getShoppingResults,
  normalizeUrl as normalizeShoppingUrl,
  type RecommendedProduct,
} from './shoppingProvider.ts';
import {
  searchFarfetchProducts,
  type FarfetchProduct,
} from './farfetchProvider.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ScanCommerceInput = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  searchQueries?: string[];
  originalText?: string;
  mode: 'image' | 'text';
  limit?: number;
};

export type ScanCommerceProvider = 'farfetch' | 'serper' | 'brave' | 'none';

export type ScanCommerceResult = {
  products: RecommendedProduct[];
  provider: ScanCommerceProvider;
  providersTried: string[];
  query: string;
  count: number;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

// Generic words that weaken a query when they dominate and no concrete signal
// (brand, color, material, distinctive detail) is present.
const GENERIC_WORDS = new Set([
  'stylish',
  'cute',
  'nice',
  'fashion',
  'outfit',
  'clothes',
  'top',
  'bottom',
  'shirt',
  'pants',
  'dress',
  'shoes',
  'bag',
  'item',
  'thing',
  'look',
  'casual',
  'trendy',
  'modern',
  'chic',
  'elegant',
  'classic',
  'simple',
  'basic',
  'versatile',
  'comfortable',
  'pretty',
  'beautiful',
  'gorgeous',
  'lovely',
  'cool',
  'awesome',
  'amazing',
  'perfect',
  'ideal',
  'great',
  'good',
  'best',
  'popular',
  'new',
  'latest',
  'designer',
  'luxury',
  'premium',
  'high',
  'quality',
  'vintage',
  'retro',
  'contemporary',
]);

const FILLER_WORDS = new Set([
  'with', 'and', 'the', 'a', 'an', 'of', 'for', 'featuring', 'some', 'plus', 'in', 'to', 'on', 'at', 'by',
]);

const TRACKING_PARAMS = new Set([
  'ref',
  'source',
  'affiliate_id',
  'irclickid',
  'clickid',
  'campaign',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
]);

const MAX_QUERY_LEN = 200;
const FARFETCH_SUFFICIENT_THRESHOLD = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function usableField(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'unknown' || low === 'n/a' || low === 'none' || low === 'null') return '';
  return s;
}

export function isNonFashionIdentification(
  identification: Record<string, unknown> | undefined,
): boolean {
  if (!identification) return false;
  if (identification.non_fashion === true) return true;
  const itemType = str(identification.item_type).toLowerCase();
  if (itemType === 'non_fashion' || itemType === 'non-fashion') return true;
  return false;
}

/**
 * Normalize a product URL for deduplication.
 * Strips common tracking params including utm_*, ref, source, affiliate_id,
 * irclickid, clickid, and campaign in addition to the params handled by the
 * underlying shopping provider.
 */
export function normalizeProductUrl(url: unknown): string | undefined {
  const firstPass = normalizeShoppingUrl(url);
  if (!firstPass) return undefined;
  try {
    const parsed = new URL(firstPass);
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return firstPass;
  }
}

/**
 * Build a commerce-grade query from Gemini image output.
 *
 * Priority:
 *   1. searchQueries[0]
 *   2. brand_guess
 *   3. visible_brand_text
 *   4. brand (from attributes)
 *   5. item_type
 *   6. category (from attributes)
 *   7. subtype
 *   8. primary_color
 *   9. color (from attributes)
 *   10. material_estimate
 *   11. material (from attributes)
 *   12. silhouette
 *   13. style_tags
 */
export function buildScanCommerceQuery(input: ScanCommerceInput): string {
  const identification = input.identification || {};
  const attributes = input.attributes || {};

  const searchQueries = Array.isArray(input.searchQueries)
    ? input.searchQueries
    : Array.isArray(identification.search_queries)
    ? (identification.search_queries as unknown[])
    : [];
  const firstQuery = usableField(searchQueries[0]);
  if (firstQuery) return cleanQuery(firstQuery);

  const brand =
    usableField(identification.brand_guess) ||
    usableField(identification.visible_brand_text) ||
    usableField(attributes.brand);

  const category =
    usableField(identification.item_type) ||
    usableField(attributes.category) ||
    usableField(identification.subtype);

  const color =
    usableField(identification.primary_color) ||
    usableField(attributes.color) ||
    usableField((identification.secondary_colors as string[])?.[0]);

  const material =
    usableField(identification.material_estimate) || usableField(attributes.material);

  const silhouette = usableField(identification.silhouette);

  const styleTags = Array.isArray(identification.style_tags)
    ? (identification.style_tags as unknown[]).filter((x): x is string => typeof x === 'string').join(' ')
    : '';

  const structured = [brand, category, color, material, silhouette, styleTags]
    .filter(Boolean)
    .join(' ');
  if (structured.trim()) return cleanQuery(structured);

  const text = usableField(input.originalText);
  if (text) return cleanQuery(text);

  return '';
}

function cleanQuery(raw: string): string {
  const words = collapseSpaces(raw).split(' ');
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!lw) continue;
    if (FILLER_WORDS.has(lw)) continue;
    if (seen.has(lw)) continue;
    seen.add(lw);
    kept.push(w);
  }
  return kept.join(' ').slice(0, MAX_QUERY_LEN);
}

/**
 * Weak-query heuristic.
 * A query is too weak if it is empty, shorter than 3 characters, has fewer
 * than 3 meaningful words with no brand signal, or is mostly generic words.
 */
export function isWeakQuery(query: string): boolean {
  const cleaned = cleanQuery(query);
  if (!cleaned) return true;
  if (cleaned.length < 3) return true;

  const words = cleaned.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC_WORDS.has(w.toLowerCase()));

  if (meaningful.length < 3) {
    // A brand + category/color is enough to be meaningful even with <3 words.
    const hasBrand = words.some((w) => !GENERIC_WORDS.has(w.toLowerCase()));
    const hasCategorySignal = words.some((w) =>
      ['polo', 'blazer', 'handbag', 'sneakers', 'coat', 'dress', 'trench'].some((sig) =>
        w.toLowerCase().includes(sig)
      )
    );
    return !(hasBrand && hasCategorySignal);
  }

  const genericCount = words.length - meaningful.length;
  const mostlyGeneric = genericCount > 0 && genericCount / words.length > 0.5;
  if (!mostlyGeneric) return false;

  // Even if mostly generic, keep the query if there are enough concrete tokens.
  return meaningful.length < 4;
}

// ── Safe logging ─────────────────────────────────────────────────────────────

function logCommerce(
  provider: string,
  latencyMs: number,
  count: number,
  catalogCount: number,
  errorType?: string,
): void {
  console.log(
    '[CommerceRouter] provider=%s latencyMs=%d count=%d catalogCount=%d error=%s',
    provider,
    latencyMs,
    count,
    catalogCount,
    errorType ?? 'none',
  );
}

// ── Provider result merging ──────────────────────────────────────────────────

function normalizeToRecommendedProduct(p: FarfetchProduct): RecommendedProduct {
  return {
    id: p.id,
    title: p.title,
    source: p.source,
    price: p.price,
    type: p.type,
    imageUrl: p.imageUrl,
    productUrl: p.productUrl,
  };
}

function dedupeProductsByUrl(products: RecommendedProduct[]): RecommendedProduct[] {
  const out: RecommendedProduct[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const normalized = normalizeProductUrl(p.productUrl);
    if (normalized) {
      if (seen.has(normalized)) continue;
      seen.add(normalized);
    }
    out.push(p);
  }
  return out;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Get live commerce results for a camera scan.
 *
 * Phase 2A routing:
 *   1. Farfetch when enabled and a RapidAPI key is available.
 *      - 3+ valid products: use Farfetch, skip Serper/Brave.
 *      - 1-2 valid products: keep Farfetch and fall back to Serper/Brave.
 *      - 0 valid products or failure: fall back to Serper/Brave.
 *   2. Serper primary / Brave fallback.
 *
 * Provider failures are caught and surfaced only as safe diagnostics; the scan
 * itself never fails because of commerce.
 */
export async function getScanCommerceResults(
  input: ScanCommerceInput,
): Promise<ScanCommerceResult> {
  const started = Date.now();
  const providersTried: string[] = [];

  if (input.mode !== 'image') {
    return {
      products: [],
      provider: 'none',
      providersTried,
      query: '',
      count: 0,
      errorType: 'wrong_mode',
    };
  }

  if (isNonFashionIdentification(input.identification)) {
    return {
      products: [],
      provider: 'none',
      providersTried,
      query: '',
      count: 0,
      errorType: 'non_fashion',
    };
  }

  const query = buildScanCommerceQuery(input);

  if (!query || isWeakQuery(query)) {
    return {
      products: [],
      provider: 'none',
      providersTried,
      query,
      count: 0,
      errorType: 'weak_query',
    };
  }

  const limit = Math.max(1, Math.min(10, input.limit ?? 8));

  // ── 1. Try Farfetch first when enabled ─────────────────────────────────────
  let farfetchProducts: RecommendedProduct[] = [];
  let farfetchErrorType: string | undefined;
  try {
    const farfetch = await searchFarfetchProducts(query, { limit });
    // Only record that we tried Farfetch if it was actually enabled/configured.
    if (farfetch.errorType !== 'disabled' && farfetch.errorType !== 'no_key') {
      providersTried.push('farfetch');
    }
    farfetchProducts = farfetch.products.map(normalizeToRecommendedProduct);
    farfetchErrorType = farfetch.errorType;
  } catch (err) {
    providersTried.push('farfetch');
    farfetchErrorType = err instanceof Error ? err.name : 'unknown';
  }

  // 1a. Farfetch has enough products → skip Serper/Brave entirely.
  if (farfetchProducts.length >= FARFETCH_SUFFICIENT_THRESHOLD) {
    logCommerce('farfetch', Date.now() - started, farfetchProducts.length, 0, farfetchErrorType);
    return {
      products: dedupeProductsByUrl(farfetchProducts),
      provider: 'farfetch',
      providersTried,
      query,
      count: farfetchProducts.length,
      errorType: farfetchErrorType,
    };
  }

  // ── 2. Serper/Brave fallback ───────────────────────────────────────────────
  let serperBraveProducts: RecommendedProduct[] = [];
  let serperBraveProvider: ScanCommerceProvider = 'none';
  let serperBraveErrorType: string | undefined;

  try {
    providersTried.push('serper');
    const shopping = await getShoppingResults({ query, limit });
    serperBraveProducts = shopping.products;
    serperBraveProvider = shopping.provider === 'brave'
      ? 'brave'
      : shopping.provider === 'serper'
      ? 'serper'
      : 'none';
    if (serperBraveProvider === 'brave') providersTried.push('brave');
    serperBraveErrorType = shopping.errorType;
  } catch (err) {
    serperBraveErrorType = err instanceof Error ? err.name : 'unknown';
  }

  // Merge Farfetch first, then Serper/Brave, deduping by normalized URL.
  const merged = dedupeProductsByUrl([...farfetchProducts, ...serperBraveProducts]);
  const provider: ScanCommerceProvider = merged.length > 0
    ? (farfetchProducts.length > 0 ? 'farfetch' : serperBraveProvider)
    : 'none';

  logCommerce(provider, Date.now() - started, merged.length, 0, farfetchErrorType ?? serperBraveErrorType);

  return {
    products: merged,
    provider,
    providersTried,
    query,
    count: merged.length,
    errorType: merged.length > 0 ? undefined : (farfetchErrorType ?? serperBraveErrorType ?? 'no_results'),
  };
}
