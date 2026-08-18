// scanCommerceRouter.ts — Camera-scan live commerce fallback for image mode.
//
// Phase 3 scope (provider modernization + expansion):
//   Discovery (retailer-neutral, run in bounded parallel):
//     - Serper Shopping / Brave Web Search fallback (unchanged)
//     - Poshmark resale search (new)
//   Enrichment (URL-driven only — neither API offers keyword search; proven
//   live during Phase 3 contract discovery, see farfetch3Provider.ts and
//   kicksCrewProvider.ts headers):
//     - Farfetch3, for any discovered farfetch.com product URL
//     - KicksCrew, for any discovered kickscrew.com product URL, sneaker
//       scans only (unchanged routing gate)
//   v124 identity-aware ranking and v125 query-intelligence are untouched by
//   this phase — only provider orchestration changed, because the old
//   sequential "KicksCrew/Farfetch keyword search first" cascade cannot work
//   against URL-driven-only provider contracts.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

import {
  getShoppingResults,
  normalizeUrl as normalizeShoppingUrl,
  type RecommendedProduct,
} from './shoppingProvider.ts';
import {
  enrichFarfetchProductByUrl,
  isFarfetchProductUrl,
  type Farfetch3Product,
} from './farfetch3Provider.ts';
import {
  enrichKicksCrewProductByUrl,
  isKicksCrewProductUrl,
  type KicksCrewProduct,
} from './kicksCrewProvider.ts';
import { searchPoshmarkProducts, type PoshmarkProduct } from './poshmarkProvider.ts';
import { isQualityTuneEnabled, QUALITY_TUNE_MIN_VALID_PRODUCTS } from './qualityTuneConfig.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
  shouldRunFallbackQuery,
  type CommerceRelevanceOptions,
} from './qualityTuneCommerce.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import type { CommerceQueryStrategy } from './commerceRetrievalConfig.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ScanCommerceInput = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  searchQueries?: string[];
  originalText?: string;
  mode: 'image' | 'text';
  limit?: number;
  /** Internal: prevent recursive quality-tune fallback loops. */
  disableQualityFallback?: boolean;
  /** v121 intelligence — omit for exact v120 commerce query construction */
  qualityDetailLevel?: 'specific' | 'moderate' | 'broad';
  materialAllowed?: boolean;
  brandAllowed?: boolean;
  /** v122 commerce relevance — omit for exact v121 behavior */
  relevanceEnabled?: boolean;
  relevanceRoute?: ScannerCategoryRoute;
  qualityBand?: 'high' | 'moderate' | 'low' | null;
  /**
   * v123 TextScan parity: when true, mode=text is accepted by this router.
   * Callers must gate with BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED.
   * Image mode is unchanged regardless of this flag.
   */
  allowTextMode?: boolean;
  /**
   * v124 commerce identity — omit for exact repaired-v123 behavior.
   *
   * `commerceIdentityEnabled` governs provider brand normalization;
   * `commerceIdentity` carries the graded evidence used by the ranker.
   * Neither affects query construction, provider order, or provider count.
   */
  commerceIdentityEnabled?: boolean;
  commerceIdentity?: CommerceIdentityEvidence;
  /**
   * v125 commerce retrieval enrichment — omit for exact v124 query
   * construction. Independent of `commerceIdentityEnabled` so that
   * `v124 ON + v125 OFF` remains a valid, independently rollback-able state.
   * Changes query content only: provider set, order, timeouts, concurrency,
   * early-exit threshold, and fallback conditions are all untouched.
   */
  commerceRetrievalEnabled?: boolean;
};

export type ScanCommerceProvider = 'kickscrew' | 'farfetch' | 'poshmark' | 'serper' | 'brave' | 'none';

