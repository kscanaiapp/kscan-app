// Provider invocation hardening: bounded timeouts, caller-cancellation-aware
// fetching, typed HTTP classification, capped exponential backoff with jitter,
// bounded retries, fan-out limits, and provider-neutral public errors.
//
// Nothing in this module ever puts a provider name, URL, or raw response body
// into a value intended for the client — that data is confined to `logDetail`
// fields meant for security/logging.ts, never to a Response body.

export class ProviderTimeoutError extends Error {
  constructor(message = 'Provider request timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

// Raised when the *incoming* K Scan request was cancelled by its caller (client
// disconnect / navigation away) rather than the provider being slow. Must not be
// reported as a provider failure or counted toward provider-failure ratios.
export class CallerCancelledError extends Error {
  constructor(message = 'Request cancelled by caller') {
    super(message);
    this.name = 'CallerCancelledError';
  }
}

export type ProviderErrorKind = 'rate_limited' | 'server_error' | 'client_error';

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly kind: ProviderErrorKind;

  constructor(status: number, kind: ProviderErrorKind) {
    super(`Provider returned ${status}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.kind = kind;
  }
}

// Classifies a provider HTTP status without exposing it to the client. 429 is
// distinguished from generic 5xx because callers may want different backoff
// treatment (e.g. respecting a provider Retry-After) even though both are retryable.
export function classifyProviderStatus(status: number): ProviderErrorKind | 'ok' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status < 600) return 'server_error';
  return 'client_error';
}

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs: number;
  // The Edge Function's own request signal (e.g. derived from the inbound
  // Request), so a caller disconnect aborts the outbound provider call too
  // instead of leaking an in-flight fetch past the client's interest in it.
  callerSignal?: AbortSignal;
}

// Fetches with a bounded timeout, propagating caller cancellation distinctly
// from a timeout, and classifying non-2xx responses as a typed ProviderHttpError
// instead of returning a Response the caller has to remember to check.
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions): Promise<Response> {
  const { timeoutMs, callerSignal, ...init } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const kind = classifyProviderStatus(response.status);
      throw new ProviderHttpError(response.status, kind === 'ok' ? 'server_error' : kind);
    }
    return response;
  } catch (err) {
    if (err instanceof ProviderHttpError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (callerSignal?.aborted && !timedOut) throw new CallerCancelledError();
      throw new ProviderTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

export interface RetryOptions {
  // Total attempts including the first — e.g. 2 means one retry. Keep this low;
  // provider fan-out must stay bounded, not scale with client-perceived flakiness.
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  // Injectable for tests; defaults to a real timer-based sleep.
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 4_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_RETRYABLE = (error: unknown): boolean => {
  if (error instanceof ProviderTimeoutError) return true;
  if (error instanceof ProviderHttpError) return error.kind === 'rate_limited' || error.kind === 'server_error';
  return false;
};

// Capped exponential backoff (base * 2^(attempt-1), clamped to maxDelayMs) with
// full jitter — the delay is drawn uniformly from [0, cap] rather than a fixed
// value, so many concurrently-throttled clients don't retry in lockstep.
export function computeBackoffDelayMs(
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const cap = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * cap);
}

export async function withBoundedRetries<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? DEFAULT_RETRYABLE;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Caller cancellation is never retryable — retrying it would keep doing
      // provider work the client already walked away from.
      if (err instanceof CallerCancelledError) throw err;

      const isLastAttempt = attempt === options.maxAttempts;
      if (isLastAttempt || !isRetryable(err)) throw err;

      const delayMs = computeBackoffDelayMs(attempt, options);
      options.onRetry?.(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }

  // Unreachable given maxAttempts >= 1, but keeps the type checker satisfied.
  throw lastError;
}

export interface NormalizedProviderError {
  category: 'provider_unavailable';
  // Safe to return to the client as-is: provider-neutral, no provider name,
  // no status code, no internal detail.
  publicMessage: string;
  // Safe for security/logging.ts only — never put this in a Response body.
  logDetail: string;
}

const PUBLIC_PROVIDER_UNAVAILABLE_MESSAGE =
  'This feature is temporarily unavailable. Please try again shortly.';

// Converts a raw provider failure into a provider-neutral public message plus a
// separate, richer detail string intended for server-side logs only. Retailer
// neutrality requires that no response body ever names which provider was used.
export function normalizeProviderError(context: {
  providerName: string;
  error: unknown;
}): NormalizedProviderError {
  const { providerName, error } = context;

  let logDetail: string;
  if (error instanceof CallerCancelledError) {
    logDetail = `${providerName} call cancelled by caller`;
  } else if (error instanceof ProviderTimeoutError) {
    logDetail = `${providerName} timed out`;
  } else if (error instanceof ProviderHttpError) {
    logDetail = `${providerName} returned ${error.kind} (status ${error.status})`;
  } else {
    logDetail = `${providerName} failed with an unexpected error`;
  }

  return { category: 'provider_unavailable', publicMessage: PUBLIC_PROVIDER_UNAVAILABLE_MESSAGE, logDetail };
}

// A conservative default cap on how many distinct provider calls a single
// request may fan out to (e.g. multi-retailer search).
export const DEFAULT_MAX_PROVIDER_FANOUT = 4;

export interface FanoutLimitResult<T> {
  allowed: T[];
  truncated: boolean;
  droppedCount: number;
}

// Enforces the fan-out cap on a candidate list before issuing parallel provider
// calls. Never throws — truncates and reports so the caller can log/decide.
export function enforceProviderFanoutLimit<T>(
  candidates: readonly T[],
  max: number = DEFAULT_MAX_PROVIDER_FANOUT,
): FanoutLimitResult<T> {
  if (candidates.length <= max) {
    return { allowed: [...candidates], truncated: false, droppedCount: 0 };
  }
  return {
    allowed: candidates.slice(0, max),
    truncated: true,
    droppedCount: candidates.length - max,
  };
}
