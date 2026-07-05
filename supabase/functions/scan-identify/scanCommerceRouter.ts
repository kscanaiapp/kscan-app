// scanCommerceRouter.ts — Camera-scan live commerce fallback for image mode.
//
// Phase 1 scope:
//   - Serper Shopping primary
//   - Brave Web Search fallback
//   - No specialized provider routing yet (KicksCrew/Farfetch/ASOS/etc. out of scope)
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

import {
  getShoppingResults,
  normalizeUrl as normalizeShoppingUrl,
  type RecommendedProduct,
} from './shoppingProvider.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ScanCommerceInput = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  searchQueries?: string[];
  originalText?: string;
  mode: 'image' | 'text';
  limit?: number;
};

export type ScanCommerceResult = {
  products: RecommendedProduct[];
  provider: 'serper' | 'brave' | 'none';
  providersTried: string[];
  query: string;
  count: number;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const GENERIC_WORDS = new Set([
  'stylish',
  'casual',
  'outfit',
  'fashion',
  'trendy',
  'nice',
  'cute',
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
 * A query is too weak if it has fewer than 3 meaningful words, or if it is
 * mostly generic words and lacks a concrete fashion signal (category, brand,
 * color, material, silhouette, distinctive feature).
 */
export function isWeakQuery(query: string): boolean {
  const cleaned = cleanQuery(query);
  if (!cleaned) return true;

  const words = cleaned.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC_WORDS.has(w.toLowerCase()));

  if (meaningful.length < 3) return true;

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

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Get live commerce results for a camera scan.
 *
 * For Phase 1 this is a thin wrapper around getShoppingResults() so the
 * Serper/Brave implementation is not duplicated. Provider failures are caught
 * and surfaced only as safe diagnostics; the scan itself never fails because of
 * commerce.
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

  try {
    providersTried.push('serper');
    const result = await getShoppingResults({ query, limit: input.limit });
    const provider = result.provider === 'brave'
      ? 'brave'
      : result.provider === 'serper'
      ? 'serper'
      : 'none';
    if (provider === 'brave') providersTried.push('brave');

    logCommerce(provider, Date.now() - started, result.products.length, 0, result.errorType);

    return {
      products: result.products,
      provider,
      providersTried,
      query: result.query,
      count: result.products.length,
      errorType: result.errorType,
    };
  } catch (err) {
    const errorType = err instanceof Error ? err.name : 'unknown';
    logCommerce('none', Date.now() - started, 0, 0, errorType);
    return {
      products: [],
      provider: 'none',
      providersTried,
      query,
      count: 0,
      errorType: 'provider_exception',
    };
  }
}
