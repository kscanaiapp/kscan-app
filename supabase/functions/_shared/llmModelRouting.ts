/**
 * Authoritative K Scan LLM model allowlist and failure classification.
 *
 * One frozen allowlist for every surface. A model identifier that is not in
 * APPROVED_MODELS is never routable, whatever its source: request body,
 * environment variable, remembered identifier, or a stale default constant.
 *
 * Accepted routing:
 *   Scanner   primary gemini-3.6-flash        fallback gemini-3.5-flash-lite
 *   TextScan  primary gemini-3.5-flash-lite   one same-model retry, no escalation
 *   Elise     primary gemini-3.6-flash        fallback gemini-3.5-flash-lite
 */

export const MODEL_FLASH = 'gemini-3.6-flash';
export const MODEL_FLASH_LITE = 'gemini-3.5-flash-lite';

/** The complete set of routable models. Nothing else may reach a provider. */
export const APPROVED_MODELS: ReadonlySet<string> = new Set<string>([
  MODEL_FLASH,
  MODEL_FLASH_LITE,
]);

export const SCANNER_PRIMARY_MODEL = MODEL_FLASH;
export const SCANNER_FALLBACK_MODEL = MODEL_FLASH_LITE;
/** TextScan stays on Lite and never escalates to Flash. */
export const TEXTSCAN_MODEL = MODEL_FLASH_LITE;
export const ELISE_PRIMARY_MODEL = MODEL_FLASH;
export const ELISE_FALLBACK_MODEL = MODEL_FLASH_LITE;

/** TextScan gets at most one additional same-model attempt. */
export const TEXTSCAN_MAX_ATTEMPTS = 2;
/** Scanner and Elise get at most one approved fallback attempt. */
export const SCANNER_MAX_ATTEMPTS = 2;

const RETIRED_PREFIXES = [
  'gemini-1.0-',
  'gemini-1.5-',
  'gemini-2.0-',
  'gemini-2.5-',
  'gemini-pro',
  'gemini-exp',
] as const;

export function isRetiredModelId(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return RETIRED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isApprovedModelId(model: string): boolean {
  return APPROVED_MODELS.has(model.trim());
}

/**
 * Resolves a candidate identifier against the allowlist, failing closed to the
 * approved default. A retired, unknown, empty or client-supplied identifier can
 * never widen routing — it can only be ignored.
 */
export function resolveAllowedModel(candidate: string | undefined | null, approvedDefault: string): string {
  if (!isApprovedModelId(approvedDefault)) {
    throw new Error(`Refusing to route: default model ${approvedDefault} is not approved.`);
  }
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (!trimmed) return approvedDefault;
  if (isRetiredModelId(trimmed)) return approvedDefault;
  if (!APPROVED_MODELS.has(trimmed)) return approvedDefault;
  return trimmed;
}

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'http_408'
  | 'http_429_transient'
  | 'http_429_quota'
  | 'http_5xx_transient'
  | 'http_unavailable'
  | 'http_deadline_exceeded'
  | 'http_client_error'
  | 'auth_error'
  | 'safety_block'
  | 'oversized_context'
  | 'invalid_model'
  | 'schema_failure'
  | 'empty_response'
  | 'malformed'
  | 'http_other';

/**
 * Failure classes that may be retried or may reach an approved fallback.
 *
 * A status code alone is never sufficient. A 429 caused by hard account quota
 * or billing exhaustion, and a 504 caused by deterministic oversized context,
 * are both permanent for this request and must not be retried.
 */
const RETRYABLE_KINDS: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'timeout',
  'network',
  'http_408',
  'http_429_transient',
  'http_5xx_transient',
  'http_unavailable',
  'http_deadline_exceeded',
]);

