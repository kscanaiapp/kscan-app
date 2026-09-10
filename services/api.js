/**
 * K-SCAN service layer. All backend communication lives here.
 *
 * analyzeImage() calls the scan-identify Supabase Edge Function (real Gemini
 * vision/text analysis, JWT-authenticated via the current Supabase session,
 * GEMINI_API_KEY held server-side only — see supabase/functions/scan-identify).
 * This replaced the legacy POST /api/analyze REST path, which is permanently
 * retired (server.js returns 410 LEGACY_ANALYZE_DISABLED) and was never wired
 * to a live replacement on this branch — see
 * GOOGLE_XR_TAKEOVER_AND_CONTINUATION_REPORT.md in the native XR repo for the
 * investigation that found and fixed this gap.
 *
 * Legacy API base URL resolution (used only by other functions in this file,
 * not analyzeImage — kept for reference, not for the analyze path):
 *   - EXPO_PUBLIC_API_URL in .env (set per environment — see README)
 *   - No hosted fallback is configured; legacy calls fail lazily without it.
 */

import { supabase } from './supabaseClient';

// 20 seconds — the server enforces its own ~8s Gemini timeout and always
// returns a safe JSON response within that budget, so this is a defense-in-depth
// cap for network-level hangs, not the primary timeout.
const ANALYZE_TIMEOUT_MS = 20000;
const API_URL_CONFIG_ERROR = 'KSCAN_API_URL_NOT_CONFIGURED';
let analyzeRequestSequence = 0;

function createAnalyzeRequestId() {
  analyzeRequestSequence += 1;
  return `analyze-${Date.now()}-${analyzeRequestSequence}`;
}

function logAnalyzeDiag(payload) {
  if (__DEV__) {
    console.log(`[KSCAN_DIAG_ANALYZE] ${JSON.stringify({
      ...payload,
      timestamp: Date.now(),
    })}`);
  }
}

function userSafeError(message, userMessage) {
  const error = new Error(message);
  error.code = message;
  error.userMessage = userMessage;
  return error;
}

function resolveBaseUrl() {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && envUrl.trim()) return envUrl.trim();
  return null;
}

function getRequiredApiBaseUrl() {
  const baseUrl = resolveBaseUrl();
  if (baseUrl) return baseUrl;
  throw userSafeError(
    API_URL_CONFIG_ERROR,
    'The legacy analysis service is not configured. Please try again later.'
  );
}

// Safe at module load: missing EXPO_PUBLIC_API_URL is reported only if a legacy
// API function is invoked.
export const BASE_URL = resolveBaseUrl();
export function getApiBaseUrl() {
  return resolveBaseUrl();
}
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  console.log('[K-SCAN] API_BASE_URL:', BASE_URL || '(not configured)');
}

const KNOWN_BAD_PRODUCT_IMAGE_RE =
  /(?:picsum|unsplash|landscape|landscapes|ocean|oceans|bridge|bridges|building|buildings|cityscape|cityscapes|city|mountain|mountains|beach|beaches|nature|scenery|random|stock-photo|stockphoto)/i;

function normalizeImageUrl(...values) {
  const imageUrl = values.find((value) => typeof value === 'string' && value.trim());
  if (!imageUrl || KNOWN_BAD_PRODUCT_IMAGE_RE.test(imageUrl)) return null;
  return imageUrl;
}

function inferImageCategory(p) {
  const text = [
    p?.imageCategory,
    p?.image_category,
    p?.categoryFallback,
    p?.name,
    p?.title,
    ...(Array.isArray(p?.tags) ? p.tags : []),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(sneaker|sneakers|boot|boots|shoe|shoes|footwear)\b/.test(text)) return 'footwear';
  if (/\b(jacket|coat|blazer|vest|outerwear)\b/.test(text)) return 'outerwear';
  if (/\b(dress|gown|one-piece|one piece)\b/.test(text)) return 'dresses';
  if (/\b(jeans|trousers|pants|shorts|skirt|bottoms)\b/.test(text)) return 'bottoms';
  if (/\b(bag|tote|beanie|accessor|sling)\b/.test(text)) return 'accessories';
  if (/\b(shirt|hoodie|tank|polo|bralette|top|cardigan|turtleneck)\b/.test(text)) return 'tops';
  return null;
}

