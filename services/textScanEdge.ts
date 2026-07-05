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
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : undefined;
    if (!id) continue;
    const title =
      (typeof p.name === 'string' && p.name.trim())
        ? p.name.trim()
        : (typeof p.title === 'string' && p.title.trim())
          ? p.title.trim()
          : (typeof p.product_name === 'string' && p.product_name.trim())
            ? p.product_name.trim()
            : undefined;
    if (!title) continue;
    const source =
      (typeof p.retailer === 'string' && p.retailer.trim())
        ? p.retailer.trim()
        : (typeof p.brand === 'string' && p.brand.trim())
          ? p.brand.trim()
          : (typeof p.source === 'string' && p.source.trim())
            ? p.source.trim()
            : 'K Scan';
    const imageUrl =
      (typeof p.imageUrl === 'string' && p.imageUrl.trim())
        ? p.imageUrl.trim()
        : (typeof p.image_url === 'string' && p.image_url.trim())
          ? p.image_url.trim()
          : undefined;
    const productUrl =
      (typeof p.purchaseUrl === 'string' && p.purchaseUrl.trim())
        ? p.purchaseUrl.trim()
        : (typeof p.product_url === 'string' && p.product_url.trim())
          ? p.product_url.trim()
          : (typeof p.url === 'string' && p.url.trim())
            ? p.url.trim()
            : undefined;
    const explicitType = typeof p.type === 'string' ? p.type.trim().toLowerCase() : '';
    products.push({
      id,
      title,
      source,
      price: normalizeProductPrice(p.price, p.currency),
      type: explicitType === 'similar' ? 'similar' : classifyProductType(source),
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

  const attributes = (() => {
    const rawAttrs = src.attributes;
    if (!rawAttrs || typeof rawAttrs !== 'object' || Array.isArray(rawAttrs)) return {};
    const a = rawAttrs as Record<string, unknown>;
    return {
      category: typeof a.category === 'string' && a.category.trim() ? a.category.trim() : null,
      color: normalizeColor(
        Array.isArray(a.colorPalette) ? a.colorPalette : null,
        typeof a.color === 'string' ? a.color : null,
      ),
      material: normalizeMaterial(
        typeof a.materialEstimate === 'string' ? a.materialEstimate : null,
        typeof a.material === 'string' ? a.material : null,
      ),
      silhouette: typeof a.silhouette === 'string' && a.silhouette.trim() ? a.silhouette.trim() : null,
      occasion: typeof a.occasion === 'string' && a.occasion.trim() ? a.occasion.trim() : null,
      styleDescriptors: normalizeStyleDescriptors(
        Array.isArray(a.styleTags) ? a.styleTags : null,
        typeof a.styleDescriptors === 'string' ? a.styleDescriptors : null,
      ),
    };
  })();

  const isNonFashion = rawStatus.includes('non');
  const userMessage =
    typeof src.userMessage === 'string' && src.userMessage.trim()
      ? src.userMessage.trim()
      : isNonFashion
        ? NON_FASHION_MESSAGE
        : 'Analyzed your fashion request.';

  const confidence = (() => {
    const rawConf = (src.attributes as Record<string, unknown> | undefined)?.confidenceScore;
    const n = typeof rawConf === 'number' ? rawConf : typeof rawConf === 'string' ? Number(rawConf) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  })();

  const identification =
    src.identification && typeof src.identification === 'object' && !Array.isArray(src.identification)
      ? (src.identification as Record<string, unknown>)
      : undefined;

  const searchQueries = Array.isArray(identification?.search_queries)
    ? (identification.search_queries as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
    : [];

  const stylingSuggestions = Array.isArray(identification?.styling_suggestions)
    ? (identification.styling_suggestions as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
    : [];

  return {
    id: generateId(),
    type: isNonFashion ? 'non_fashion_text' : 'fashion_text',
    result: isNonFashion ? NON_FASHION_MESSAGE : userMessage,
    metadata: { source: 'textscan', query, attributes },
    products: isNonFashion ? [] : mapRecommendedProducts(src.recommendedProducts),
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
