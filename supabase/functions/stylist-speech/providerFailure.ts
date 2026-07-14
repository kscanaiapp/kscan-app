import { StylistSpeechError, type SpeechErrorCode } from './types.ts';

// The provider error body is only inspected up to this bound. Anything larger is
// truncated before parsing so a hostile or oversized provider response can never
// force unbounded work or leak beyond the inspected window.
export const PROVIDER_ERROR_INSPECTION_LIMIT_BYTES = 4_096;

// App-owned, provider-neutral failure categories. These are the only classified
// values that may appear in bounded diagnostics or drive the public error code.
export type ProviderFailureCategory =
  | 'provider_auth_failed'
  | 'provider_voice_unavailable'
  | 'provider_model_unavailable'
  | 'provider_quota_exceeded'
  | 'provider_invalid_request'
  | 'provider_unavailable';

export interface ProviderFailureClassification {
  /** Raw provider HTTP status. */
  readonly providerStatus: number;
  /** App-owned category. */
  readonly category: ProviderFailureCategory;
  /** Public StylistSpeechError code (upper-snake, codebase convention). */
  readonly code: SpeechErrorCode;
  /** HTTP status returned to the client. */
  readonly clientStatus: number;
  /** Fixed, provider-neutral public message. Never derived from provider text. */
  readonly message: string;
  /** Whether the (bounded) provider body parsed as JSON. */
  readonly isJson: boolean;
  /**
   * A sanitized provider error status/type token (e.g. `invalid_api_key`,
   * `voice_not_found`) when the provider supplied one and it is safe to retain.
   * Never a free-text message, key, or voice ID.
   */
  readonly providerErrorStatus: string | null;
  /** Byte length of the provider body actually inspected (<= limit). */
  readonly inspectedByteLength: number;
  /** Total byte length reported by the provider body. */
  readonly totalByteLength: number;
}

const CATEGORY_TO_CODE: Record<ProviderFailureCategory, SpeechErrorCode> = {
  provider_auth_failed: 'PROVIDER_AUTH_FAILED',
  provider_voice_unavailable: 'PROVIDER_VOICE_UNAVAILABLE',
  provider_model_unavailable: 'PROVIDER_MODEL_UNAVAILABLE',
  provider_quota_exceeded: 'PROVIDER_QUOTA_EXCEEDED',
  provider_invalid_request: 'PROVIDER_INVALID_REQUEST',
  provider_unavailable: 'PROVIDER_UNAVAILABLE',
};

// Public messages are fixed strings. They intentionally never interpolate any
// provider-supplied text so a raw provider body can never reach the client.
const CATEGORY_TO_MESSAGE: Record<ProviderFailureCategory, string> = {
  provider_auth_failed: 'Speech generation is unavailable.',
  provider_voice_unavailable: 'Speech generation is unavailable.',
  provider_model_unavailable: 'Speech generation is unavailable.',
  provider_quota_exceeded: 'Speech generation is temporarily limited.',
  provider_invalid_request: 'Speech generation is unavailable.',
  provider_unavailable: 'Speech generation is unavailable.',
};

// The client HTTP status is preserved as a sanitized 502 for every provider
// rejection except quota/rate limiting, which maps to 429 so the client can
// back off. The specific cause lives only in the app-owned category/diagnostics.
const CATEGORY_TO_CLIENT_STATUS: Record<ProviderFailureCategory, number> = {
  provider_auth_failed: 502,
  provider_voice_unavailable: 502,
  provider_model_unavailable: 502,
  provider_quota_exceeded: 429,
  provider_invalid_request: 502,
  provider_unavailable: 502,
};

const SAFE_STATUS_TOKEN = /^[A-Za-z0-9_.\-]{1,64}$/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Truncate a string to at most `limitBytes` UTF-8 bytes without splitting a
 * multi-byte code point.
 */
function truncateToBytes(value: string, limitBytes: number): string {
  if (byteLength(value) <= limitBytes) return value;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const slice = encoder.encode(value).slice(0, limitBytes);
  return decoder.decode(slice);
}

/**
 * Extract a safe provider status/type token from a parsed provider error body.
 * Only short, token-shaped values are retained; anything that looks like free
 * text, a key, a voice ID, or a message is dropped. Returns null when nothing
 * safe is available.
 */
function extractProviderErrorStatus(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  const candidates: unknown[] = [];
  const detail = record.detail;
  if (detail && typeof detail === 'object') {
    const detailRecord = detail as Record<string, unknown>;
    candidates.push(detailRecord.status, detailRecord.code, detailRecord.type);
  } else if (typeof detail === 'string') {
    candidates.push(detail);
  }
  candidates.push(record.status, record.code, record.type, record.error);

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && SAFE_STATUS_TOKEN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function refineByToken(
  base: ProviderFailureCategory,
  token: string | null,
): ProviderFailureCategory {
  if (!token) return base;
  const normalized = token.toLowerCase();
  if (/(voice)/.test(normalized)) return 'provider_voice_unavailable';
  if (/(model)/.test(normalized)) return 'provider_model_unavailable';
  if (/(quota|exceeded|too_many|rate)/.test(normalized)) return 'provider_quota_exceeded';
  if (/(api_key|apikey|unauthor|permission|forbidden|missing_permissions|invalid_key)/.test(normalized)) {
    return 'provider_auth_failed';
  }
  return base;
}

function baseCategoryForStatus(status: number): ProviderFailureCategory {
  if (status === 401) return 'provider_auth_failed';
  if (status === 403) return 'provider_auth_failed';
  if (status === 404) return 'provider_voice_unavailable';
  if (status === 429) return 'provider_quota_exceeded';
  if (status === 400 || status === 422) return 'provider_invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_unavailable';
}

/**
 * Classify a provider failure from its HTTP status and (bounded) response body.
 * The body is inspected only up to PROVIDER_ERROR_INSPECTION_LIMIT_BYTES and is
 * never surfaced publicly; only a short, sanitized status token may be retained.
 */
export function classifyProviderFailure(
  status: number,
  rawBody: string,
): ProviderFailureClassification {
  const totalByteLength = byteLength(rawBody);
  const inspected = truncateToBytes(rawBody, PROVIDER_ERROR_INSPECTION_LIMIT_BYTES);
  const inspectedByteLength = byteLength(inspected);

  let isJson = false;
  let providerErrorStatus: string | null = null;
  try {
    const parsed = JSON.parse(inspected);
    isJson = true;
    providerErrorStatus = extractProviderErrorStatus(parsed);
  } catch {
    isJson = false;
    providerErrorStatus = null;
  }

  const category = refineByToken(baseCategoryForStatus(status), providerErrorStatus);

  return {
    providerStatus: status,
    category,
    code: CATEGORY_TO_CODE[category],
    clientStatus: CATEGORY_TO_CLIENT_STATUS[category],
    message: CATEGORY_TO_MESSAGE[category],
    isJson,
    providerErrorStatus,
    inspectedByteLength,
    totalByteLength,
  };
}

/** Build the sanitized public error for a classified provider failure. */
export function providerFailureError(
  classification: ProviderFailureClassification,
): StylistSpeechError {
  return new StylistSpeechError(
    classification.clientStatus,
    classification.code,
    classification.message,
  );
}
