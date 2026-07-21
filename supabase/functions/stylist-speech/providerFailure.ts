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
  | 'provider_rate_limited'
  | 'provider_concurrency_limited'
  | 'provider_invalid_request'
  | 'provider_unavailable';

export type StableSpeechErrorClass =
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMIT'
  | 'CONCURRENCY_LIMIT'
  | 'AUTHENTICATION_FAILURE'
  | 'VOICE_NOT_FOUND'
  | 'MODEL_NOT_AVAILABLE'
  | 'INVALID_REQUEST'
  | 'PROVIDER_BUSY'
  | 'PROVIDER_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'MALFORMED_AUDIO'
  | 'EMPTY_AUDIO'
  | 'UNKNOWN_PROVIDER_ERROR';

export interface ProviderFailureClassification {
  /** Raw provider HTTP status. */
  readonly providerStatus: number;
  /** App-owned category. */
  readonly category: ProviderFailureCategory;
  /** Public StylistSpeechError code (upper-snake, codebase convention). */
  readonly code: SpeechErrorCode;
  readonly stableErrorClass: StableSpeechErrorClass;
  readonly retryAfterSeconds: number | null;
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
  provider_rate_limited: 'PROVIDER_RATE_LIMIT',
  provider_concurrency_limited: 'PROVIDER_RATE_LIMIT',
  provider_invalid_request: 'PROVIDER_INVALID_REQUEST',
  provider_unavailable: 'PROVIDER_UNAVAILABLE',
};

const CATEGORY_TO_STABLE_CLASS: Record<ProviderFailureCategory, StableSpeechErrorClass> = {
  provider_auth_failed: 'AUTHENTICATION_FAILURE',
  provider_voice_unavailable: 'VOICE_NOT_FOUND',
  provider_model_unavailable: 'MODEL_NOT_AVAILABLE',
  provider_quota_exceeded: 'QUOTA_EXHAUSTED',
  provider_rate_limited: 'RATE_LIMIT',
  provider_concurrency_limited: 'CONCURRENCY_LIMIT',
  provider_invalid_request: 'INVALID_REQUEST',
  provider_unavailable: 'PROVIDER_BUSY',
};

// Public messages are fixed strings. They intentionally never interpolate any
// provider-supplied text so a raw provider body can never reach the client.
const CATEGORY_TO_MESSAGE: Record<ProviderFailureCategory, string> = {
  provider_auth_failed: 'Speech generation is unavailable.',
  provider_voice_unavailable: 'Speech generation is unavailable.',
  provider_model_unavailable: 'Speech generation is unavailable.',
  provider_quota_exceeded: 'Speech generation is temporarily limited.',
  provider_rate_limited: 'Speech generation is temporarily limited.',
  provider_concurrency_limited: 'Speech generation is temporarily limited.',
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
  provider_rate_limited: 429,
  provider_concurrency_limited: 429,
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
  if (/(concurrency|concurrent|too_many_concurrent|too_many_connections)/.test(normalized)) {
    return 'provider_concurrency_limited';
  }
  if (/(quota|credit|billing|subscription|exceeded)/.test(normalized)) return 'provider_quota_exceeded';
  if (/(rate|too_many|throttle|requests)/.test(normalized)) return 'provider_rate_limited';
  if (/(api_key|apikey|unauthor|permission|forbidden|missing_permissions|invalid_key)/.test(normalized)) {
    return 'provider_auth_failed';
  }
  return base;
}

function baseCategoryForStatus(status: number): ProviderFailureCategory {
  if (status === 401) return 'provider_auth_failed';
  if (status === 403) return 'provider_auth_failed';
  if (status === 404) return 'provider_voice_unavailable';
  if (status === 429) return 'provider_rate_limited';
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
  headers?: Headers | Record<string, string | null | undefined>,
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
  const retryAfterValue = headers instanceof Headers
    ? headers.get('Retry-After')
    : headers?.['Retry-After'] ?? headers?.['retry-after'] ?? null;
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterValue);

  return {
    providerStatus: status,
    category,
    code: CATEGORY_TO_CODE[category],
    stableErrorClass: CATEGORY_TO_STABLE_CLASS[category],
    clientStatus: CATEGORY_TO_CLIENT_STATUS[category],
    message: CATEGORY_TO_MESSAGE[category],
    isJson,
    providerErrorStatus,
    retryAfterSeconds,
    inspectedByteLength,
    totalByteLength,
  };
}

export function parseRetryAfterSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30);
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  const delta = Math.ceil((dateMs - Date.now()) / 1000);
  return delta >= 0 ? Math.min(delta, 30) : null;
}

export function shouldRetryProviderFailure(
  classification: ProviderFailureClassification,
  retryCount: number,
  remainingBudgetMs: number,
): boolean {
  if (retryCount >= 1 || remainingBudgetMs <= 0) return false;
  if (['PROVIDER_BUSY', 'PROVIDER_TIMEOUT', 'NETWORK_FAILURE'].includes(classification.stableErrorClass)) {
    return remainingBudgetMs >= 250;
  }
  if (
    (classification.stableErrorClass === 'RATE_LIMIT' ||
      classification.stableErrorClass === 'CONCURRENCY_LIMIT') &&
    classification.retryAfterSeconds != null
  ) {
    return classification.retryAfterSeconds * 1000 < remainingBudgetMs;
  }
  return false;
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
