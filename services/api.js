/**
 * K-SCAN service layer. All backend communication lives here.
 *
 * Legacy API base URL resolution:
 *   - EXPO_PUBLIC_API_URL in .env (set per environment — see README)
 *   - No hosted fallback is configured; legacy calls fail lazily without it.
 *
 * Environment guide:
 *   Local dev (iOS sim):    EXPO_PUBLIC_API_URL=http://localhost:3001
 *   Local dev (Android em): EXPO_PUBLIC_API_URL=http://10.0.2.2:3001
 *   Physical device:        EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:3001
 */

// 45 seconds — must exceed the server's 15-second AI timeout plus network
// round-trip, so the client waits for the server's own error response rather
// than timing out first and showing a generic network error.
const ANALYZE_TIMEOUT_MS = 45000;
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
 * POST image to /api/analyze.
 * Returns one of:
 *   { type: 'fashion', result, metadata, products }
 *   { type: 'non-fashion', message }
 * Throws on network failure, server error, or timeout.
 */
export async function analyzeImage(base64) {
  if (__DEV__) console.log('[DEBUG] analyzeImage called payloadLen=' + (base64?.length ?? 0));

  const requestStartedAt = Date.now();
  const baseUrl = getRequiredApiBaseUrl();
  const endpoint = `${baseUrl}/api/analyze`;
  const requestBody = JSON.stringify({ image: base64 });
  const requestId = createAnalyzeRequestId();
  logAnalyzeDiag({
    event: 'request_prepared',
    requestId,
    endpoint,
    imageValueLength: typeof base64 === 'string' ? base64.length : 0,
    bodyBytes: requestBody.length,
    hasExpectedDataUriPrefix:
      typeof base64 === 'string' && base64.startsWith('data:image/jpeg;base64,'),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);

  try {
    if (__DEV__) console.log('[DEBUG] FETCH_START url=' + baseUrl + '/api/analyze');
    logAnalyzeDiag({
      event: 'request_start',
      requestId,
      endpoint,
      bodyBytes: requestBody.length,
      elapsedMs: Date.now() - requestStartedAt,
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    logAnalyzeDiag({
      event: 'request_response',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      status: response.status,
      ok: response.ok,
    });
    if (__DEV__) console.log('[DEBUG] FETCH_DONE status=' + response.status);

    // Guard: try parsing JSON; surface a clean error if the server sent garbage
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Server returned an unreadable response (${response.status}).`);
    }

    // Log raw response once in dev for debugging
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[K-SCAN] raw response:', JSON.stringify(data));
    }

    if (!response.ok) {
      // Structured backend failure (e.g. 503 with { status:'FAILED', message:'...' })
      if (data?.status === 'FAILED') {
        throw new Error(
          'STYLE-PARSE COULD NOT COMPLETE\n' +
          (data.message || 'The AI provider did not return a valid read.')
        );
      }
      // Generic server error — prefer the message field, then result, then fallback
      throw new Error(
        data?.message || data?.result || `Server error (${response.status}). Please try again.`
      );
    }

    logAnalyzeDiag({
      event: 'request_success',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      status: response.status,
    });

    // Non-fashion: return a distinct result type so the UI can show a tailored message
    if (data.type === 'non-fashion') {
      return {
        type: 'non-fashion',
        message: data.message || "This doesn't appear to be a fashion item.",
      };
    }

    // Support multiple possible product array keys from backend
    const rawProducts =
      data.products ??
      data.recommended_products ??
      data.matches ??
      data.items ??
      data.results ??
      [];

    return {
      type: 'fashion',
      result: data.result ?? '',
      metadata: data.metadata ?? { category: '', color: '', silhouette: '' },
      products: Array.isArray(rawProducts)
        ? deduplicateProducts(rawProducts.map(normalizeProduct).filter(Boolean))
        : [],
    };
  } catch (err) {
    clearTimeout(timeoutId);
    logAnalyzeDiag({
      event: 'request_error',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? null,
    });
    if (err.name === 'AbortError') {
      throw userSafeError(
        'Analysis timed out.',
        'Analysis is taking longer than expected. Please try again in a moment.'
      );
    }
    // Network / connection failure (fetch throws TypeError for unreachable hosts)
    if (err instanceof TypeError) {
      throw userSafeError(
        'Network request failed.',
        'We couldn’t complete the scan. Please check your connection and try again.'
      );
    }
    throw err;
  }
}
