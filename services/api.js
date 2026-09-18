/**
 * K-SCAN service layer. All backend communication lives here.
 *
 * Scan identification transport
 * -----------------------------
 * analyzeImage() calls the governed `scan-identify` Supabase Edge Function.
 * That function is the authoritative identification gateway: it verifies the
 * caller's JWT, holds the provider key server-side, and returns a normalized
 * response. The mobile client never talks to a model provider directly.
 *
 * Request body uses the gateway's legacy-compatible shape, which
 * normalizeLegacyBody() promotes to the canonical KScanAIRequest:
 *   { mode, imageBase64, imageMimeType, imageBytes, localPrivacyFiltered,
 *     source, requestId, clientTimestamp }
 *
 * Response contract (scan-identify):
 *   { status: 'completed',   attributes, userMessage, recommendedProducts }
 *   { status: 'non_fashion', userMessage, recommendedProducts }
 *   { status: 'failed',      userMessage, recommendedProducts }
 *
 * Legacy API base URL resolution (diagnostics only):
 *   - EXPO_PUBLIC_API_URL in .env (set per environment — see README)
 *   - No hosted fallback is configured. The legacy Render /api/analyze route is
 *     a permanent 410 tombstone and is never used for identification.
 */
import { Platform } from 'react-native';
import { supabase } from './supabaseClient';

// 30 seconds — must exceed the scan-identify server budget (8s provider cap plus
// auth/validation overhead) so the client waits for the function's own
// structured error response rather than aborting first and masking it as a
// generic network error.
const ANALYZE_TIMEOUT_MS = 30000;
const SCAN_IDENTIFY_FN = 'scan-identify';
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

// Diagnostics-only. Identification no longer depends on EXPO_PUBLIC_API_URL —
// analyzeImage() calls the scan-identify Edge Function. This helper is retained
// so any remaining legacy caller fails loudly with KSCAN_API_URL_NOT_CONFIGURED
// instead of silently targeting the retired Render host.
export function getRequiredApiBaseUrl() {
  const baseUrl = resolveBaseUrl();
  if (baseUrl) return baseUrl;
  throw userSafeError(
    API_URL_CONFIG_ERROR,
    'The legacy analysis service is not configured. Please try again later.'
  );
}

// Safe at module load: missing EXPO_PUBLIC_API_URL never blocks identification.
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

// ── scan-identify response mapping ───────────────────────────────────────────
// The gateway returns a sanitized FashionAttributes object. It deliberately
// never returns identity, demographic, or brand fields, so `brand` stays
// undefined here rather than being invented client-side.

function firstString(value) {
  return Array.isArray(value)
    ? value.find((entry) => typeof entry === 'string' && entry.trim()) || ''
    : '';
}

function joinPalette(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim())
    .join(' / ');
}

/**
 * Map scan-identify `attributes` onto the metadata shape the scan UI, the
 * Style Library writer, and the secondhand/sneaker enrichment inputs consume.
 */
export function mapScanAttributesToMetadata(attributes) {
  const a = attributes && typeof attributes === 'object' && !Array.isArray(attributes)
    ? attributes
    : {};

  return {
    category:   typeof a.category === 'string' ? a.category : '',
    color:      joinPalette(a.colorPalette),
    silhouette: typeof a.silhouette === 'string' ? a.silhouette : '',
    itemType:   typeof a.itemType === 'string' ? a.itemType : '',
    material:   typeof a.materialEstimate === 'string' ? a.materialEstimate : '',
    pattern:    typeof a.pattern === 'string' ? a.pattern : '',
    texture:    typeof a.texture === 'string' ? a.texture : '',
    occasion:   typeof a.occasion === 'string' ? a.occasion : '',
    style:      firstString(a.styleTags),
    styleTags:  Array.isArray(a.styleTags)
      ? a.styleTags.filter((tag) => typeof tag === 'string' && tag.trim())
      : [],
    colorPalette: Array.isArray(a.colorPalette)
      ? a.colorPalette.filter((tone) => typeof tone === 'string' && tone.trim())
      : [],
    categoryConfidence:
      typeof a.confidenceScore === 'number' && Number.isFinite(a.confidenceScore)
        ? a.confidenceScore
        : undefined,
  };
}

