// scanCommerceRouter.ts — Camera-scan live commerce fallback for image mode.
//
// Phase 2B scope:
//   - KicksCrew specialized provider for sneaker/footwear scans (when enabled)
//   - Farfetch specialized provider for non-sneaker fashion scans (when enabled)
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
import {
  searchKicksCrewProducts,
  type KicksCrewProduct,
} from './kicksCrewProvider.ts';
import { isQualityTuneEnabled, QUALITY_TUNE_MIN_VALID_PRODUCTS } from './qualityTuneConfig.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
  shouldRunFallbackQuery,
  type CommerceRelevanceOptions,
} from './qualityTuneCommerce.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';

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
};

export type ScanCommerceProvider = 'kickscrew' | 'farfetch' | 'serper' | 'brave' | 'none';

export type ScanCommerceResult = {
  products: RecommendedProduct[];
  provider: ScanCommerceProvider;
  providersTried: string[];
  query: string;
  count: number;
  errorType?: string;
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
const SUFFICIENT_THRESHOLD = 3;
const MAX_RESULTS = 10;

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
  p: FarfetchProduct | KicksCrewProduct,
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

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Get live commerce results for a camera scan.
 *
 * Phase 2B routing:
 *   For sneaker/footwear scans:
 *     1. KicksCrew when enabled and a RapidAPI key is available.
 *        - 3+ valid products: use KicksCrew, skip Farfetch/Serper/Brave.
 *        - 1-2 valid products: keep KicksCrew and try Farfetch.
 *          - combined 3+ : skip Serper/Brave.
 *          - combined <3 : fall back to Serper/Brave.
 *        - 0 valid products or failure: fall back to Farfetch → Serper/Brave.
 *   For non-sneaker fashion scans:
 *     1. Farfetch when enabled and a RapidAPI key is available.
 *        - 3+ valid products: use Farfetch, skip Serper/Brave.
 *        - 1-2 valid products: keep Farfetch and fall back to Serper/Brave.
 *        - 0 valid products or failure: fall back to Serper/Brave.
 *
 * Provider failures are caught and surfaced only as safe diagnostics; the scan
 * itself never fails because of commerce.
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
  const identityEnabled = input.commerceIdentityEnabled === true;
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
      });
      query = weighted.primary;
      fallbackQuery = weighted.fallback;
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
    };
  }

  const limit = Math.max(1, Math.min(10, input.limit ?? 8));
  const isSneaker = isSneakerIdentification(
    input.identification,
    input.attributes,
    input.searchQueries,
    input.originalText,
  );

  // ── 1. Sneaker path: try KicksCrew first ────────────────────────────────────
  let kicksProducts: RecommendedProduct[] = [];
  let kicksErrorType: string | undefined;

  if (isSneaker) {
    try {
      const kicks = await searchKicksCrewProducts(query, { limit });
      if (kicks.errorType !== 'disabled' && kicks.errorType !== 'no_key') {
        providersTried.push('kickscrew');
      }
      kicksProducts = kicks.products.map((p) => normalizeToRecommendedProduct(p, identityEnabled));
      kicksErrorType = kicks.errorType;
    } catch (err) {
      providersTried.push('kickscrew');
      kicksErrorType = err instanceof Error ? err.name : 'unknown';
    }

    // 1a. KicksCrew has enough products → skip Farfetch/Serper/Brave entirely.
    if (kicksProducts.length >= SUFFICIENT_THRESHOLD) {
      let products = dedupeProductsByUrl(kicksProducts).slice(0, MAX_RESULTS);
      let qualityTuneMeta: ScanCommerceResult['qualityTune'];
      if (qualityEnabled) {
        const filtered = filterAndDedupeProducts(
          products,
          input.identification || {},
          relevanceOpts,
        );
        products = filtered.products.slice(0, MAX_RESULTS);
        qualityTuneMeta = {
          fallbackUsed: false,
          productsBeforeDedupe: filtered.stats.productsBeforeDedupe,
          productsAfterDedupe: filtered.stats.productsAfterDedupe,
          categoryMismatchRemovals: filtered.stats.categoryMismatchRemovals,
          identityKeyTypesUsed: filtered.stats.identityKeyTypesUsed,
          productsBeforeFilter: filtered.stats.productsBeforeFilter,
          retailerCount: filtered.stats.retailerCount,
        };
        // If quality filtering drops below threshold, continue provider cascade.
        if (
          shouldRunFallbackQuery(products.length, QUALITY_TUNE_MIN_VALID_PRODUCTS) &&
          !input.disableQualityFallback
        ) {
          // keep kicksProducts; do not early-return
        } else {
          logCommerce('kickscrew', Date.now() - started, products.length, 0, kicksErrorType);
          return {
            products,
            provider: 'kickscrew',
            providersTried,
            query,
            count: products.length,
            errorType: kicksErrorType,
            ...(qualityTuneMeta ? { qualityTune: qualityTuneMeta } : {}),
          };
        }
      } else {
        logCommerce('kickscrew', Date.now() - started, products.length, 0, kicksErrorType);
        return {
          products,
          provider: 'kickscrew',
          providersTried,
          query,
          count: products.length,
          errorType: kicksErrorType,
        };
      }
    }
  }

  // ── 2. Try Farfetch (first for non-sneaker, supplement for sneaker) ────────
  let farfetchProducts: RecommendedProduct[] = [];
  let farfetchErrorType: string | undefined;
  try {
    const farfetch = await searchFarfetchProducts(query, { limit });
    // Only record that we tried Farfetch if it was actually enabled/configured.
    if (farfetch.errorType !== 'disabled' && farfetch.errorType !== 'no_key') {
      providersTried.push('farfetch');
    }
    farfetchProducts = farfetch.products.map((p) => normalizeToRecommendedProduct(p, identityEnabled));
    farfetchErrorType = farfetch.errorType;
  } catch (err) {
    providersTried.push('farfetch');
    farfetchErrorType = err instanceof Error ? err.name : 'unknown';
  }

  // Merge KicksCrew first, then Farfetch, deduping by normalized URL.
  const kicksFarfetchMerged = dedupeProductsByUrl([...kicksProducts, ...farfetchProducts]);

  // 2a. Combined KicksCrew + Farfetch is enough → skip Serper/Brave.
  if (kicksFarfetchMerged.length >= SUFFICIENT_THRESHOLD) {
    let products = kicksFarfetchMerged.slice(0, MAX_RESULTS);
    let provider: ScanCommerceProvider = kicksProducts.length > 0 ? 'kickscrew' : 'farfetch';
    let qualityTuneMeta: ScanCommerceResult['qualityTune'];
    let allowEarlyReturn = true;
    if (qualityEnabled) {
      const filtered = filterAndDedupeProducts(
        products,
        input.identification || {},
        relevanceOpts,
      );
      products = filtered.products.slice(0, MAX_RESULTS);
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
        shouldRunFallbackQuery(products.length, QUALITY_TUNE_MIN_VALID_PRODUCTS) &&
        !input.disableQualityFallback
      ) {
        allowEarlyReturn = false;
      }
    }
    if (allowEarlyReturn) {
      logCommerce(provider, Date.now() - started, products.length, 0, kicksErrorType ?? farfetchErrorType);
      return {
        products,
        provider,
        providersTried,
        query,
        count: products.length,
        errorType: kicksErrorType ?? farfetchErrorType,
        ...(qualityTuneMeta ? { qualityTune: qualityTuneMeta } : {}),
      };
    }
  }

  // ── 3. Serper/Brave fallback ───────────────────────────────────────────────
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

  // Merge live providers in priority order, then dedupe.
  let merged = dedupeProductsByUrl([...kicksFarfetchMerged, ...serperBraveProducts]).slice(0, MAX_RESULTS);
  let provider: ScanCommerceProvider = merged.length > 0
    ? (kicksProducts.length > 0 ? 'kickscrew' : farfetchProducts.length > 0 ? 'farfetch' : serperBraveProvider)
    : 'none';

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

  logCommerce(provider, Date.now() - started, merged.length, 0, kicksErrorType ?? farfetchErrorType ?? serperBraveErrorType);

  return {
    products: merged,
    provider,
    providersTried,
    query,
    count: merged.length,
    errorType: merged.length > 0 ? undefined : (kicksErrorType ?? farfetchErrorType ?? serperBraveErrorType ?? 'no_results'),
    ...(qualityTuneMeta ? { qualityTune: qualityTuneMeta } : {}),
  };
}