/**
 * Normalize a raw product from the backend into a safe shape for ProductShelf.
 * Handles alternative field names, missing fields, null items, and prose strings
 * (e.g. backend accidentally stringified a sub-field) without crashing.
 */
function normalizeProduct(p, i) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  return {
    id:           String(p.id ?? p._id ?? i),
    name:         p.name ?? p.title ?? 'Unknown Product',
    retailer:     p.retailer ?? p.brand ?? 'Retailer unavailable',
    price:        p.price ?? 'Price unavailable',
    imageUrl:     normalizeImageUrl(p.imageUrl, p.image_url, p.image),
    imageCategory: inferImageCategory(p),
    productUrl:   p.productUrl ?? p.product_url ?? p.url ?? p.purchaseUrl ?? null,
    purchaseUrl:  p.purchaseUrl ?? p.purchase_url ?? p.productUrl ?? p.product_url ?? p.url ?? null,
    affiliateUrl: p.affiliateUrl ?? p.affiliate_url ?? null,
  };
}

/**
 * De-duplicate products by (name, retailer) key so the shelf never shows the
 * same item twice even if the backend returns overlapping entries.
 */
function deduplicateProducts(products) {
  const seen = new Set();
  return products.filter((p) => {
    const key = `${String(p.name || '').toLowerCase()}|${String(p.retailer || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Map a scan-identify response to the shape this module's callers
 * (hooks/useKScan.js) already expect: { type, result, metadata, products } or
 * { type: 'non-fashion', message }.
 *
 * Only reads fields confirmed present by live verification against the
 * deployed staging function (2026-08-22): status, userMessage, attributes.*,
 * recommendedProducts/products, and displayResult.{headline,styling}. The
 * deployed function returns additional fields (identification, shoppingMeta,
 * purchaseOptions, similarityMatches, commerce, scanId, correlation, ...) not
 * present in this repo's checked-in supabase/functions/scan-identify source —
 * the live function is materially ahead of what's committed here. This mapper
 * deliberately reads only the fields verified above rather than the full
 * (unverified, possibly stale) contract, and treats every field as optional.
 */
function mapScanIdentifyResponse(data) {
  if (!data || typeof data !== 'object') {
    throw userSafeError(
      'SCAN_IDENTIFY_INVALID_RESPONSE',
      'We couldn’t complete the scan. Please try again.'
    );
  }

  if (data.status === 'non_fashion') {
    return {
      type: 'non-fashion',
      message: data.userMessage || "This doesn't appear to be a fashion item.",
    };
  }

  if (data.status !== 'completed') {
    // 'failed', or any other/unrecognized status — scan-identify always returns
    // a safe userMessage for these, never a raw provider error.
    throw userSafeError(
      'SCAN_IDENTIFY_FAILED',
      data.userMessage || 'We couldn’t complete the scan. Please try again.'
    );
  }

  const attributes = data.attributes && typeof data.attributes === 'object' ? data.attributes : {};
  const displayResult = data.displayResult && typeof data.displayResult === 'object' ? data.displayResult : null;

  // Prefer the richer narrative (headline + first styling suggestion) when the
  // live function provides it; fall back to the terse userMessage otherwise.
  let result = data.userMessage || 'Identified a fashion item from your scan.';
  if (displayResult) {
    const headline = typeof displayResult.headline === 'string' ? displayResult.headline.trim() : '';
    const styling = Array.isArray(displayResult.styling) ? displayResult.styling.find((s) => typeof s === 'string' && s.trim()) : null;
    if (headline) {
      result = styling ? `${headline} ${styling}` : headline;
    }
  }

  // recommendedProducts/products are both [] in every live response observed so
  // far (real product-search providers were attempted — e.g. kickscrew, serper —
  // and honestly reported zero matches rather than fabricating results); kept as
  // a real pass-through, not hardcoded [], so this doesn't silently drop products
  // if either field starts returning them. purchaseOptions/similarityMatches are
  // NOT mapped here — their item shape has never been observed with real data, so
  // guessing at a mapping risks producing garbage rather than nothing.
  const rawProducts = Array.isArray(data.recommendedProducts) && data.recommendedProducts.length
    ? data.recommendedProducts
    : Array.isArray(data.products) ? data.products : [];

  // confidenceScore is real (the model's own estimate, 0-1) — pass it through so
  // downstream consumers (e.g. the wearable formatter's analysis.metadata.confidence
  // read in services/wearables/bridge.ts) get the real value instead of silently
  // defaulting to 0.5 for every scan.
  const confidence = typeof attributes.confidenceScore === 'number'
    ? Math.max(0, Math.min(1, attributes.confidenceScore))
    : undefined;

  return {
    type: 'fashion',
    result,
    metadata: {
      category: typeof attributes.category === 'string' ? attributes.category : '',
      color: Array.isArray(attributes.colorPalette) ? attributes.colorPalette.join(', ') : '',
      silhouette: typeof attributes.silhouette === 'string' ? attributes.silhouette : '',
      ...(confidence !== undefined ? { confidence } : {}),
    },
    products: deduplicateProducts(rawProducts.map(normalizeProduct).filter(Boolean)),
  };
}

/**
 * Analyze a captured/uploaded photo via the scan-identify Supabase Edge
 * Function (real Gemini vision analysis; GEMINI_API_KEY stays server-side).
 * Returns one of:
 *   { type: 'fashion', result, metadata, products }
 *   { type: 'non-fashion', message }
 * Throws (with a user-safe .userMessage) on network failure, auth failure, or
 * a 'failed' status from the server.
 */
export async function analyzeImage(base64) {
  if (__DEV__) console.log('[DEBUG] analyzeImage called payloadLen=' + (base64?.length ?? 0));

  const requestStartedAt = Date.now();
  const requestId = createAnalyzeRequestId();
  logAnalyzeDiag({
    event: 'request_prepared',
    requestId,
    target: 'scan-identify',
    imageValueLength: typeof base64 === 'string' ? base64.length : 0,
    hasExpectedDataUriPrefix:
      typeof base64 === 'string' && base64.startsWith('data:image/jpeg;base64,'),
  });

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(Object.assign(new Error('ANALYZE_TIMEOUT'), { name: 'AbortError' })), ANALYZE_TIMEOUT_MS);
  });

  try {
    logAnalyzeDiag({ event: 'request_start', requestId, target: 'scan-identify', elapsedMs: Date.now() - requestStartedAt });

    const invokePromise = supabase.functions.invoke('scan-identify', {
      body: { mode: 'image', imageBase64: base64, requestId, source: 'mobile' },
    });
    const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
    clearTimeout(timeoutId);

    logAnalyzeDiag({
      event: 'request_response',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      ok: !error,
    });
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[K-SCAN] raw response:', JSON.stringify(data ?? { error: String(error) }));
    }

    if (error) {
      // FunctionsHttpError (non-2xx) carries the parsed body on error.context when
      // available; anything else (network failure, FunctionsFetchError) falls
      // through to the generic message below. Never surface the raw error object.
      const status = error?.context?.status;
      if (status === 401) {
        throw userSafeError('SCAN_IDENTIFY_UNAUTHENTICATED', 'Please sign in again to scan.');
      }
      throw userSafeError(
        'SCAN_IDENTIFY_REQUEST_FAILED',
        'We couldn’t complete the scan. Please check your connection and try again.'
      );
    }

    logAnalyzeDiag({ event: 'request_success', requestId, elapsedMs: Date.now() - requestStartedAt });
    return mapScanIdentifyResponse(data);
  } catch (err) {
    clearTimeout(timeoutId);
    logAnalyzeDiag({
      event: 'request_error',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? null,
    });
    if (err?.name === 'AbortError') {
      throw userSafeError(
        'ANALYZE_TIMEOUT',
        'Analysis is taking longer than expected. Please try again in a moment.'
      );
    }
    throw err;
  }
}
