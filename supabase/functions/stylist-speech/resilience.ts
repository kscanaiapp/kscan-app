import { StylistSpeechError } from './types.ts';

export type SpeechRetryClass =
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

export interface SpeechCircuitState {
  failures: number;
  openedUntilMs: number;
}

export class SpeechCircuitBreaker {
  private readonly stateByProvider = new Map<string, SpeechCircuitState>();

  canAttempt(provider: string, nowMs = Date.now()): boolean {
    const state = this.stateByProvider.get(provider);
    return !state || state.openedUntilMs <= nowMs;
  }

  recordSuccess(provider: string): void {
    this.stateByProvider.delete(provider);
  }

  recordFailure(provider: string, nowMs = Date.now(), cooldownMs = 60_000): void {
    const prior = this.stateByProvider.get(provider) ?? { failures: 0, openedUntilMs: 0 };
    const failures = prior.failures + 1;
    this.stateByProvider.set(provider, {
      failures,
      openedUntilMs: failures >= 3 ? nowMs + cooldownMs : 0,
    });
  }

  resetForTests(): void {
    this.stateByProvider.clear();
  }
}

export function stableClassForSpeechError(error: unknown): SpeechRetryClass {
  if (!(error instanceof StylistSpeechError)) return 'UNKNOWN_PROVIDER_ERROR';
  if (error.code === 'PROVIDER_TIMEOUT') return 'PROVIDER_TIMEOUT';
  if (error.code === 'PROVIDER_RATE_LIMIT') return 'RATE_LIMIT';
  if (error.code === 'PROVIDER_QUOTA_EXCEEDED') return 'QUOTA_EXHAUSTED';
  if (error.code === 'PROVIDER_AUTH_FAILED') return 'AUTHENTICATION_FAILURE';
  if (error.code === 'PROVIDER_VOICE_UNAVAILABLE') return 'VOICE_NOT_FOUND';
  if (error.code === 'PROVIDER_MODEL_UNAVAILABLE') return 'MODEL_NOT_AVAILABLE';
  if (error.code === 'PROVIDER_INVALID_REQUEST') return 'INVALID_REQUEST';
  if (error.code === 'PROVIDER_RESPONSE_INVALID') return 'MALFORMED_AUDIO';
  if (error.code === 'PROVIDER_UNAVAILABLE') return 'PROVIDER_BUSY';
  return 'UNKNOWN_PROVIDER_ERROR';
}

export function shouldRetrySpeechError(input: {
  error: unknown;
  retryCount: number;
  retryAfterSeconds?: number | null;
  remainingBudgetMs: number;
}): boolean {
  if (input.retryCount >= 1 || input.remainingBudgetMs <= 250) return false;
  const stableClass = stableClassForSpeechError(input.error);
  if (
    stableClass === 'QUOTA_EXHAUSTED' ||
    stableClass === 'AUTHENTICATION_FAILURE' ||
    stableClass === 'VOICE_NOT_FOUND' ||
    stableClass === 'MODEL_NOT_AVAILABLE' ||
    stableClass === 'INVALID_REQUEST'
  ) return false;
  if (
    stableClass === 'RATE_LIMIT' ||
    stableClass === 'CONCURRENCY_LIMIT'
  ) {
    return input.retryAfterSeconds != null &&
      input.retryAfterSeconds * 1000 < input.remainingBudgetMs;
  }
  return stableClass === 'PROVIDER_BUSY' ||
    stableClass === 'PROVIDER_TIMEOUT' ||
    stableClass === 'NETWORK_FAILURE';
}

/**
 * Only provider-infrastructure failures advance the shared circuit breaker.
 * Actor-local / request-shape errors must never disable speech globally.
 */
export function shouldRecordSpeechCircuitFailure(error: unknown): boolean {
  const stableClass = stableClassForSpeechError(error);
  return (
    stableClass === 'PROVIDER_BUSY' ||
    stableClass === 'PROVIDER_TIMEOUT' ||
    stableClass === 'NETWORK_FAILURE' ||
    stableClass === 'RATE_LIMIT' ||
    stableClass === 'CONCURRENCY_LIMIT' ||
    stableClass === 'QUOTA_EXHAUSTED' ||
    stableClass === 'UNKNOWN_PROVIDER_ERROR'
  );
}
