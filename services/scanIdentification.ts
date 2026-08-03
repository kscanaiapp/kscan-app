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
  DetectedGarment,
  DisplayResult,
  RankedScanProduct,
  ScanSelectedCandidate,
} from '../types/scanIdentification';

const EDGE_FN = 'scan-identify';
// Slightly longer than the edge function's provider timeout (~14 s) + overhead.
const INVOKE_TIMEOUT_MS = 20_000;
// Mirror the server guard so oversized payloads never leave the device.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
export const MAX_DETECTED_GARMENTS = 5;

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
  localPrivacyFiltered?: boolean;
  /** Optional abort signal for request cancellation. */
  signal?: AbortSignal;
  /** v119 detection/detail contract. Omitted to preserve legacy behavior. */
  multiItemDetection?: boolean;
  requestMode?: 'multi_item_detection' | 'selected_item';
  scanSessionId?: string;
  imageDigestPrefix?: string;
  selectedCandidate?: ScanSelectedCandidate;
  /**
   * Checkpoint 3.5 selection-lineage token, echoed back verbatim from the
   * candidate the user chose.
   *
   * Only the Scanner's selected-item path supplies it. Elise and StyleChat
   * share this transport and never pass it, so their request body is unchanged
   * — the same reason `contractRequestV2` below is absent by default.
   */
  selectionToken?: Record<string, unknown>;
  /**
   * Scanner-only fashion-identification-v2 envelope (Phase 2B.2).
   *
   * When present, this object is sent as the request body instead of the legacy
   * shape, and the legacy correlation fields above are merged alongside it
   * because the deployed handler still reads `scanSessionId` /
   * `imageDigestPrefix` from the top level on both contract paths.
   *
   * ABSENT BY DEFAULT, AND THAT IS LOAD-BEARING: Elise's attachment path and
   * StyleChat share this transport and never pass it, so their request body,
   * ordering and error handling stay byte-for-byte what they are today. Only
   * `services/scannerIdentificationV2.ts` supplies this field.
   */
  contractRequestV2?: Record<string, unknown>;
  /**
   * Checkpoint 4.5 — the BOUNDED advisory-similarity candidate set.
   *
   * Built on device by `services/similarItemCandidateProvider.ts`, which caps
   * it, prunes it and reports what it dropped. This transport only forwards
   * it; it never builds, loads, reorders or trims candidates itself.
   *
   * ABSENT BY DEFAULT, for the same load-bearing reason as `contractRequestV2`
   * above: Elise's attachment path and StyleChat share this transport and
   * never pass it, so their request body stays byte-for-byte what it is today.
   *
   * Absent is also the FAILURE mode. If candidate building fails, times out,
   * or is skipped, the caller simply omits this field — the backend then
   * receives no `existingItems`, produces no comparison, and the scan and its
   * commerce results are identical to today. Similarity can never fail a scan.
   *
   * Contains no image bytes: `imageUri` entries are references the client
   * already holds for local rendering.
   */
  existingItems?: unknown[];
};

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
    'scan_quality_note',
  ];
  const arrayKeys: (keyof DetailedIdentification)[] = [
    'secondary_colors',
    'distinctive_features',
    'style_tags',
    'occasion_tags',
    'search_queries',
    'styling_suggestions',
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

function normalizeBounds(raw: unknown): ScanSelectedCandidate['bounds'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(src[key]));
  if (!values.every(Number.isFinite)) return undefined;
  const x = Math.max(0, Math.min(1, values[0]));
  const y = Math.max(0, Math.min(1, values[1]));
  return {
    x,
    y,
    width: Math.max(0.01, Math.min(1 - x, values[2])),
    height: Math.max(0.01, Math.min(1 - y, values[3])),
  };
}

