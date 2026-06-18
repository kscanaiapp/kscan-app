/**
 * K-SCAN service layer. All backend communication lives here.
 *
 * Base URL resolution (in priority order):
 *   1. EXPO_PUBLIC_API_URL in .env (set per environment — see README)
 *   2. Hosted beta backend: https://kscan-app-1.onrender.com
 *
 * Environment guide:
 *   Local dev (iOS sim):    EXPO_PUBLIC_API_URL=http://localhost:3001
 *   Local dev (Android em): EXPO_PUBLIC_API_URL=http://10.0.2.2:3001
 *   Physical device:        EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:3001
 *   Hosted beta backend:    EXPO_PUBLIC_API_URL=https://kscan-app-1.onrender.com
 */

// 45 seconds — must exceed the server's 15-second AI timeout plus network
// round-trip, so the client waits for the server's own error response rather
// than timing out first and showing a generic network error.
const ANALYZE_TIMEOUT_MS = 45000;
const HOSTED_BETA_BASE_URL = 'https://kscan-app-1.onrender.com';
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
  error.userMessage = userMessage;
  return error;
}

function resolveBaseUrl() {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && envUrl.trim()) return envUrl.trim();
  return HOSTED_BETA_BASE_URL;
}

// Resolved once at module load — log it once for easy debugging
export const BASE_URL = resolveBaseUrl();
export function getApiBaseUrl() {
  return BASE_URL;
}
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  console.log('[K-SCAN] API_BASE_URL:', BASE_URL);
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
 * POST text query to /api/analyze with mode: 'text'.
 *
 * Frontend timeout: 15 seconds (server AI timeout is 10 s).
 *
 * Input validation runs before the network call:
 *   - query must be a string, trimmed, 3–500 chars
 *   - rejects base64-like payloads, code blocks, prompt injection
 *   - rejects email, phone, SSN-like patterns
 *   - rejects >30% non-alphanumeric characters
 *
 * Returns normalized backend response on success.
 * Throws safe errors on timeout, rate limit, or failure.
 */
export async function analyzeText(query, options = {}) {
  const source = options?.source ?? 'textscan';

  // ── Input validation ───────────────────────────────────────────────────────
  if (typeof query !== 'string') {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  const trimmed = query.trim();

  if (trimmed.length === 0 || trimmed.length < 3 || trimmed.length > 500) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  const normalized = trimmed.replace(/\s+/g, ' ');

  // Reject base64-like payloads
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(normalized)) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // Reject code blocks
  if (normalized.includes('```') || normalized.includes('`')) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // Reject prompt injection patterns
  const injectionPatterns = [
    'ignore previous instructions',
    'system prompt',
    'developer message',
    'reveal your prompt',
    'act as another system',
    'ignore all instructions',
    'forget previous',
    'you are now',
    'new role:',
    'override instructions',
  ];
  const lower = normalized.toLowerCase();
  for (const pattern of injectionPatterns) {
    if (lower.includes(pattern)) {
      throw userSafeError(
        'TEXTSCAN_INVALID_INPUT',
        'Invalid query format. Please describe a fashion item.'
      );
    }
  }

  // Reject email addresses
  if (/[\w.+-]+@[\w.-]+\.\w+/.test(normalized)) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // Reject phone numbers
  if (/(\+?\d[\d\s-]{7,}\d)/.test(normalized)) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // Reject SSN-like patterns
  if (/\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/.test(normalized)) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // Reject queries with more than 30% non-alphanumeric characters
  const nonAlphaNum = (normalized.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlphaNum / normalized.length > 0.30) {
    throw userSafeError(
      'TEXTSCAN_INVALID_INPUT',
      'Invalid query format. Please describe a fashion item.'
    );
  }

  // ── Request ────────────────────────────────────────────────────────────────
  const TEXTSCAN_TIMEOUT_MS = 15000;
  const requestStartedAt = Date.now();
  const endpoint = `${BASE_URL}/api/analyze`;
  const requestBody = JSON.stringify({ mode: 'text', query: normalized, source });
  const requestId = createAnalyzeRequestId();

  logAnalyzeDiag({
    event: 'textscan_request_prepared',
    requestId,
    endpoint,
    queryLength: normalized.length,
    bodyBytes: requestBody.length,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TEXTSCAN_TIMEOUT_MS);

  try {
    logAnalyzeDiag({
      event: 'textscan_request_start',
      requestId,
      endpoint,
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
      event: 'textscan_request_response',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      status: response.status,
      ok: response.ok,
    });

    // Guard: try parsing JSON; surface a clean error if the server sent garbage
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Server returned an unreadable response (${response.status}).`);
    }

    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[K-SCAN] textscan raw response:', JSON.stringify(data));
    }

    // Rate limit
    if (response.status === 429) {
      throw userSafeError(
        'TEXTSCAN_RATE_LIMITED',
        data?.message || 'Too many requests. Please try again later.'
      );
    }

    if (!response.ok) {
      const safeMessages = {
        TEXTSCAN_INVALID_INPUT: 'Invalid query format. Please describe a fashion item.',
        TEXTSCAN_RATE_LIMITED: 'Too many requests. Please try again later.',
        TEXTSCAN_TIMEOUT: 'Analysis is taking longer than expected. Please try again in a moment.',
        TEXTSCAN_ANALYSIS_FAILED: 'Unable to analyze this style request. Please try again.',
        TEXTSCAN_NON_FASHION: "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit.",
        TEXTSCAN_BACKEND_DISABLED: 'Text analysis is coming soon.',
      };
      if (data?.error === true && data?.code) {
        const safeMessage = safeMessages[data.code] || 'Unable to analyze this style request. Please try again.';
        throw userSafeError(data.code, safeMessage);
      }
      throw new Error(
        safeMessages.TEXTSCAN_ANALYSIS_FAILED
      );
    }

    logAnalyzeDiag({
      event: 'textscan_request_success',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      status: response.status,
    });

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    logAnalyzeDiag({
      event: 'textscan_request_error',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? null,
    });

    if (err.name === 'AbortError') {
      throw userSafeError(
        'TEXTSCAN_TIMEOUT',
        'Analysis is taking longer than expected. Please try again in a moment.'
      );
    }
    if (err instanceof TypeError || err.name === 'TypeError') {
      throw userSafeError(
        'TEXTSCAN_ANALYSIS_FAILED',
        'We couldn\u2019t complete the analysis. Please check your connection and try again.'
      );
    }
    throw err;
  }
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
  const endpoint = `${BASE_URL}/api/analyze`;
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
    if (__DEV__) console.log('[DEBUG] FETCH_START url=' + BASE_URL + '/api/analyze');
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
    if (err instanceof TypeError || err.name === 'TypeError') {
      throw userSafeError(
        'Network request failed.',
        'We couldn’t complete the scan. Please check your connection and try again.'
      );
    }
    throw err;
  }
}