/** Estimate decoded byte length of a base64 payload (data-URI prefix tolerated). */
function estimateImageBytes(value) {
  if (typeof value !== 'string') return 0;
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Read a structured error body out of a Supabase FunctionsHttpError without
 * throwing. The SDK leaves the raw Response on `error.context`.
 */
async function readFunctionErrorBody(error) {
  const context = error && typeof error === 'object' ? error.context : null;
  if (!context || typeof context.json !== 'function') return null;
  try {
    return await context.json();
  } catch {
    return null;
  }
}

/**
 * Identify a fashion item via the governed scan-identify Edge Function.
 *
 * @param {string} base64 - data URI or bare base64 JPEG produced by
 *   compressForUpload() and passed through the pre-upload privacy sanitizer.
 * Returns one of:
 *   { type: 'fashion', result, metadata, products }
 *   { type: 'non-fashion', message }
 * Throws a user-safe Error on auth failure, provider failure, or timeout.
 */
export async function analyzeImage(base64) {
  if (__DEV__) console.log('[DEBUG] analyzeImage called payloadLen=' + (base64?.length ?? 0));

  const requestStartedAt = Date.now();
  const requestId = createAnalyzeRequestId();
  const imageBytes = estimateImageBytes(base64);

  logAnalyzeDiag({
    event: 'request_prepared',
    requestId,
    endpoint: `functions/v1/${SCAN_IDENTIFY_FN}`,
    imageValueLength: typeof base64 === 'string' ? base64.length : 0,
    imageBytes,
    hasExpectedDataUriPrefix:
      typeof base64 === 'string' && base64.startsWith('data:image/jpeg;base64,'),
  });

  if (typeof base64 !== 'string' || !base64.trim()) {
    throw userSafeError(
      'SCAN_IMAGE_MISSING',
      'We could not read that photo. Please retake it and try again.'
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);

  try {
    logAnalyzeDiag({
      event: 'request_start',
      requestId,
      imageBytes,
      elapsedMs: Date.now() - requestStartedAt,
    });

    const { data, error } = await supabase.functions.invoke(SCAN_IDENTIFY_FN, {
      body: {
        mode: 'image',
        imageBase64: base64,
        imageMimeType: 'image/jpeg',
        imageBytes,
        // Truthful privacy declaration: the pre-upload sanitizer is currently a
        // documented pass-through, so we must NOT claim local PII masking.
        localPrivacyFiltered: false,
        source: Platform.OS,
        requestId,
        clientTimestamp: new Date().toISOString(),
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (error) {
      const body = await readFunctionErrorBody(error);
      const serverError = typeof body?.error === 'string' ? body.error : '';
      logAnalyzeDiag({
        event: 'request_error',
        requestId,
        elapsedMs: Date.now() - requestStartedAt,
        errorName: error?.name ?? null,
        serverError: serverError || null,
      });

      if (/authenticat|authoriz/i.test(serverError)) {
        throw userSafeError(
          'SCAN_NOT_AUTHENTICATED',
          'Please sign in again to scan.'
        );
      }
      if (typeof body?.message === 'string' && body.code === 'TEXTSCAN_INVALID_INPUT') {
        throw userSafeError('SCAN_INVALID_INPUT', body.message);
      }
      throw userSafeError(
        'SCAN_IDENTIFY_UNAVAILABLE',
        'We couldn’t complete the scan. Please check your connection and try again.'
      );
    }

    logAnalyzeDiag({
      event: 'request_response',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      status: data?.status ?? null,
    });

    const status = typeof data?.status === 'string' ? data.status : '';
    const userMessage = typeof data?.userMessage === 'string' ? data.userMessage : '';

    if (status === 'non_fashion') {
      return {
        type: 'non-fashion',
        message: userMessage || "This doesn't appear to be a fashion item.",
      };
    }

    if (status !== 'completed') {
      // 'failed' and any unrecognized status are surfaced, never silently
      // rendered as an empty successful result.
      throw userSafeError(
        'SCAN_IDENTIFY_FAILED',
        userMessage ||
          'We couldn’t complete this scan. Please try again in better light or retake the photo.'
      );
    }

    logAnalyzeDiag({
      event: 'request_success',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
    });

    const rawProducts = Array.isArray(data?.recommendedProducts) ? data.recommendedProducts : [];

    return {
      type: 'fashion',
      result: userMessage,
      metadata: mapScanAttributesToMetadata(data?.attributes),
      products: deduplicateProducts(rawProducts.map(normalizeProduct).filter(Boolean)),
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err?.userMessage) throw err;

    logAnalyzeDiag({
      event: 'request_error',
      requestId,
      elapsedMs: Date.now() - requestStartedAt,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? null,
    });

    if (err?.name === 'AbortError') {
      throw userSafeError(
        'SCAN_TIMEOUT',
        'Analysis is taking longer than expected. Please try again in a moment.'
      );
    }
    if (err instanceof TypeError) {
      throw userSafeError(
        'SCAN_NETWORK_FAILED',
        'We couldn’t complete the scan. Please check your connection and try again.'
      );
    }
    throw userSafeError(
      'SCAN_IDENTIFY_UNAVAILABLE',
      'We couldn’t complete the scan. Please check your connection and try again.'
    );
  }
}