function safeContractText(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function normalizeDetectedGarment(raw: unknown): DetectedGarment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const candidateId = safeContractText(src.candidateId, 80);
  const category = safeContractText(src.category);
  const subtype = safeContractText(src.subtype);
  const label = safeContractText(src.label);
  const identification = normalizeIdentification(src.identification);
  const attributes = normalizeAttributes(src.attributes);
  if (!candidateId || !category || !subtype || !label || !identification || !attributes) {
    return undefined;
  }
  const orderValue = Number(src.order);
  if (!Number.isInteger(orderValue) || orderValue < 0 || orderValue >= MAX_DETECTED_GARMENTS) {
    return undefined;
  }
  const confidenceValue = Number(src.confidenceScore);
  const confidenceScore = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : undefined;
  const bounds = normalizeBounds(src.bounds);
  return {
    candidateId,
    order: orderValue,
    label,
    category,
    subtype,
    ...(bounds ? { bounds } : {}),
    ...(confidenceScore !== undefined ? { confidenceScore } : {}),
    attributes,
    identification,
  };
}

function normalizeDetectedGarments(raw: unknown): DetectedGarment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DetectedGarment[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const garment = normalizeDetectedGarment(entry);
    if (!garment || seen.has(garment.candidateId)) continue;
    seen.add(garment.candidateId);
    out.push(garment);
    if (out.length >= MAX_DETECTED_GARMENTS) break;
  }
  return out;
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
 * Extracts a bounded contract error from a failed invoke.
 *
 * supabase-js reports a non-2xx as a `FunctionsHttpError` carrying the raw
 * `Response` on `.context`. Only the HTTP status and the enum `error.code` are
 * read; the message and body are never surfaced, because a body can contain
 * request content. Every step is guarded — a body that is not JSON, a Response
 * already consumed, or an unexpected error shape simply yields null and the
 * caller treats it as an ordinary network failure.
 */
async function readContractError(
  error: unknown,
): Promise<{ httpStatus: number; code: string } | null> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    if (!context || typeof context.status !== 'number') return null;
    if (typeof context.json !== 'function') return null;
    const body = await context.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const inner = (body as Record<string, unknown>).error;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
    const code = (inner as Record<string, unknown>).code;
    if (typeof code !== 'string' || !code.trim()) return null;
    return { httpStatus: context.status, code: code.trim() };
  } catch {
    return null;
  }
}

/**
 * Attaches the additive transitional V2 fields to an already-normalized
 * response, for EVERY outcome branch.
 *
 * Applied to failure and non-fashion branches too, and that matters: a V2
 * `insufficient_visual_evidence` or `technical_failure` result arrives on the
 * legacy `failed` branch, and the Scanner adapter has to tell those apart. If
 * the envelope were only carried on `completed`, every non-success V2 status
 * would collapse into one indistinguishable legacy failure.
 *
 * The payload is carried UNINTERPRETED — the Scanner V2 adapter is the only
 * code that validates it. Normalizing it here would let a malformed payload
 * acquire structure it never had on the wire.
 */