export function isRetryableProviderFailure(kind: ProviderFailureKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

type GeminiErrorMeta = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

const QUOTA_MARKERS = [
  'quota',
  'billing',
  'exceeded your current quota',
  'resource_exhausted',
  'insufficient',
];

const OVERSIZED_MARKERS = [
  'context length',
  'token count',
  'too large',
  'request payload size',
  'exceeds the maximum',
  'input is too long',
];

function haystack(meta: GeminiErrorMeta): string {
  return [meta.status, meta.code, meta.message]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ')
    .toLowerCase();
}

/**
 * Classifies a provider HTTP failure using status AND provider error detail, so
 * transient capacity pressure is separated from permanent quota/billing
 * exhaustion and from deterministic oversized input.
 */
export function classifyProviderHttpFailure(status: number, meta: GeminiErrorMeta = {}): ProviderFailureKind {
  const text = haystack(meta);
  const looksLikeQuota = QUOTA_MARKERS.some((m) => text.includes(m));
  const looksOversized = OVERSIZED_MARKERS.some((m) => text.includes(m));

  if (status === 400) {
    if (looksOversized) return 'oversized_context';
    if (text.includes('model') && (text.includes('not found') || text.includes('not supported'))) {
      return 'invalid_model';
    }
    return 'http_client_error';
  }
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404) return 'invalid_model';
  if (status === 408) return 'http_408';
  if (status === 429) {
    // RESOURCE_EXHAUSTED from hard project quota or billing is permanent for
    // this request; provider rate/capacity pressure is not.
    return looksLikeQuota ? 'http_429_quota' : 'http_429_transient';
  }
  if (status === 503 || text.includes('unavailable')) return 'http_unavailable';
  if (status === 504 || text.includes('deadline_exceeded')) {
    // A deadline caused by deterministic oversized input will recur.
    return looksOversized ? 'oversized_context' : 'http_deadline_exceeded';
  }
  if (status >= 500 && status <= 599) return 'http_5xx_transient';
  return 'http_other';
}

/**
 * Honors a provider Retry-After when present, otherwise applies bounded
 * exponential backoff with jitter. Never exceeds maxDelayMs.
 */
export function resolveRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  options: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const random = options.random ?? Math.random;

  if (retryAfterHeader) {
    const seconds = Number.parseInt(String(retryAfterHeader).trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, maxDelayMs);
    }
  }

  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = exponential * 0.25 * random();
  return Math.min(Math.round(exponential + jitter), maxDelayMs);
}

export type RouteSurface = 'scanner' | 'textscan' | 'elise';

export type RoutePlan = {
  surface: RouteSurface;
  primaryModel: string;
  /** Null when the surface must not escalate to a different model. */
  fallbackModel: string | null;
  maxAttempts: number;
};

/**
 * Builds the attempt plan for a surface. Environment overrides are resolved
 * through the allowlist, so an operator can only ever choose between approved
 * models — never introduce a new one.
 */
export function resolveRoutePlan(
  surface: RouteSurface,
  getEnv: (key: string) => string | undefined = () => undefined,
): RoutePlan {
  if (surface === 'textscan') {
    return {
      surface,
      // TextScan is deliberately pinned: no environment key may move it to Flash.
      primaryModel: TEXTSCAN_MODEL,
      fallbackModel: null,
      maxAttempts: TEXTSCAN_MAX_ATTEMPTS,
    };
  }
  if (surface === 'scanner') {
    return {
      surface,
      primaryModel: resolveAllowedModel(getEnv('SCAN_GEMINI_MODEL'), SCANNER_PRIMARY_MODEL),
      fallbackModel: resolveAllowedModel(
        getEnv('SCAN_GEMINI_FALLBACK_MODEL'),
        SCANNER_FALLBACK_MODEL,
      ),
      maxAttempts: SCANNER_MAX_ATTEMPTS,
    };
  }
  return {
    surface,
    primaryModel: resolveAllowedModel(getEnv('STYLECHAT_GEMINI_MODEL'), ELISE_PRIMARY_MODEL),
    fallbackModel: resolveAllowedModel(
      getEnv('STYLECHAT_GEMINI_FALLBACK_MODEL'),
      ELISE_FALLBACK_MODEL,
    ),
    maxAttempts: SCANNER_MAX_ATTEMPTS,
  };
}

/**
 * Decides the model for the next attempt, or null when the request is done.
 * TextScan repeats its own model; Scanner and Elise move to their approved
 * fallback exactly once. No surface loops and none escalates twice.
 */
export function nextAttemptModel(plan: RoutePlan, attempt: number): string | null {
  if (attempt < 1 || attempt > plan.maxAttempts) return null;
  if (attempt === 1) return plan.primaryModel;
  if (plan.fallbackModel === null) return plan.primaryModel;
  if (plan.fallbackModel === plan.primaryModel) return null;
  return plan.fallbackModel;
}