export type ScanCommerceResult = {
  products: RecommendedProduct[];
  provider: ScanCommerceProvider;
  providersTried: string[];
  query: string;
  count: number;
  errorType?: string;
  /**
   * v125 query-strategy classification. Bounded enum, diagnostics only — never
   * required by clients and never carries the query string itself.
   */
  queryStrategy?: CommerceQueryStrategy;
  /** Quality-tune diagnostics (never required by clients). */
  qualityTune?: {
    fallbackUsed: boolean;
    productsBeforeDedupe: number;
    productsAfterDedupe: number;
    categoryMismatchRemovals: number;
    identityKeyTypesUsed: string[];
    productsBeforeFilter?: number;
    retailerCount?: number;
  };
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
const MAX_RESULTS = 10;

// ── Phase 3: discovery/enrichment orchestration bounds ─────────────────────
//
// One explicit outer deadline for the whole discovery fan-out, matching the
// existing shoppingProvider.ts per-provider timeout (4.5s) rather than
// inventing a new budget. Providers that do not answer in time are dropped
// (partial-result salvage), never awaited past the deadline.
const GLOBAL_DISCOVERY_DEADLINE_MS = 4_500;
// Enrichment is a second network hop per candidate — bounded intentionally so
// a large discovery pool cannot fan out into an unbounded number of extra
// requests. Enrichment only runs for candidates that already resolved to the
// matching retailer's domain.
const MAX_FARFETCH_ENRICH = 2;
const MAX_KICKSCREW_ENRICH = 2;

const SNEAKER_KEYWORDS = new Set([
  'sneaker',
  'sneakers',
  'trainer',
  'trainers',
  'running shoe',
  'running shoes',
  'basketball shoe',
  'basketball shoes',
  'tennis shoe',
  'tennis shoes',
  'skate shoe',
  'skate shoes',
  'athletic shoe',
  'athletic shoes',
  'high-top',
  'high top',
  'low-top',
  'low top',
  'mid-top',
  'mid top',
  'retro sneaker',
  'retro sneakers',
]);

const SNEAKER_BRANDS = [
  'nike',
  'jordan',
  'air jordan',
  'adidas',
  'yeezy',
  'new balance',
  'asics',
  'puma',
  'converse',
  'reebok',
  'vans',
  'saucony',
  'on running',
  'hoka',
  'hoka one one',
  'salomon',
  'brooks',
];

const SNEAKER_MODELS = [
  'air force',
  'air force 1',
  'af1',
  'dunk',
  'dunk low',
  'dunk high',
  'air max',
  'jordan 1',
  'jordan 3',
  'jordan 4',
  'jordan 11',
  'aj1',
  'aj3',
  'aj4',
  'aj11',
  'samba',
  'gazelle',
  'campus',
  'forum',
  'superstar',
  'ultraboost',
  'yeezy 350',
  'yeezy 500',
  'yeezy 700',
  'yeezy slide',
  '990',
  '991',
  '992',
  '993',
  '327',
  '550',
  '574',
  'gel-kayano',
  'gel kayano',
  'gel-lyte',
  'gel lyte',
  'gt-2160',
  'gt 2160',
  'chuck taylor',
  'chuck 70',
  'one star',
  'old skool',
  'sk8-hi',
  'sk8 hi',
  'authentic',
  'eras',
  'club c',
  'classic leather',
  'question mid',
  'kamikaze',
  'hurricane',
  'shadow 6000',
  'xt-6',
  'xt 6',
  'speedcross',
  'ghost',
  'glycerin'
];

const NON_SNEAKER_FOOTWEAR = new Set([
  'boot',
  'boots',
  'ankle boot',
  'ankle boots',
  'chelsea boot',
  'chelsea boots',
  'hiking boot',
  'hiking boots',
  'sandal',
  'sandals',
  'slide',
  'slides',
  'flip-flop',
  'flip-flops',
  'flip flop',
  'flip flops',
  'dress shoe',
  'dress shoes',
  'oxford',
  'oxfords',
  'loafer',
  'loafers',
  'heel',
  'heels',
  'pump',
  'pumps',
  'ballet flat',
  'ballet flats',
  'slipper',
  'slippers',
  'moccasin',
  'moccasins',
  'wedge',
  'wedges',
  'espadrille',
  'espadrilles',
]);

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

/**
 * Determine whether the scanned item is likely a sneaker/streetwear footwear
 * item that should route to KicksCrew first.
 *
 * Rules:
 *   - Explicit non-sneaker footwear categories block KicksCrew unless a strong
 *     sneaker model signal is also present.
 *   - Sneaker-specific keywords or models trigger KicksCrew.
 *   - A sneaker brand paired with a footwear/sneaker context triggers KicksCrew.
 *   - The word "shoe" alone is not enough; it needs a sneaker keyword, model,
 *     or sneaker brand.
 */
export function isSneakerIdentification(
  identification: Record<string, unknown> | undefined,
  attributes: Record<string, unknown> | undefined,
  searchQueries?: string[],
  originalText?: string,
): boolean {
  if (!identification) identification = {};
  if (!attributes) attributes = {};

  const corpusParts: string[] = [];
  corpusParts.push(str(identification.item_type));
  corpusParts.push(str(identification.itemType));
  corpusParts.push(str(identification.category));
  corpusParts.push(str(attributes.category));
  corpusParts.push(str(identification.subtype));
  corpusParts.push(str(identification.brand_guess));
  corpusParts.push(str(identification.brand));
  corpusParts.push(str(attributes.brand));
  corpusParts.push(str(identification.visible_brand_text));
  corpusParts.push(str(identification.material_estimate));
  corpusParts.push(str(attributes.material));
  corpusParts.push(str(identification.silhouette));
  corpusParts.push(str(attributes.style));
  corpusParts.push(str(originalText));

  if (Array.isArray(identification.style_tags)) {
    for (const t of identification.style_tags as unknown[]) {
      corpusParts.push(str(t));
    }
  }
  if (Array.isArray(attributes.styleTags)) {
    for (const t of attributes.styleTags as unknown[]) {
      corpusParts.push(str(t));
    }
  }

  const queryList = Array.isArray(searchQueries)
    ? searchQueries
    : Array.isArray(identification.search_queries)
    ? (identification.search_queries as unknown[])
    : [];
  for (const q of queryList) corpusParts.push(str(q));

  const corpus = collapseSpaces(corpusParts.join(' ')).toLowerCase();
  if (!corpus) return false;

  const hasSneakerKeyword = Array.from(SNEAKER_KEYWORDS).some((kw) => corpus.includes(kw));
  const hasSneakerModel = SNEAKER_MODELS.some((m) => corpus.includes(m));
  const hasSneakerBrand = SNEAKER_BRANDS.some((b) => corpus.includes(b));

  const explicitNonSneaker = Array.from(NON_SNEAKER_FOOTWEAR).some((cat) => corpus.includes(cat));

  // Strong model signal overrides an otherwise non-sneaker footwear word.
  if (explicitNonSneaker && !hasSneakerModel && !hasSneakerKeyword) return false;

  if (hasSneakerKeyword) return true;
  if (hasSneakerModel) return true;

  // "shoe" alone is not enough; require a sneaker brand plus a footwear word.
  if (hasSneakerBrand && (corpus.includes('sneaker') || corpus.includes('shoe') || corpus.includes('trainer'))) {
    return true;
  }

  // Brand + model already handled above via hasSneakerModel; brand + a generic
  // footwear word without sneaker context is not sufficient.
  return false;
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

function normalizeToRecommendedProduct(
  p: Farfetch3Product | KicksCrewProduct | PoshmarkProduct,
  includeBrand = false,
): RecommendedProduct {
  return {
    id: p.id,
    title: p.title,
    source: p.source,
    price: p.price,
    type: p.type,
    imageUrl: p.imageUrl,
    productUrl: p.productUrl,
    commerceType: p.commerceType,
    // v124: provider brand was previously discarded at this boundary.
    ...(includeBrand && p.brand ? { brand: p.brand } : {}),
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

// ── Phase 3: bounded parallel discovery + URL-driven enrichment ────────────

/**
 * Races a promise against a shared deadline instead of rejecting on timeout,
 * so a slow discovery provider degrades to "no result" rather than failing
 * the whole fan-out — partial-result salvage, not an error path.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/**
 * Enrich the bounded subset of a candidate pool whose productUrl already
 * resolves to the given retailer's domain. Returns the pool with matching
 * entries replaced by their enriched version when enrichment succeeds;
 * candidates that fail enrichment (or were never attempted, past the bound)
 * are left exactly as discovered — enrichment can only improve a candidate,
 * never remove one.
 */
async function enrichDiscoveredUrls(
  pool: RecommendedProduct[],
  opts: {
    matchesDomain: (url: string | undefined) => boolean;
    enrich: (url: string) => Promise<{ product: { productUrl: string } & Partial<RecommendedProduct> | null }>;
    cap: number;
    includeBrand: boolean;
  },
): Promise<RecommendedProduct[]> {
  const candidates = pool.filter((p) => opts.matchesDomain(p.productUrl)).slice(0, opts.cap);
  if (candidates.length === 0) return pool;

  const results = await Promise.allSettled(
    candidates.map((c) => opts.enrich(c.productUrl as string)),
  );

  const enrichedByUrl = new Map<string, RecommendedProduct>();
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value.product) continue;
    const p = result.value.product as unknown as Farfetch3Product | KicksCrewProduct;
    enrichedByUrl.set(p.productUrl.toLowerCase(), normalizeToRecommendedProduct(p, opts.includeBrand));
  }
  if (enrichedByUrl.size === 0) return pool;

  return pool.map((p) => {
    const key = (p.productUrl || '').toLowerCase();
    return enrichedByUrl.get(key) ?? p;
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Get live commerce results for a camera scan.
 *
 * Phase 3 routing:
 *   1. Serper/Brave (retailer-neutral) and Poshmark (resale) run in bounded
 *      parallel against one shared deadline. A straggler is dropped, not
 *      awaited — its results are simply absent, not an error.
 *   2. Any discovered farfetch.com product URL is enriched via Farfetch3
 *      (bounded count). Any discovered kickscrew.com product URL is enriched
 *      via KicksCrew (bounded count, sneaker scans only — unchanged gate).
 *      Neither provider can discover candidates from a query; both are
 *      URL-driven enrichment only (proven live, not assumed).
 *   3. The enriched pool feeds the unchanged v124/v125 quality-tune filter,
 *      dedupe, and brand-neutral fallback-query recursion.
 *
 * Provider failures are caught and surfaced only as safe diagnostics; the scan
 * itself never fails because of commerce. No provider identity ever carries a
 * ranking bonus — v124 stays the sole relevance authority.
 */
export async function getScanCommerceResults(
  input: ScanCommerceInput,
): Promise<ScanCommerceResult> {
  const started = Date.now();
  const providersTried: string[] = [];

  if (input.mode !== 'image' && !(input.mode === 'text' && input.allowTextMode === true)) {
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

  const qualityEnabled = isQualityTuneEnabled();
  let fallbackQuery = '';
  let query = '';
  let queryStrategy: CommerceQueryStrategy | undefined;
  const identityEnabled = input.commerceIdentityEnabled === true;
  const retrievalEnabled = input.commerceRetrievalEnabled === true;
  const relevanceOpts: CommerceRelevanceOptions | undefined =
    input.relevanceEnabled && input.relevanceRoute
      ? {
        enabled: true,
        categoryRoute: input.relevanceRoute,
        qualityBand: input.qualityBand,
        ...(identityEnabled && input.commerceIdentity
          ? { commerceIdentity: input.commerceIdentity }
          : {}),
      }
      : undefined;

  if (qualityEnabled) {
    if (input.disableQualityFallback) {
      // Forced single fallback attempt — use provided query only.
      const forced = Array.isArray(input.searchQueries) && typeof input.searchQueries[0] === 'string'
        ? input.searchQueries[0].trim()
        : '';
      query = forced || buildScanCommerceQuery(input);
    } else {
      const weighted = buildWeightedCommerceQueries({
        identification: input.identification,
        attributes: input.attributes,
        searchQueries: input.searchQueries,
        originalText: input.originalText,
        ...(input.qualityDetailLevel
          ? {
            detailLevel: input.qualityDetailLevel,
            materialAllowed: input.materialAllowed,
            brandAllowed: input.brandAllowed,
          }
          : {}),
        ...(relevanceOpts
          ? {
            relevanceRoute: relevanceOpts.categoryRoute,
            qualityBand: relevanceOpts.qualityBand,
            materialAllowed: input.materialAllowed,
            brandAllowed: input.brandAllowed,
            detailLevel: input.qualityDetailLevel,
          }
          : {}),
        ...(retrievalEnabled && input.commerceIdentity
          ? { commerceIdentity: input.commerceIdentity }
          : {}),
      });
      query = weighted.primary;
      fallbackQuery = weighted.fallback;
      queryStrategy = weighted.strategy;
    }
  } else {
    query = buildScanCommerceQuery(input);
  }

  if (!query || isWeakQuery(query)) {
    return {
      products: [],
      provider: 'none',
      providersTried,
      query,
      count: 0,
      errorType: 'weak_query',
      ...(queryStrategy ? { queryStrategy } : {}),
    };
  }

  const limit = Math.max(1, Math.min(10, input.limit ?? 8));
  const isSneaker = isSneakerIdentification(
    input.identification,
    input.attributes,
    input.searchQueries,
    input.originalText,
  );

  // ── 1. Bounded parallel discovery: Serper/Brave + Poshmark ──────────────────
  //
  // Neither Farfetch3 nor KicksCrew offers keyword search (proven live — see
  // their provider files), so discovery is retailer-neutral text search only.
  // Both discovery calls race the same deadline; a straggler is dropped, not
  // awaited — partial-result salvage, not a hard failure.
  providersTried.push('serper');
  const poshmarkAttempted = { tried: false };
  const [shoppingSettled, poshmarkSettled] = await Promise.all([
    withDeadline(
      getShoppingResults({ query, limit }),
      GLOBAL_DISCOVERY_DEADLINE_MS,
      { products: [], provider: 'none' as const, query, errorType: 'timeout' },
    ),
    withDeadline(
      (async () => {
        poshmarkAttempted.tried = true;
        return searchPoshmarkProducts(query, { limit });
      })(),
      GLOBAL_DISCOVERY_DEADLINE_MS,
      { products: [], provider: 'poshmark' as const, query, errorType: 'timeout' },
    ),
  ]);

  const shoppingProvider: ScanCommerceProvider = shoppingSettled.provider === 'brave'
    ? 'brave'
    : shoppingSettled.provider === 'serper'
    ? 'serper'
    : 'none';
  if (shoppingProvider === 'brave') providersTried.push('brave');
  if (poshmarkAttempted.tried && poshmarkSettled.errorType !== 'disabled' && poshmarkSettled.errorType !== 'no_key') {
    providersTried.push('poshmark');
  }

  const poshmarkProducts = poshmarkSettled.products.map((p) =>
    normalizeToRecommendedProduct(p, identityEnabled)
  );

  // Priority order: retailer-neutral shopping results first, Poshmark resale
  // additive after — dedupe collapses any URL overlap.
  let pool = dedupeProductsByUrl([...shoppingSettled.products, ...poshmarkProducts]);

  // ── 2. URL-driven enrichment ─────────────────────────────────────────────
  //
  // Farfetch3 and KicksCrew cannot discover candidates from a query — they can
  // only enrich a product URL K Scan already has. Scan the discovered pool for
  // matching-domain URLs (bounded) and enrich in place; enrichment never
  // removes a candidate, it only strengthens one already present.
  const farfetchCandidateCount = pool.filter((p) => isFarfetchProductUrl(p.productUrl)).length;
  if (farfetchCandidateCount > 0) providersTried.push('farfetch');
  pool = await enrichDiscoveredUrls(pool, {
    matchesDomain: isFarfetchProductUrl,
    enrich: enrichFarfetchProductByUrl,
    cap: MAX_FARFETCH_ENRICH,
    includeBrand: identityEnabled,
  });

  // KicksCrew stays sneaker-gated, exactly as before Phase 3.
  if (isSneaker) {
    const kickscrewCandidateCount = pool.filter((p) => isKicksCrewProductUrl(p.productUrl)).length;
    if (kickscrewCandidateCount > 0) providersTried.push('kickscrew');
    pool = await enrichDiscoveredUrls(pool, {
      matchesDomain: isKicksCrewProductUrl,
      enrich: enrichKicksCrewProductByUrl,
      cap: MAX_KICKSCREW_ENRICH,
      includeBrand: identityEnabled,
    });
  }

  function labelProvider(p: RecommendedProduct): ScanCommerceProvider {
    if (p.source === 'KicksCrew') return 'kickscrew';
    if (p.source === 'Farfetch') return 'farfetch';
    if (p.source === 'Poshmark') return 'poshmark';
    return shoppingProvider;
  }

  const discoveryErrorType = shoppingSettled.errorType ?? poshmarkSettled.errorType;

  let merged = pool.slice(0, MAX_RESULTS);
  let provider: ScanCommerceProvider = merged.length > 0 ? labelProvider(merged[0]) : 'none';

  let qualityTuneMeta: ScanCommerceResult['qualityTune'];
  let fallbackUsed = false;

  if (qualityEnabled) {
    const filtered = filterAndDedupeProducts(
      merged,
      input.identification || {},
      relevanceOpts,
    );
    merged = filtered.products.slice(0, MAX_RESULTS);
    qualityTuneMeta = {
      fallbackUsed: false,
      productsBeforeDedupe: filtered.stats.productsBeforeDedupe,
      productsAfterDedupe: filtered.stats.productsAfterDedupe,
      categoryMismatchRemovals: filtered.stats.categoryMismatchRemovals,
      identityKeyTypesUsed: filtered.stats.identityKeyTypesUsed,
      productsBeforeFilter: filtered.stats.productsBeforeFilter,
      retailerCount: filtered.stats.retailerCount,
    };

    if (
      !input.disableQualityFallback &&
      fallbackQuery &&
      fallbackQuery !== query &&
      shouldRunFallbackQuery(merged.length, QUALITY_TUNE_MIN_VALID_PRODUCTS)
    ) {
      const fallbackResult = await getScanCommerceResults({
        ...input,
        searchQueries: [fallbackQuery],
        disableQualityFallback: true,
      });
      fallbackUsed = true;
      // Prefer fallback only when it improves valid coverage; otherwise keep primary.
      if (fallbackResult.products.length > merged.length) {
        merged = fallbackResult.products;
        provider = fallbackResult.provider;
        for (const p of fallbackResult.providersTried) {
          if (!providersTried.includes(p)) providersTried.push(p);
        }
        query = fallbackQuery;
      }
      qualityTuneMeta = {
        fallbackUsed: true,
        productsBeforeDedupe: fallbackResult.qualityTune?.productsBeforeDedupe ?? qualityTuneMeta.productsBeforeDedupe,
        productsAfterDedupe: merged.length,
        categoryMismatchRemovals:
          (qualityTuneMeta.categoryMismatchRemovals || 0) +
          (fallbackResult.qualityTune?.categoryMismatchRemovals || 0),
        identityKeyTypesUsed: [
          ...new Set([
            ...(qualityTuneMeta.identityKeyTypesUsed || []),
            ...(fallbackResult.qualityTune?.identityKeyTypesUsed || []),
          ]),
        ],
      };
    } else if (qualityTuneMeta) {
      qualityTuneMeta.fallbackUsed = fallbackUsed;
    }

    provider = merged.length > 0 ? provider : 'none';
  }

  logCommerce(provider, Date.now() - started, merged.length, 0, discoveryErrorType);

  return {
    products: merged,
    provider,
    providersTried,
    query,
    count: merged.length,
    errorType: merged.length > 0 ? undefined : (discoveryErrorType ?? 'no_results'),
    ...(queryStrategy ? { queryStrategy } : {}),
    ...(qualityTuneMeta ? { qualityTune: qualityTuneMeta } : {}),
  };
}
