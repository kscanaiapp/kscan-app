/**
 * Scan Identification client adapter (KS-REL-008C).
 *
 * Calls the `scan-identify` Supabase Edge Function with a compressed, locally
 * privacy-prepared image and returns a normalized {@link ScanIdentifyResponse}.
 *
 * Guarantees:
 *   - Uses the current authenticated Supabase client (token attached by invoke).
 *   - Validates + size-guards the payload before any network call (<= 2 MB).
 *   - Always returns a normalized response (status, recommendedProducts,
 *     userMessage); never throws raw provider/network errors at the UI.
 *   - On `completed`, passes through backend product arrays unchanged except
 *     for light field hygiene. Phase 3A separates live `recommendedProducts`
 *     from catalog `similarityMatches`; missing/null/invalid arrays normalize
 *     to [] when their field is present. `non_fashion` and `failed` always
 *     return [].
 *   - Does not touch TextScan.
 */

import { supabase } from './supabaseClient';
import { SCAN_DIAGNOSTICS_ENABLED } from '../constants/build';
import type {
  ScanIdentifyRequest,
  ScanIdentifyResponse,
  FashionAttributes,
  DetailedIdentification,
  DisplayResult,
  RankedScanProduct,
} from '../types/scanIdentification';

const EDGE_FN = 'scan-identify';
// Slightly longer than the edge function's provider timeout (~14 s) + overhead.
const INVOKE_TIMEOUT_MS = 20_000;
// Mirror the server guard so oversized payloads never leave the device.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

// Neutral default for generic (non image-quality) failures. Never blames the
// user's photo or lighting; those appear only on an explicit image-quality
// rejection (IMAGE_QUALITY_MESSAGE).
const NEUTRAL_FAILED_MESSAGE = "We couldn't complete this scan. Please try again.";
// Cause-specific frontend failure copy.
const TIMEOUT_MESSAGE = 'Analysis is taking longer than expected. Please try again.';
const NETWORK_MESSAGE =
  "We couldn't connect to the analysis service. Please check your connection and try again.";
// Shown ONLY when the backend explicitly signals image quality as the cause.
const IMAGE_QUALITY_MESSAGE =
  "We couldn't complete this scan. Please try again in better light or retake the photo.";
const IMAGE_TOO_LARGE_MESSAGE =
  'Image too large. Please retake the photo closer or in better light.';
const SIGN_IN_REQUIRED_MESSAGE = 'Please sign in to scan and identify fashion items.';
const NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';

export type IdentifyScanOptions = {
  source?: 'camera' | 'upload';
  /** Evidence produced by the approved on-device privacy preparation step. */
  privacyProof?: {
    sanitizerVersion: string;
    faceDetectionPerformed: boolean;
    faceMaskApplied: boolean;
    plateDetectionPerformed: boolean;
    plateMaskApplied: boolean;
    metadataStripped: boolean;
  };
  /** Optional abort signal for request cancellation. */
  signal?: AbortSignal;
};

const PRIVACY_PROTECTION_REQUIRED_MESSAGE =
  'Image analysis is unavailable until the image is prepared securely.';

function hasCompleteLocalPrivacyProof(options: IdentifyScanOptions): boolean {
  const proof = options.privacyProof;
  return Boolean(
    proof &&
      typeof proof.sanitizerVersion === 'string' &&
      proof.sanitizerVersion.trim() &&
      typeof proof.faceDetectionPerformed === 'boolean' &&
      typeof proof.faceMaskApplied === 'boolean' &&
      typeof proof.plateDetectionPerformed === 'boolean' &&
      typeof proof.plateMaskApplied === 'boolean' &&
      proof.metadataStripped === true,
  );
}

function failed(userMessage = NEUTRAL_FAILED_MESSAGE): ScanIdentifyResponse {
  return { status: 'failed', recommendedProducts: [], userMessage };
}

/** Strip a data-URI prefix so only raw base64 is sent over the wire. */
function toRawBase64(image: string): string {
  return image.replace(/^data:[^;]+;base64,/, '').trim();
}

const STRING_ATTR_KEYS: (keyof FashionAttributes)[] = [
  'category',
  'itemType',
  'silhouette',
  'materialEstimate',
  'pattern',
  'texture',
  'occasion',
];
const ARRAY_ATTR_KEYS: (keyof FashionAttributes)[] = ['colorPalette', 'styleTags'];

function normalizeAttributes(raw: unknown): FashionAttributes | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: FashionAttributes = {};

  for (const key of STRING_ATTR_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[key] = v.trim();
  }
  for (const key of ARRAY_ATTR_KEYS) {
    const v = src[key];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (items.length) (out as Record<string, unknown>)[key] = items;
    }
  }
  const conf = src.confidenceScore;
  const n = typeof conf === 'number' ? conf : typeof conf === 'string' ? Number(conf) : NaN;
  if (Number.isFinite(n)) out.confidenceScore = Math.max(0, Math.min(1, n));

  return Object.keys(out).length ? out : undefined;
}