function withTransitionalV2(
  out: ScanIdentifyResponse,
  src: Record<string, unknown>,
): ScanIdentifyResponse {
  if (typeof src.contractVersion === 'string') out.contractVersion = src.contractVersion;
  if (Object.prototype.hasOwnProperty.call(src, 'identificationV2')) {
    out.identificationV2 = src.identificationV2;
  }
  return out;
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
    return withTransitionalV2(
      { status: 'non_fashion', recommendedProducts: [], userMessage: userMessage ?? NON_FASHION_MESSAGE },
      src,
    );
  }

  if (rawStatus === 'completed') {
    const attributes = normalizeAttributes(src.attributes);
    if (!attributes) return withTransitionalV2(failed(), src);
    const out: ScanIdentifyResponse = {
      status: 'completed',
      recommendedProducts: normalizeRecommendedProducts(src.recommendedProducts),
      attributes,
      identification: normalizeIdentification(src.identification),
      userMessage: userMessage ?? 'Identified a fashion item from your scan.',
      scanId: typeof src.scanId === 'string' ? src.scanId : undefined,
      scanSessionId: typeof src.scanSessionId === 'string' ? src.scanSessionId : undefined,
      imageDigestPrefix: typeof src.imageDigestPrefix === 'string' ? src.imageDigestPrefix : undefined,
      displayResult: normalizeDisplayResult(src.displayResult),
    };
    if (Object.prototype.hasOwnProperty.call(src, 'detectedGarments')) {
      out.detectedGarments = normalizeDetectedGarments(src.detectedGarments) ?? [];
    }
    if (Object.prototype.hasOwnProperty.call(src, 'similarityMatches')) {
      out.similarityMatches = normalizeRecommendedProducts(src.similarityMatches);
    }
    return withTransitionalV2(out, src);
  }

  // Anything else (including explicit 'failed') maps to a safe failure. Only an
  // explicit image-quality signal keeps lighting/retake guidance; otherwise we
  // discard any generic backend userMessage and use the neutral message.
  return withTransitionalV2(
    failed(resolveFailedUserMessage(userMessage, hasImageQualitySignal(src))),
    src,
  );
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

  if (options.requestMode === 'selected_item' && !options.selectedCandidate) {
    return failed();
  }

  // Authenticated calls only (default stance). Short-circuit before the network.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return failed(SIGN_IN_REQUIRED_MESSAGE);
  } catch {
    return failed(SIGN_IN_REQUIRED_MESSAGE);
  }

  const legacyRequestBody: ScanIdentifyRequest = {
    imageBase64,
    source: options.source === 'upload' ? 'upload' : 'camera',
    localPrivacyFiltered: options.localPrivacyFiltered ?? false,
    clientTimestamp: new Date().toISOString(),
    ...(options.multiItemDetection ? { multiItemDetection: true } : {}),
    ...(options.requestMode ? { requestMode: options.requestMode } : {}),
    ...(options.scanSessionId ? { scanSessionId: options.scanSessionId } : {}),
    ...(options.imageDigestPrefix ? { imageDigestPrefix: options.imageDigestPrefix } : {}),
    ...(options.selectedCandidate ? { selectedCandidate: options.selectedCandidate } : {}),
    ...(options.selectionToken ? { selectionToken: options.selectionToken } : {}),
    ...(options.existingItems?.length ? { existingItems: options.existingItems } : {}),
  };

  // Phase 2B.2: a Scanner V2 envelope replaces the legacy body. The two
  // correlation fields are merged alongside it because the deployed handler
  // reads them from the top level on BOTH contract paths and hard-fails a
  // selected-item request whose image digest is absent. They are server-issued
  // values carried forward unchanged, not client-invented ones.
  const requestBody: Record<string, unknown> = options.contractRequestV2
    ? {
      ...options.contractRequestV2,
      ...(options.scanSessionId ? { scanSessionId: options.scanSessionId } : {}),
      ...(options.imageDigestPrefix ? { imageDigestPrefix: options.imageDigestPrefix } : {}),
      // Checkpoint 4.5: merged onto the V2 envelope as well as the legacy body.
      // The deployed handler reads `existingItems` from the TOP LEVEL on both
      // contract paths (`sanitizeExistingItemCandidates(body.existingItems)`),
      // and the Scanner now sends V2 — so omitting it here would leave the
      // feature wired only on a path the scanner no longer takes.
      ...(options.existingItems?.length ? { existingItems: options.existingItems } : {}),
    }
    : (legacyRequestBody as unknown as Record<string, unknown>);

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
      // A bounded contract error (HTTP 400 with a stable `error.code`) is the
      // one failure the Scanner V2 adapter must be able to branch on. Reading
      // it costs nothing on the legacy path, where 400s do not occur, and it
      // never surfaces the response body — only the enum code and the status.
      const contractError = await readContractError(error);
      const out = failed(NETWORK_MESSAGE);
      if (contractError) {
        out.httpStatus = contractError.httpStatus;
        out.contractErrorCode = contractError.code;
      }
      return out;
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
