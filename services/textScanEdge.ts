import { supabase } from './supabaseClient';
import { validateTextScanQuery } from './textScan';
import type { TextScanProduct, TextScanProductType, TextScanResult } from './textScan';

const EDGE_FN = 'scan-identify';
// User-facing timeout budget. The edge function internally caps at ~8 s.
// 10 s gives a small buffer for cold-start overhead without hanging the UI.
const INVOKE_TIMEOUT_MS = 10_000;

const SAFE_FAILED_MESSAGE =
  "We couldn't analyze this request. Please try describing a garment, style, or outfit.";
const NON_FASHION_MESSAGE =
  "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit.";
const SIGN_IN_REQUIRED_MESSAGE = 'Please sign in to analyze fashion requests.';

function generateId(): string {
  return `textscan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type TextScanInvokeOptions = {
  source?: string;
};

function normalizeColor(
  colorPalette?: string[] | null,
  singleColor?: string | null,
): string | null {
  if (singleColor && typeof singleColor === 'string') return singleColor.trim() || null;
  if (Array.isArray(colorPalette) && colorPalette.length > 0) return colorPalette[0].trim() || null;
  return null;
}

function normalizeStyleDescriptors(
  styleTags?: string[] | null,
  styleDescriptors?: string | null,
): string[] {
  if (Array.isArray(styleTags)) return styleTags.filter((s) => typeof s === 'string' && s.trim());
  if (typeof styleDescriptors === 'string' && styleDescriptors.trim()) {
    return styleDescriptors.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeMaterial(
  materialEstimate?: string | null,
  material?: string | null,
): string | null {
  if (material && typeof material === 'string') return material.trim() || null;
  if (materialEstimate && typeof materialEstimate === 'string') return materialEstimate.trim() || null;
  return null;
}

function formatPrice(price: unknown, currency: unknown): string | undefined {
  if (typeof price !== 'number' || !Number.isFinite(price)) return undefined;
  const symbol = typeof currency === 'string' && currency.trim() ? currency.trim() : '$';
  return `${symbol}${price.toFixed(2)}`;
}

// Accepts either a pre-formatted string price (from real shopping providers,
// e.g. Serper) or a numeric price + currency (legacy/catalog shape).
function normalizeProductPrice(price: unknown, currency: unknown): string | undefined {
  if (typeof price === 'string') {
    const trimmed = price.trim();
    return trimmed || undefined;
  }
  return formatPrice(price, currency);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return undefined;
}

function firstStringList(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim());
      if (strings.length > 0) return strings;
    }
    if (typeof value === 'string' && value.trim()) {
      const strings = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

const PRODUCT_ARRAY_KEYS = [
  'recommendedProducts',
  'recommended_products',
  'products',
  'purchaseOptions',
  'purchase_options',
  'shoppingResults',
  'shopping_results',
  'retailMatches',
  'retail_matches',
] as const;

function firstProductArray(src: Record<string, unknown>): unknown[] | undefined {
  for (const key of PRODUCT_ARRAY_KEYS) {
    const value = src[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return undefined;
}

function classifyProductType(source?: string | null): TextScanProductType {
  const resaleNames = [
    'ebay', 'poshmark', 'depop', 'thredup', 'thred up',
    'vestiaire', 'vestiaire collective', 'therealreal', 'the realreal',
    'grailed', 'mercari', 'tradesy', 'rebag', 'fashionphile',
  ];
  const s = (source || '').toLowerCase();
  return resaleNames.some((name) => s.includes(name)) ? 'resale' : 'retail';
}

function mapRecommendedProducts(raw: unknown): TextScanProduct[] {
  if (!Array.isArray(raw)) return [];
  const products: TextScanProduct[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const title =
      firstNonEmptyString(p.title, p.name, p.productName, p.product_name, p.displayName, p.display_name) ||
      undefined;
    if (!title) continue;
    const productUrl = firstNonEmptyString(
      p.productUrl,
      p.product_url,
      p.purchaseUrl,
      p.purchase_url,
      p.url,
      p.link,
      p.affiliateUrl,
      p.affiliate_url
    ) || undefined;
    const id = firstNonEmptyString(p.id, productUrl, `${title}-${index}`);
    const source = firstNonEmptyString(p.retailer, p.source, p.provider, p.merchant, p.store, p.brand) || 'K Scan';
    const imageUrl = firstNonEmptyString(
      p.imageUrl,
      p.image_url,
      p.thumbnail,
      p.thumbnailUrl,
      p.thumbnail_url,
      p.imageSrc,
      p.image_src,
      p.productImageUrl,
      p.product_image_url
    ) || undefined;
    const explicitType = typeof p.type === 'string' ? p.type.trim().toLowerCase() : '';
    products.push({
      id,
      title,
      source,
      price: normalizeProductPrice(
        p.price ?? p.priceText ?? p.price_text ?? p.priceLabel ?? p.price_label ?? p.salePrice ?? p.sale_price,
        p.currency
      ),
      type: explicitType === 'similar'
        ? 'similar'
        : explicitType === 'resale'
        ? 'resale'
        : classifyProductType(source),
      imageUrl,
      productUrl,
    });
  }
  return products;
}

function mapEdgeResponseToTextScanResult(
  raw: unknown,
  query: string,
): TextScanResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      id: generateId(),
      type: 'non_fashion_text',
      result: SAFE_FAILED_MESSAGE,
      metadata: { source: 'textscan', query, attributes: {} },
      products: [],
      confidence: 0,
      savedAt: new Date().toISOString(),
    };
  }

  const src = raw as Record<string, unknown>;
  const rawStatus = typeof src.status === 'string' ? src.status.toLowerCase() : '';

  const identification =
    src.identification && typeof src.identification === 'object' && !Array.isArray(src.identification)
      ? (src.identification as Record<string, unknown>)
      : undefined;

  const attributes = (() => {
    const rawAttrs = src.attributes;
    const a =
      rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)
        ? (rawAttrs as Record<string, unknown>)
        : undefined;

    const legacyStyleTags = Array.isArray(a?.styleTags)
      ? (a.styleTags as unknown[]).filter((x): x is string => typeof x === 'string')
      : Array.isArray(a?.tags)
      ? (a.tags as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const idStyleTags = Array.isArray(identification?.style_tags)
      ? (identification.style_tags as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const styleTags = legacyStyleTags && legacyStyleTags.length > 0 ? legacyStyleTags : idStyleTags;
    const styleDescriptorsInput =
      typeof a?.styleDescriptors === 'string' ? (a.styleDescriptors as string) : undefined;

    const firstOccasion = Array.isArray(identification?.occasion_tags)
      ? (identification.occasion_tags as unknown[]).find((x): x is string => typeof x === 'string')
      : undefined;

    // Defensive: if the legacy attributes object is missing or sparse, fall back
    // to the rich identification fields so TextScan UI never renders blanks when
    // the backend returns the new prompt-upgrade shape.
    return {
      category:
        (typeof a?.category === 'string' && a.category.trim() ? a.category.trim() : null) ??
        (typeof a?.itemType === 'string' && a.itemType.trim() ? a.itemType.trim() : null) ??
        (typeof identification?.item_type === 'string' && identification.item_type.trim()
          ? identification.item_type.trim()
          : null) ??
        (typeof identification?.category === 'string' && identification.category.trim()
          ? identification.category.trim()
          : null) ??
        (typeof identification?.subtype === 'string' && identification.subtype.trim()
          ? identification.subtype.trim()
          : null),
      color:
        normalizeColor(
          Array.isArray(a?.colorPalette) ? a.colorPalette : null,
          typeof a?.color === 'string' ? a.color : null,
        ) ??
        (typeof identification?.primary_color === 'string' && identification.primary_color.trim()
          ? identification.primary_color.trim()
          : null) ??
        (typeof identification?.color === 'string' && identification.color.trim()
          ? identification.color.trim()
          : null),
      material:
        normalizeMaterial(
          typeof a?.materialEstimate === 'string' ? a.materialEstimate : null,
          typeof a?.material === 'string' ? a.material : null,
        ) ??
        firstString(a?.materials) ??
        (typeof identification?.material_estimate === 'string' && identification.material_estimate.trim()
          ? identification.material_estimate.trim()
          : null) ??
        (typeof identification?.material === 'string' && identification.material.trim()
          ? identification.material.trim()
          : null),
      silhouette:
        (typeof a?.silhouette === 'string' && a.silhouette.trim() ? a.silhouette.trim() : null) ??
        (typeof identification?.silhouette === 'string' && identification.silhouette.trim()
          ? identification.silhouette.trim()
          : null),
      occasion:
        (typeof a?.occasion === 'string' && a.occasion.trim() ? a.occasion.trim() : null) ??
        (typeof firstOccasion === 'string' && firstOccasion.trim() ? firstOccasion.trim() : null),
      styleDescriptors: normalizeStyleDescriptors(styleTags, styleDescriptorsInput),
    };
  })();

  const isNonFashion = rawStatus.includes('non');
  const userMessage =
    firstNonEmptyString(
      src.result,
      src.analysis,
      src.description,
      src.message,
      src.summary,
      src.userMessage,
      src.interpretation,
      identification?.visual_observation,
    ) ||
    (isNonFashion
      ? NON_FASHION_MESSAGE
      : 'Analyzed your fashion request.');

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(
      '[TEXTSCAN RAW] recommendedProducts=' +
        (Array.isArray(src.recommendedProducts) ? src.recommendedProducts.length : 'none') +
        ' keys=[' +
        Object.keys(src).join(', ') +
        ']' +
        ' category=' +
        (attributes.category ?? '(none)') +
        ' color=' +
        (attributes.color ?? '(none)') +
        ' material=' +
        (attributes.material ?? '(none)') +
        ' silhouette=' +
        (attributes.silhouette ?? '(none)')
    );
  }

  const confidence = (() => {
    const rawConf =
      (src.attributes as Record<string, unknown> | undefined)?.confidenceScore ??
      identification?.confidence_score;
    const n = typeof rawConf === 'number' ? rawConf : typeof rawConf === 'string' ? Number(rawConf) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  })();

  const searchQueries = firstStringList(
    src.searchQueries,
    src.search_queries,
    identification?.search_queries,
    identification?.normalizedSearchQueries,
    identification?.normalized_search_queries,
  );

  const stylingSuggestions = firstStringList(
    src.stylingSuggestions,
    src.styling_suggestions,
    identification?.styling_suggestions,
  );

  const products = isNonFashion ? [] : mapRecommendedProducts(firstProductArray(src));

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(
      '[TEXTSCAN NORMALIZED] products=' +
        products.length +
        ' purchaseOptions=' +
        products.length +
        ' attrs=[' +
        Object.entries(attributes)
          .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
          .map(([k]) => k)
          .join(',') +
        ']'
    );
  }

  return {
    id: generateId(),
    type: isNonFashion ? 'non_fashion_text' : 'fashion_text',
    result: isNonFashion ? NON_FASHION_MESSAGE : userMessage,
    metadata: { source: 'textscan', query, attributes },
    products,
    purchaseOptions: products.length > 0 ? [...products] : undefined,
    searchQueries,
    stylingSuggestions,
    confidence: isNonFashion ? 0 : confidence,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Analyze a fashion text query via the canonical scan-identify Edge Function.
 *
 * This is the preferred TextScan path. It replaces the legacy Render /api/analyze
 * route and keeps the Gemini key server-side only.
 *
 * @param query  normalized fashion text query (3–500 chars)
 * @param options  optional source label for tracing
 */
export async function analyzeTextWithEdge(
  query: string,
  options: TextScanInvokeOptions = {},
): Promise<TextScanResult> {
  const trimmed = query.trim();

  // Defense-in-depth: validate before invoking the edge function
  const validation = validateTextScanQuery(trimmed);
  if (validation.valid === false) {
    const err = new Error('TEXTSCAN_INVALID_INPUT');
    (err as any).userMessage = validation.message;
    throw err;
  }

  // Authenticated calls only
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const err = new Error('TEXTSCAN_AUTH_REQUIRED');
      (err as any).userMessage = SIGN_IN_REQUIRED_MESSAGE;
      throw err;
    }
  } catch {
    const err = new Error('TEXTSCAN_AUTH_REQUIRED');
    (err as any).userMessage = SIGN_IN_REQUIRED_MESSAGE;
    throw err;
  }

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: {
        mode: 'text',
        textQuery: trimmed,
        source: options.source ?? 'textscan',
        clientTimestamp: new Date().toISOString(),
      },
      signal: ac.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[textScanEdge] invoke error:', error?.message);
      const err = new Error('TEXTSCAN_ANALYSIS_FAILED');
      (err as any).userMessage = SAFE_FAILED_MESSAGE;
      throw err;
    }

    return mapEdgeResponseToTextScanResult(data, trimmed);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('TEXTSCAN_TIMEOUT');
      (timeoutErr as any).userMessage =
        'Analysis is taking longer than expected. Please try again in a moment.';
      throw timeoutErr;
    }
    // Re-throw if it already has a userMessage
    if (err?.userMessage) throw err;
    const fallbackErr = new Error('TEXTSCAN_ANALYSIS_FAILED');
    (fallbackErr as any).userMessage = SAFE_FAILED_MESSAGE;
    throw fallbackErr;
  } finally {
    clearTimeout(timeoutId);
  }
}