function normalizeIdentification(raw: unknown): DetailedIdentification | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: DetailedIdentification = {};

  const stringKeys: (keyof DetailedIdentification)[] = [
    'visual_observation',
    'item_type',
    'subtype',
    'primary_color',
    'pattern',
    'material_estimate',
    'silhouette',
    'fit',
    'length',
    'sleeve_length',
    'neckline_or_lapel',
    'closure',
    'visible_brand_text',
    'brand_guess',
  ];
  const arrayKeys: (keyof DetailedIdentification)[] = [
    'secondary_colors',
    'distinctive_features',
    'style_tags',
    'occasion_tags',
    'search_queries',
  ];

  for (const key of stringKeys) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[key] = v.trim();
  }
  for (const key of arrayKeys) {
    const v = src[key];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (items.length) (out as Record<string, unknown>)[key] = items;
    }
  }
  if (typeof src.logo_detected === 'boolean') out.logo_detected = src.logo_detected;
  if (typeof src.non_fashion === 'boolean') out.non_fashion = src.non_fashion;
  const conf = src.confidence_score;
  const n = typeof conf === 'number' ? conf : typeof conf === 'string' ? Number(conf) : NaN;
  if (Number.isFinite(n)) out.confidence_score = Math.max(0, Math.min(1, n));

  return Object.keys(out).length ? out : undefined;
}

function normalizeRecommendedProducts(raw: unknown): RankedScanProduct[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => p && typeof p === 'object' && !Array.isArray(p))
    .map((p) => {
      const out: RankedScanProduct = { ...p };
      if (typeof p.id !== 'string') delete (out as Record<string, unknown>).id;
      return out;
    });
}

function normalizeDisplayResult(raw: unknown): DisplayResult | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: DisplayResult = {};
  if (typeof src.headline === 'string' && src.headline.trim()) out.headline = src.headline.trim();
  if (typeof src.details === 'string' && src.details.trim()) out.details = src.details.trim();
  if (Array.isArray(src.styling)) {
    const items = src.styling
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim());
    if (items.length) out.styling = items;
  }
  if (typeof src.confidenceLabel === 'string' && src.confidenceLabel.trim()) {
    out.confidenceLabel = src.confidenceLabel.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Coarse failure classification for diagnostics + message mapping. */
export type ScanFailureReason =
  | 'timeout'
  | 'invoke_error'
  | 'backend_failed'
  | 'malformed_response'
  | 'missing_attributes'
  | 'non_fashion'
  | 'image_quality'
  | 'unknown';

/**
 * Detects an EXPLICIT image-quality failure signal on a raw backend payload.
 * The current `scan-identify` contract has no dedicated quality field, so this
 * returns false for today's responses (-> conservative neutral messaging). It
 * honors a future explicit signal without a contract rewrite, and never uses
 * substring matching on user-facing copy.
 */
function hasImageQualitySignal(src: Record<string, unknown>): boolean {
  const reason =
    typeof src.reason === 'string'
      ? src.reason
      : typeof src.failureReason === 'string'
        ? src.failureReason
        : '';
  if (reason.toLowerCase() === 'image_quality') return true;
  return src.imageQuality === true || src.qualityRejected === true;
}

/**
 * Classifies a raw backend payload for diagnostics. Network/timeout reasons are
 * decided by the caller at the invoke/catch boundary; this covers payload-level
 * outcomes only.
 */
function classifyRawResponse(raw: unknown): ScanFailureReason | 'completed' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed_response';
  const src = raw as Record<string, unknown>;
  const status = typeof src.status === 'string' ? src.status.toLowerCase() : '';
  if (status.includes('non')) return 'non_fashion';
  if (status === 'completed') {
    return normalizeAttributes(src.attributes) ? 'completed' : 'missing_attributes';
  }
  if (hasImageQualitySignal(src)) return 'image_quality';
  return 'backend_failed';
}

/**
 * Resolves the user-facing message for a failed payload. Only an explicit
 * image-quality signal keeps lighting/retake guidance; every other (generic)
 * failure discards any backend `userMessage` -- including the exact legacy
 * lighting copy -- and uses the neutral message so we never wrongly blame the
 * user's photo.
 */
function resolveFailedUserMessage(
  backendMessage: string | undefined,
  hasQualitySignal: boolean,
): string {
  if (hasQualitySignal) return backendMessage ?? IMAGE_QUALITY_MESSAGE;
  return NEUTRAL_FAILED_MESSAGE;
}

/**
 * Emits a single safe diagnostic line classifying a failed scan. Logs only
 * coarse metadata (reason, scan status, payload presence, truncated backend
 * message) -- never image bytes, tokens, or secrets. Dev builds only.
 */
function logScanFailure(
  reason: ScanFailureReason,
  detail: { scanStatus?: string; hasPayload?: boolean; backendMessage?: string } = {},
): void {
  if (!SCAN_DIAGNOSTICS_ENABLED) return;
  console.log('[scanIdentification] Failure reason:', {
    reason,
    scanStatus: detail.scanStatus,
    hasPayload: detail.hasPayload,
    backendMessage: detail.backendMessage?.slice(0, 200),
  });
}

/**
 */
export function normalizeScanIdentifyResponse(raw: unknown): ScanIdentifyResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failed();
  const src = raw as Record<string, unknown>;

  const rawStatus = typeof src.status === 'string' ? src.status.toLowerCase() : '';
  const userMessage =
    typeof src.userMessage === 'string' && src.userMessage.trim()
      ? src.userMessage.trim()
      : undefined;

  if (rawStatus.includes('non')) {
    return { status: 'non_fashion', recommendedProducts: [], userMessage: userMessage ?? NON_FASHION_MESSAGE };
  }

  if (rawStatus === 'completed') {
    const attributes = normalizeAttributes(src.attributes);
    if (!attributes) return failed();
    const out: ScanIdentifyResponse = {
      status: 'completed',
      recommendedProducts: normalizeRecommendedProducts(src.recommendedProducts),
      attributes,
      identification: normalizeIdentification(src.identification),
      userMessage: userMessage ?? 'Identified a fashion item from your scan.',
      scanId: typeof src.scanId === 'string' ? src.scanId : undefined,
      displayResult: normalizeDisplayResult(src.displayResult),
    };
    if (Object.prototype.hasOwnProperty.call(src, 'similarityMatches')) {
      out.similarityMatches = normalizeRecommendedProducts(src.similarityMatches);
    }
    return out;
  }

  // Anything else (including explicit 'failed') maps to a safe failure. Only an
  // explicit image-quality signal keeps lighting/retake guidance; otherwise we
  // discard any generic backend userMessage and use the neutral message.
  return failed(resolveFailedUserMessage(userMessage, hasImageQualitySignal(src)));
}

/**
 * Identify a fashion item from a compressed, locally privacy-prepared image.
 *
 * @param image  data URI ("data:image/jpeg;base64,...") or raw base64.
 */
export async function identifyScanImage(
  image: string,
  options: IdentifyScanOptions = {},
): Promise<ScanIdentifyResponse> {
  if (!image || typeof image !== 'string') return failed();

  const imageBase64 = toRawBase64(image);
  if (!imageBase64) return failed();

  // Local size guard — compression already ran upstream; we cannot recompress here.
  if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
    return failed(IMAGE_TOO_LARGE_MESSAGE);
  }

  // Authenticated calls only (default stance). Short-circuit before the network.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return failed(SIGN_IN_REQUIRED_MESSAGE);
  } catch {
    return failed(SIGN_IN_REQUIRED_MESSAGE);
  }

  // Final client-side remote boundary. UI and preparation guards are defense
  // in depth; no source image may reach scan-identify without evidence that a
  // fresh metadata-stripped derivative was created. Face/plate fields remain
  // truthful capability evidence and are not required when unavailable.
  if (!hasCompleteLocalPrivacyProof(options)) {
    return failed(PRIVACY_PROTECTION_REQUIRED_MESSAGE);
  }

  const requestBody: ScanIdentifyRequest = {
    imageBase64,
    source: options.source === 'upload' ? 'upload' : 'camera',
    localPrivacyFiltered: true,
    clientTimestamp: new Date().toISOString(),
  };

  const ac = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () => ac.abort();
  if (externalSignal) {
    // Propagate an external cancellation into the local controller. Do not let
    // the caller's signal replace the local timeout; both must be able to abort.
    if (externalSignal.aborted) {
      // addEventListener('abort') never fires for an already-aborted signal, so
      // mirror the aborted state immediately instead of silently ignoring it.
      ac.abort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  // A caller that handed us an already-aborted signal (unmount / supersession /
  // outer attempt timeout) wants no network call at all — short-circuit before
  // invoke so we never spend a backend scan on a result that will be discarded.
  if (ac.signal.aborted) {
    return failed(TIMEOUT_MESSAGE);
  }

  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: requestBody,
      signal: ac.signal,
    });

    if (error) {
      logScanFailure('invoke_error', { hasPayload: false, backendMessage: error?.message });
      return failed(NETWORK_MESSAGE);
    }

    const reason = classifyRawResponse(data);
    const normalized = normalizeScanIdentifyResponse(data);
    if (reason !== 'completed' && reason !== 'non_fashion') {
      const backendMessage =
        data && typeof data === 'object' && typeof (data as any).userMessage === 'string'
          ? (data as any).userMessage.slice(0, 200)
          : undefined;
      logScanFailure(reason, { scanStatus: normalized.status, hasPayload: !!data, backendMessage });
    } else if (__DEV__) {
      console.log('[scanIdentification] response scan_status=' + normalized.status +
        ' category=' + (normalized.attributes?.category ?? '(none)') +
        ' recommendedProducts=' + normalized.recommendedProducts.length);
    }
    return normalized;
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    const reason: ScanFailureReason = isAbort ? 'timeout' : 'invoke_error';
    logScanFailure(reason, { hasPayload: false, backendMessage: err?.message });
    return failed(isAbort ? TIMEOUT_MESSAGE : NETWORK_MESSAGE);
  } finally {
    clearTimeout(timeoutId);
    // Never leave an external abort listener retained after settlement.
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
